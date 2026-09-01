import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
    enum TurnPhase: Equatable {
        case idle
        /// The turn has been posted; nothing has come back yet.
        case submitted
        case streaming
    }

    /// Whether the box answered last time we asked. A swallowed failure is the
    /// blank screen: a stale "up" status behind a webview that never loaded,
    /// with nothing on screen saying so and no way to try again.
    enum Reachability: Equatable {
        case unknown
        case ok
        case down(message: String, retryable: Bool)

        var failure: (message: String, retryable: Bool)? {
            guard case .down(let message, let retryable) = self else { return nil }
            return (message, retryable)
        }
    }

    struct SeatFailure: Equatable {
        /// The seat state that was asked for, so a retry asks for the same one.
        let present: Bool
        let message: String
    }

    @Published var session: Session?
    @Published var transcript = AgentTranscript()
    @Published var phase: TurnPhase = .idle
    @Published var restoring = false
    @Published var turnError: String?
    @Published var status: ComputerV1.BoxStatus?
    @Published var waiting = false
    @Published var pairError: String?
    /// A seat change that did not happen, kept so the takeover screen can say
    /// so and repeat it. `pairError` is the pairing screen's and is never seen
    /// from here — a silent hand-back leaves the operator believing an agent
    /// has control of a machine they are still holding.
    @Published var seatFailure: SeatFailure?
    @Published var busy = false
    @Published private(set) var reach: Reachability = .unknown
    /// Bumped by `retry()` to make the desktop webview load again.
    @Published private(set) var vncReload = 0
    /// Which Bot's screen the phone is on. Nil = primary (single-screen hub).
    @Published var selectedScreen: ComputerV1.ScreenStatus?

    var screens: [ComputerV1.ScreenStatus] { status?.screens ?? [] }
    var currentScreen: ComputerV1.ScreenStatus? {
        selectedScreen ?? screens.first(where: { $0.display == 1 }) ?? screens.first
    }

    let store = KeychainStore()
    var client: ComputerClient? {
        guard let session else { return nil }
        return ComputerClient(baseURL: session.baseURL, token: session.token)
    }

    /// The agent, reached through the paired hub's `/eve/v1` proxy on the same
    /// origin and the same seat token as the pixels.
    var agent: (any EveTransport)? {
        guard let session else { return nil }
        return EveClient(baseURL: session.baseURL, token: session.token)
    }

    // MARK: Conversation state

    private(set) var cursor = EveSessionCursor.initial
    private var turnTask: Task<Void, Never>?
    private var restoreTask: Task<Void, Never>?

    var messages: [AgentChatMessage] { transcript.messages }
    var pendingInputRequests: [EveInputRequest] { transcript.pendingInputRequests }
    var isBusy: Bool { phase != .idle }

    /// True once a turn is in flight but before the agent has shown anything —
    /// its first token, tool call or screenshot.
    var isThinking: Bool {
        guard isBusy else { return false }
        guard let last = messages.last else { return true }
        return last.role == .user || !last.hasVisibleContent
    }

    // MARK: Pairing

    func restore() {
        session = store.load()
        cursor = EveCursorStore.load()
        guard session != nil else { return }
        Task { await refreshStatus() }
        restoreConversation()
    }

    func pair(host: String, code: String) async {
        busy = true
        pairError = nil
        defer { busy = false }
        do {
            let url = try PairURL.parseHost(host)
            let client = ComputerClient(baseURL: url, token: nil)
            let res = try await client.pair(code: code)
            let session = Session(baseURL: url, token: res.token)
            store.save(session)
            self.session = session
            self.status = res.status
            waiting = res.status.state == .waiting
        } catch {
            pairError = error.localizedDescription
        }
    }

    func unpair() {
        cancelWork()
        store.clear()
        EveCursorStore.clear()
        session = nil
        transcript = AgentTranscript()
        cursor = .initial
        phase = .idle
        turnError = nil
        status = nil
        waiting = false
        seatFailure = nil
        reach = .unknown
    }

    func refreshStatus() async {
        guard let client else { return }
        do {
            let s = try await client.status(display: selectedScreen?.display)
            status = s
            // Keep the selection pinned to the same Bot across refreshes.
            if let sel = selectedScreen {
                selectedScreen = s.screens.first(where: { $0.botId == sel.botId })
            }
            waiting = (currentScreen?.state ?? s.state) == .waiting
            reach = .ok
        } catch {
            // Keep the last known status, but stop pretending it is current.
            reach = .down(message: error.localizedDescription, retryable: ClientError.retryable(error))
        }
    }

    /// The desktop webview could not load, or its renderer died. Either way the
    /// pixels are gone, and only saying so tells it apart from a black desktop.
    func reportDesktopFailure(_ message: String) {
        reach = .down(message: message, retryable: true)
    }

    func retry() async {
        reach = .unknown
        vncReload += 1
        await refreshStatus()
    }

    func selectScreen(_ screen: ComputerV1.ScreenStatus) {
        selectedScreen = screen
        waiting = screen.state == .waiting
    }

    /// Provision a Bot on the fly. The hub allocates the screen and mints
    /// the token; it is returned exactly once for the caller to show.
    func createBot(id: String) async throws -> ComputerV1.BotCredentials {
        guard let client else { throw URLError(.userAuthenticationRequired) }
        let creds = try await client.createBot(id: id)
        await refreshStatus()
        return creds
    }

    /// Take the seat without waiting to be asked. The agent's next call gets
    /// SEAT_HELD, which it already knows how to wait on — you should not have
    /// to watch a machine go wrong and wait for permission to stop it.
    func takeSeat() async {
        await setSeat(present: true)
    }

    /// Returns whether the agent actually has the seat back. The caller closes
    /// the takeover screen only on true.
    @discardableResult
    func imDone() async -> Bool {
        await setSeat(present: false)
    }

    func retrySeatChange() async {
        guard let failure = seatFailure else { return }
        await setSeat(present: failure.present)
    }

    @discardableResult
    private func setSeat(present: Bool) async -> Bool {
        guard let client else {
            seatFailure = SeatFailure(present: present, message: "Not paired to a box.")
            return false
        }
        seatFailure = nil
        do {
            status = try await client.setPresence(present: present, display: selectedScreen?.display)
            waiting = false
            return true
        } catch {
            seatFailure = SeatFailure(present: present, message: error.localizedDescription)
            return false
        }
    }

    // MARK: Chat

    /// False when nothing was dispatched, so the composer keeps the typed text.
    /// A send that silently eats the draft is the worst of both: no message and
    /// no way back to what was written.
    @discardableResult
    func send(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard !isBusy else {
            turnError = "The agent is still on the last turn. Your message was not sent."
            return false
        }
        guard agent != nil else {
            turnError = "Not paired to a box. Your message was not sent."
            return false
        }
        transcript.appendOptimisticUserMessage(trimmed)
        runTurn(message: trimmed, inputResponses: [])
        return true
    }

    /// Answers a parked human-in-the-loop request, resuming the turn that asked.
    func answer(_ response: EveInputResponse) {
        guard !isBusy, agent != nil else { return }
        transcript.clearPendingInputRequests()
        runTurn(message: nil, inputResponses: [response])
    }

    /// Stops reading the stream and asks the agent to stop the turn. The session
    /// itself stays: the next message continues the same conversation.
    func stop() {
        turnTask?.cancel()
        turnTask = nil
        phase = .idle
        guard let agent, let sessionId = cursor.sessionId else { return }
        Task {
            try? await agent.cancel(sessionId: sessionId)
            // The cancel lands on the stream as turn.cancelled + session.waiting;
            // the next turn reads those from the cursor rather than skipping them.
            await self.refreshStatus()
        }
    }

    /// Rebuilds the transcript from the durable stream so a relaunch lands back
    /// in the same conversation.
    private func restoreConversation() {
        guard let agent, let sessionId = cursor.sessionId else { return }
        restoring = true
        restoreTask = Task {
            defer { self.restoring = false }
            guard let events = try? await agent.replayEvents(sessionId: sessionId),
                  !Task.isCancelled else { return }
            var restored = AgentTranscript()
            for event in events { restored.apply(event) }
            self.transcript = restored
            self.cursor.streamIndex = events.count
            EveCursorStore.save(self.cursor)
        }
    }

    private func runTurn(message: String?, inputResponses: [EveInputResponse]) {
        guard let agent else { return }
        turnError = nil
        phase = .submitted
        let startCursor = cursor
        turnTask = Task {
            // Overlap the stream open with the send when continuing a session:
            // the connection is established (and buffering) while the POST is in
            // flight, which is most of the wait before the first token. A brand
            // new session has no id to open yet, so it stays sequential.
            var preopened: AsyncThrowingStream<EveStreamEvent, Error>?
            if let sessionId = startCursor.sessionId {
                preopened = agent.streamTurn(sessionId: sessionId, startIndex: startCursor.streamIndex)
            }
            do {
                let ack = try await agent.sendTurn(
                    message: message,
                    inputResponses: inputResponses,
                    cursor: startCursor
                )
                if Task.isCancelled { return }
                self.cursor.sessionId = ack.sessionId
                self.phase = .streaming

                var index = startCursor.streamIndex
                let stream: AsyncThrowingStream<EveStreamEvent, Error>
                if startCursor.sessionId == ack.sessionId, let preopened {
                    stream = preopened
                } else {
                    // A different session than the one optimistically opened:
                    // drop that stream (releasing it cancels it) and start over.
                    preopened = nil
                    index = 0
                    stream = agent.streamTurn(sessionId: ack.sessionId, startIndex: 0)
                }

                var boundary: EveStreamEvent?
                for try await event in stream {
                    if Task.isCancelled { return }
                    index += 1
                    // Advanced per event, not per turn, so a stop mid-turn still
                    // leaves an accurate resume point behind.
                    self.cursor.streamIndex = index
                    self.transcript.apply(event)
                    if case .actionResult = event {
                        // The computer tool can hand the seat back mid-turn; the
                        // banner comes from the hub's seat state, not the stream.
                        Task { await self.refreshStatus() }
                    }
                    if event.isTurnBoundary { boundary = event }
                }
                if Task.isCancelled { return }
                self.finishTurn(sessionId: ack.sessionId, boundary: boundary)
            } catch {
                if Task.isCancelled { return }
                self.phase = .idle
                self.turnError = error.localizedDescription
            }
            await self.refreshStatus()
        }
    }

    private func finishTurn(sessionId: String, boundary: EveStreamEvent?) {
        if boundary == .sessionWaiting {
            // Parked: the next message continues this session from here.
            cursor.sessionId = sessionId
        } else {
            // Completed or failed terminally — a reset id never revives, so the
            // next message has to start a fresh session.
            cursor = .initial
        }
        EveCursorStore.save(cursor)
        phase = .idle
        if let failure = transcript.failureMessage {
            turnError = failure
        }
    }

    private func cancelWork() {
        turnTask?.cancel()
        turnTask = nil
        restoreTask?.cancel()
        restoreTask = nil
    }
}

/// The conversation cursor, kept beside the paired session so a relaunch can
/// replay it. Not a credential — the seat token in the Keychain is what makes it
/// usable — so it lives in defaults.
enum EveCursorStore {
    private static let sessionKey = "eve.sessionId"
    private static let indexKey = "eve.streamIndex"

    static func load(_ defaults: UserDefaults = .standard) -> EveSessionCursor {
        guard let sessionId = defaults.string(forKey: sessionKey) else { return .initial }
        return EveSessionCursor(sessionId: sessionId, streamIndex: defaults.integer(forKey: indexKey))
    }

    static func save(_ cursor: EveSessionCursor, to defaults: UserDefaults = .standard) {
        guard let sessionId = cursor.sessionId else {
            clear(defaults)
            return
        }
        defaults.set(sessionId, forKey: sessionKey)
        defaults.set(cursor.streamIndex, forKey: indexKey)
    }

    static func clear(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: sessionKey)
        defaults.removeObject(forKey: indexKey)
    }
}

enum PairURL {
    static func parseHost(_ raw: String) throws -> URL {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("computer://pair") {
            let c = URLComponents(string: s)
            if let host = c?.queryItems?.first(where: { $0.name == "host" })?.value {
                s = host
            }
        }
        if !s.contains("://") { s = "https://\(s)" }
        guard let url = URL(string: s), url.host != nil else {
            throw URLError(.badURL)
        }
        return url
    }

    static func parsePairQR(_ raw: String) -> (host: String, code: String?) {
        if raw.hasPrefix("computer://pair"), let c = URLComponents(string: raw) {
            let host = c.queryItems?.first(where: { $0.name == "host" })?.value ?? ""
            let code = c.queryItems?.first(where: { $0.name == "code" })?.value
            return (host, code)
        }
        return (raw, nil)
    }
}

struct Session: Codable, Equatable {
    var baseURL: URL
    var token: String
}
