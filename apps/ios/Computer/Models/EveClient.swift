import Foundation

// MARK: - Session cursor

/// Where the phone is in an Eve session: which durable session, and how many of
/// its events have already been consumed. `streamIndex` is an absolute event
/// count, which is exactly what `?startIndex=` takes, so a dropped connection
/// resumes without replaying tokens the transcript already shows.
///
/// There is deliberately no continuation token here. Eve's ID-addressed session
/// API neither accepts nor needs one; the `sessionId` is the whole handle.
struct EveSessionCursor: Codable, Equatable, Sendable {
    var sessionId: String?
    var streamIndex: Int

    static let initial = EveSessionCursor(sessionId: nil, streamIndex: 0)
}

// MARK: - Human-in-the-loop input

/// One answer the agent offers. `style` is Eve's own marking of the dangerous
/// choice — never infer it from the id, because on a `session-limit` request the
/// destructive answer is the opposite one from a `tool-approval`.
struct EveInputOption: Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let detail: String?
    let style: String?
}

/// The tool call an approval is about. Eve puts it on the request itself, so the
/// card can say what is about to run without correlating against the transcript.
struct EveInputAction: Equatable, Sendable {
    let callId: String
    let toolName: String
    let input: [String: EveToolArgument]
}

struct EveInputRequest: Equatable, Sendable, Identifiable {
    /// `tool-approval`, `question` or `session-limit`. The three arrive on one
    /// protocol and are only told apart here.
    let kind: String
    let requestId: String
    let prompt: String
    let allowFreeform: Bool
    let options: [EveInputOption]
    /// Present on a tool approval; absent on a question or a session limit.
    let action: EveInputAction?

    var id: String { requestId }

    init(
        requestId: String,
        prompt: String,
        kind: String = "question",
        allowFreeform: Bool = false,
        options: [EveInputOption] = [],
        action: EveInputAction? = nil
    ) {
        self.requestId = requestId
        self.prompt = prompt
        self.kind = kind
        self.allowFreeform = allowFreeform
        self.options = options
        self.action = action
    }
}

struct EveInputResponse: Equatable, Sendable {
    let requestId: String
    var optionId: String?
    var text: String?
}

// MARK: - Actions

/// One argument of a requested action, narrowed to the kinds a step label can
/// render. Nested objects, booleans and null are dropped rather than modelled:
/// nothing on this screen reads them.
enum EveToolArgument: Equatable, Sendable {
    case number(Double)
    case string(String)
    /// A flat list, so `shell(argv:)` and `computer(actions:)` — the two calls
    /// this agent makes most — can still say what they are about to do.
    case list([String])

    init?(json value: Any) {
        if let string = value as? String {
            self = .string(string)
        } else if let array = value as? [Any] {
            let items = array.compactMap(Self.label(ofElement:))
            guard !items.isEmpty else { return nil }
            self = .list(items)
        } else if let number = value as? NSNumber,
                  // JSONSerialization decodes JSON booleans as NSNumber, which
                  // would otherwise pass the cast and render as "1".
                  CFGetTypeID(number) != CFBooleanGetTypeID() {
            self = .number(number.doubleValue)
        } else {
            return nil
        }
    }

    /// An array element as one word: a string stands for itself, and an action
    /// object is named by its `type` (`{"type":"click",…}` → "click").
    private static func label(ofElement value: Any) -> String? {
        if let string = value as? String { return string }
        if let object = value as? [String: Any] { return object["type"] as? String }
        return nil
    }

    private static let maxListItems = 3

    var text: String {
        switch self {
        case .number(let value):
            // JavaScript's String(value) prints an integral number without a
            // decimal point, so `display: 2` reads "2".
            return value.rounded() == value && value.magnitude < 1e15
                ? String(Int64(value))
                : String(value)
        case .string(let string):
            return string
        case .list(let items):
            let head = items.prefix(Self.maxListItems).joined(separator: " ")
            return items.count > Self.maxListItems ? "\(head)…" : head
        }
    }
}

/// One model-requested action (`tool-call`, `subagent-call`, `load-skill`, …).
struct EveActionRequest: Equatable, Sendable {
    let callId: String
    let kind: String
    /// Resolved display name (tool name, subagent name, or the kind itself).
    let name: String
    /// The call's arguments. Two calls to one tool in a turn differ only here,
    /// so the step label needs them to tell the rows apart.
    var input: [String: EveToolArgument] = [:]
}

// MARK: - Files

/// A renderable file on a message or a tool result.
///
/// A user attachment arrives as a URL; the computer tool's screenshots arrive as
/// base64 inside the tool result, so both shapes live here and whichever one is
/// present is the one the view uses.
struct EveFile: Equatable, Sendable {
    var filename: String?
    var mediaType: String
    var sizeBytes: Int?
    var url: String?
    var bytes: Data?

    init(
        filename: String? = nil,
        mediaType: String,
        sizeBytes: Int? = nil,
        url: String? = nil,
        bytes: Data? = nil
    ) {
        self.filename = filename
        self.mediaType = mediaType
        self.sizeBytes = sizeBytes
        self.url = url
        self.bytes = bytes
    }

    var isImage: Bool { mediaType.hasPrefix("image/") }
}

// MARK: - Stream events

/// Typed projection of Eve's NDJSON stream events. Unknown or unused types
/// decode as `.other` so a newer agent never breaks the phone.
enum EveStreamEvent: Equatable, Sendable {
    case sessionStarted
    case turnStarted(turnId: String)
    case messageReceived(turnId: String, sequence: Int, message: String, files: [EveFile])
    case messageAppended(turnId: String, stepIndex: Int, messageSoFar: String)
    case messageCompleted(turnId: String, stepIndex: Int, message: String?, finishReason: String)
    case actionsRequested(turnId: String, stepIndex: Int, actions: [EveActionRequest])
    case actionResult(turnId: String, callId: String?, status: String, errorMessage: String?, files: [EveFile])
    case inputRequested(turnId: String, requests: [EveInputRequest])
    case turnCompleted(turnId: String)
    case turnFailed(turnId: String, code: String, message: String)
    case stepFailed(turnId: String, code: String, message: String)
    case sessionWaiting
    case sessionCompleted
    case sessionFailed(code: String, message: String)
    case other(type: String)

    /// The events that end the current turn's stream read
    /// (Eve's `isCurrentTurnBoundaryEvent`).
    var isTurnBoundary: Bool {
        switch self {
        case .sessionWaiting, .sessionCompleted, .sessionFailed: return true
        default: return false
        }
    }
}

// MARK: - NDJSON parsing

enum EveStreamEventParser {
    /// Parses one NDJSON line into a typed event. Throws on malformed JSON;
    /// unknown event types are tolerated as `.other`.
    nonisolated static func parse(line: String) throws -> EveStreamEvent {
        guard let data = line.data(using: .utf8) else {
            throw EveError.malformedEvent(line)
        }
        let json = try JSONSerialization.jsonObject(with: data)
        guard let object = json as? [String: Any], let type = object["type"] as? String else {
            throw EveError.malformedEvent(line)
        }
        return parse(type: type, data: object["data"] as? [String: Any] ?? [:])
    }

    nonisolated private static func parse(type: String, data: [String: Any]) -> EveStreamEvent {
        let turnId = data["turnId"] as? String ?? ""
        let stepIndex = intValue(data["stepIndex"]) ?? 0
        switch type {
        case "session.started":
            return .sessionStarted
        case "turn.started":
            return .turnStarted(turnId: turnId)
        case "message.received":
            // `message` is the flattened text summary; `parts` is where
            // attachments live. File parts never carry raw bytes.
            let parts = data["parts"] as? [[String: Any]] ?? []
            return .messageReceived(
                turnId: turnId,
                // The event's own position in the turn, so the id this becomes
                // is the same on a live read and on a replay from index 0.
                sequence: intValue(data["sequence"]) ?? 0,
                message: data["message"] as? String ?? "",
                files: parts.compactMap(parseMessageFile)
            )
        case "message.appended":
            // Cumulative, not a delta: the reducer upserts, never concatenates.
            return .messageAppended(
                turnId: turnId,
                stepIndex: stepIndex,
                messageSoFar: data["messageSoFar"] as? String ?? ""
            )
        case "message.completed":
            return .messageCompleted(
                turnId: turnId,
                stepIndex: stepIndex,
                message: data["message"] as? String,
                finishReason: data["finishReason"] as? String ?? "stop"
            )
        case "actions.requested":
            let rawActions = data["actions"] as? [[String: Any]] ?? []
            return .actionsRequested(
                turnId: turnId,
                stepIndex: stepIndex,
                actions: rawActions.compactMap(parseAction)
            )
        case "action.result":
            let result = data["result"] as? [String: Any]
            let error = data["error"] as? [String: Any]
            return .actionResult(
                turnId: turnId,
                callId: result?["callId"] as? String,
                status: data["status"] as? String ?? "completed",
                errorMessage: error?["message"] as? String,
                files: images(inToolOutput: result?["output"])
            )
        case "input.requested":
            let rawRequests = data["requests"] as? [[String: Any]] ?? []
            return .inputRequested(turnId: turnId, requests: rawRequests.compactMap(parseInputRequest))
        case "turn.completed":
            return .turnCompleted(turnId: turnId)
        case "turn.failed":
            return .turnFailed(
                turnId: turnId,
                code: data["code"] as? String ?? "unknown",
                message: data["message"] as? String ?? "The agent run failed."
            )
        case "step.failed":
            return .stepFailed(
                turnId: turnId,
                code: data["code"] as? String ?? "unknown",
                message: data["message"] as? String ?? "A step failed."
            )
        case "session.waiting":
            return .sessionWaiting
        case "session.completed":
            return .sessionCompleted
        case "session.failed":
            return .sessionFailed(
                code: data["code"] as? String ?? "unknown",
                message: data["message"] as? String ?? "The agent session failed."
            )
        default:
            return .other(type: type)
        }
    }

    nonisolated private static func parseMessageFile(_ raw: [String: Any]) -> EveFile? {
        guard raw["type"] as? String == "file", let mediaType = raw["mediaType"] as? String else {
            return nil
        }
        return EveFile(
            filename: raw["filename"] as? String,
            mediaType: mediaType,
            sizeBytes: intValue(raw["size"]),
            url: raw["url"] as? String
        )
    }

    nonisolated private static func parseAction(_ raw: [String: Any]) -> EveActionRequest? {
        guard let callId = raw["callId"] as? String else { return nil }
        let kind = raw["kind"] as? String ?? "tool-call"
        let name = (raw["toolName"] as? String)
            ?? (raw["subagentName"] as? String)
            ?? (raw["name"] as? String)
            ?? kind
        let input = (raw["input"] as? [String: Any] ?? [:])
            .compactMapValues(EveToolArgument.init(json:))
        return EveActionRequest(callId: callId, kind: kind, name: name, input: input)
    }

    nonisolated private static func parseInputRequest(_ raw: [String: Any]) -> EveInputRequest? {
        guard let requestId = raw["requestId"] as? String,
              let prompt = raw["prompt"] as? String else {
            return nil
        }
        let rawOptions = raw["options"] as? [[String: Any]] ?? []
        return EveInputRequest(
            requestId: requestId,
            prompt: prompt,
            // Anything unrecognised renders as a plain question, the treatment
            // that assumes least about what is being asked.
            kind: raw["kind"] as? String ?? "question",
            allowFreeform: raw["allowFreeform"] as? Bool ?? false,
            options: rawOptions.compactMap { option in
                guard let id = option["id"] as? String, let label = option["label"] as? String else {
                    return nil
                }
                return EveInputOption(
                    id: id,
                    label: label,
                    detail: option["description"] as? String,
                    style: option["style"] as? String
                )
            },
            action: (raw["action"] as? [String: Any]).flatMap { action in
                guard let callId = action["callId"] as? String,
                      let toolName = action["toolName"] as? String else { return nil }
                return EveInputAction(
                    callId: callId,
                    toolName: toolName,
                    input: (action["input"] as? [String: Any] ?? [:])
                        .compactMapValues(EveToolArgument.init(json:))
                )
            }
        )
    }

    /// At most this many images off one tool result. The computer tool answers a
    /// twenty-action batch with an image per action plus a final screenshot;
    /// keeping them all would put tens of megabytes of PNG in the transcript.
    private static let maxImagesPerResult = 2

    /// Screenshots ride back inside the tool's own JSON output as base64 — the
    /// computer tool's `screenshot_b64` and per-action `image_b64` — so the phone
    /// picks them up by shape (`*_b64` beside an optional `media_type`) rather
    /// than by knowing which tool it is talking to.
    nonisolated static func images(inToolOutput value: Any?) -> [EveFile] {
        var found: [EveFile] = []
        var seen = Set<String>()
        collectImages(value, depth: 0, seen: &seen, into: &found)
        return found
    }

    nonisolated private static func collectImages(
        _ value: Any?,
        depth: Int,
        seen: inout Set<String>,
        into found: inout [EveFile]
    ) {
        guard depth < 5, found.count < maxImagesPerResult else { return }
        if let array = value as? [Any] {
            for element in array {
                collectImages(element, depth: depth + 1, seen: &seen, into: &found)
            }
            return
        }
        guard let object = value as? [String: Any] else { return }
        // Children first: a batch's per-action images precede the final
        // screenshot in the response, and that is the order to show them in.
        for key in object.keys.sorted() where !key.hasSuffix("_b64") {
            collectImages(object[key], depth: depth + 1, seen: &seen, into: &found)
        }
        let mediaType = object["media_type"] as? String ?? "image/png"
        for key in object.keys.sorted() where key.hasSuffix("_b64") {
            guard found.count < maxImagesPerResult,
                  let base64 = object[key] as? String, !base64.isEmpty,
                  seen.insert(base64).inserted,
                  let bytes = Data(base64Encoded: base64) else { continue }
            found.append(
                EveFile(filename: nil, mediaType: mediaType, sizeBytes: bytes.count, bytes: bytes)
            )
        }
    }

    nonisolated private static func intValue(_ value: Any?) -> Int? {
        switch value {
        case let int as Int: return int
        case let double as Double: return Int(double)
        default: return nil
        }
    }
}

// MARK: - Errors

enum EveError: Error, LocalizedError, Equatable {
    case http(status: Int, body: String)
    case malformedEvent(String)
    case missingSessionId
    case emptyTurn

    var errorDescription: String? {
        switch self {
        case .http(let status, let body):
            if let message = Self.apiMessage(in: body) { return message }
            return status == 401
                ? "The hub rejected this phone's pairing (401)."
                : "The agent request failed (\(status))."
        case .malformedEvent:
            return "The agent sent a malformed stream event."
        case .missingSessionId:
            return "The agent did not return a session id."
        case .emptyTurn:
            return "A turn needs a message or an answer."
        }
    }

    var isUnauthorized: Bool {
        if case .http(let status, _) = self { return status == 401 }
        return false
    }

    /// The hub answers its own failures in `computer.v1` shape
    /// (`{"error":{"code","message"}}`); Eve's own errors are passed through.
    private static func apiMessage(in body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any] else { return nil }
        return error["message"] as? String
    }
}

// MARK: - Transport

struct EveTurnAcknowledgement: Equatable, Sendable {
    let sessionId: String
}

/// The seam the chat talks to, so the reducer and the screen can be exercised
/// without a hub.
protocol EveTransport: Sendable {
    func sendTurn(
        message: String?,
        inputResponses: [EveInputResponse],
        cursor: EveSessionCursor
    ) async throws -> EveTurnAcknowledgement

    /// Streams a turn's events from `startIndex`, reconnecting on transient
    /// disconnects and finishing after the turn-boundary event.
    func streamTurn(sessionId: String, startIndex: Int) -> AsyncThrowingStream<EveStreamEvent, Error>

    /// Replays a session's durable event stream from the start, to rebuild the
    /// transcript after a relaunch.
    func replayEvents(sessionId: String) async throws -> [EveStreamEvent]

    /// Stops the turn that is currently running. Fire and forget: the stream
    /// reports the real outcome.
    func cancel(sessionId: String) async throws
}

// MARK: - Client

/// Speaks Eve's own `/eve/v1` session protocol through the paired hub, which
/// proxies it to the agent. One origin, one credential: the seat token that
/// already gates the pixels gates the agent too.
final class EveClient: EveTransport {
    /// A stream can be opened a moment before the session exists on the far
    /// side; these say "not yet", not "no".
    private static let retryableStreamOpenStatuses: Set<Int> = [404, 409, 425, 500, 502, 503, 504]
    private static let streamOpenAttempts = 10
    private static let maxReconnectAttempts = 3
    private static let deliveryAttempts = 10
    /// A parked session's stream never ends on its own, so a replay stops once
    /// the durable backlog has drained and nothing new has arrived.
    private static let replayIdleTimeout: TimeInterval = 1.5

    private let baseURL: URL
    private let token: String?
    private let session: URLSession

    init(baseURL: URL, token: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    // MARK: Send

    func sendTurn(
        message: String?,
        inputResponses: [EveInputResponse],
        cursor: EveSessionCursor
    ) async throws -> EveTurnAcknowledgement {
        guard message != nil || !inputResponses.isEmpty else {
            throw EveError.emptyTurn
        }

        // Eve accepts exactly one of `message` or `inputResponses` per turn.
        var body: [String: Any] = [:]
        if let message {
            body["message"] = message
        } else {
            body["inputResponses"] = inputResponses.map { response in
                var encoded: [String: Any] = ["requestId": response.requestId]
                if let optionId = response.optionId { encoded["optionId"] = optionId }
                if let text = response.text { encoded["text"] = text }
                return encoded
            }
        }

        let path = cursor.sessionId.map { "/eve/v1/session/\($0)" } ?? "/eve/v1/session"
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        // An answer must land — it resumes a parked turn — so retry the one
        // known-transient failure. A plain message posts once.
        let attempts = inputResponses.isEmpty ? 1 : Self.deliveryAttempts
        var lastStatus = 0
        var lastBody = ""
        for attempt in 0..<attempts {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw EveError.http(status: 0, body: "Not an HTTP response")
            }
            if (200..<300).contains(http.statusCode) {
                return try Self.acknowledgement(from: data, response: http, cursor: cursor)
            }
            lastStatus = http.statusCode
            lastBody = String(data: data, encoding: .utf8) ?? ""
            let retryable = http.statusCode == 500
                && lastBody.range(of: "target session was not found", options: .caseInsensitive) != nil
            if !retryable {
                throw EveError.http(status: http.statusCode, body: lastBody)
            }
            if attempt < attempts - 1 {
                try await Task.sleep(nanoseconds: 200_000_000)
            }
        }
        throw EveError.http(status: lastStatus, body: lastBody)
    }

    func cancel(sessionId: String) async throws {
        var request = URLRequest(url: url("/eve/v1/session/\(sessionId)/cancel"))
        request.httpMethod = "POST"
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 202 accepted, 200 no active turn — both are success.
        guard (200..<300).contains(status) else {
            throw EveError.http(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
    }

    private static func acknowledgement(
        from data: Data,
        response: HTTPURLResponse,
        cursor: EveSessionCursor
    ) throws -> EveTurnAcknowledgement {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let sessionId = (json["sessionId"] as? String)
            ?? response.value(forHTTPHeaderField: "x-eve-session-id")?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? cursor.sessionId
        guard let sessionId, !sessionId.isEmpty else {
            throw EveError.missingSessionId
        }
        return EveTurnAcknowledgement(sessionId: sessionId)
    }

    // MARK: Stream

    func streamTurn(sessionId: String, startIndex: Int) -> AsyncThrowingStream<EveStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let consumer = Task {
                do {
                    try await self.runStream(sessionId: sessionId, startIndex: startIndex) { event in
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in consumer.cancel() }
        }
    }

    /// Reads the whole durable backlog from index 0.
    ///
    /// Unlike a turn read this does not stop at the first `session.waiting`: a
    /// conversation of several turns has one of those per turn, and stopping at
    /// the first would restore only its opening exchange. The hub does not
    /// forward Eve's `x-eve-stream-tail-index` header, so the end of the backlog
    /// is detected by the stream going quiet instead.
    func replayEvents(sessionId: String) async throws -> [EveStreamEvent] {
        let collector = ReplayCollector()
        let stream = streamTurn(sessionId: sessionId, startIndex: 0)
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    for try await event in stream {
                        await collector.append(event)
                    }
                }
                group.addTask {
                    while true {
                        try await Task.sleep(nanoseconds: 250_000_000)
                        if await collector.idleFor(Self.replayIdleTimeout) {
                            throw ReplayDrained()
                        }
                    }
                }
                _ = try await group.next()
                group.cancelAll()
            }
        } catch is ReplayDrained {
            // The backlog has drained; what was collected is the transcript.
        } catch {
            let events = await collector.events
            if events.isEmpty { throw error }
            return events
        }
        return await collector.events
    }

    private struct ReplayDrained: Error {}

    private actor ReplayCollector {
        private(set) var events: [EveStreamEvent] = []
        private var lastEventAt = Date()

        func append(_ event: EveStreamEvent) {
            events.append(event)
            lastEventAt = Date()
        }

        func idleFor(_ interval: TimeInterval) -> Bool {
            Date().timeIntervalSince(lastEventAt) > interval
        }
    }

    private func runStream(
        sessionId: String,
        startIndex: Int,
        onEvent: (EveStreamEvent) -> Void
    ) async throws {
        var nextIndex = startIndex
        var reconnectsLeft = Self.maxReconnectAttempts
        while true {
            let bytes = try await openStream(sessionId: sessionId, startIndex: nextIndex)
            var sawBoundary = false
            do {
                for try await line in bytes.lines {
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    guard !trimmed.isEmpty else { continue }
                    let event = try EveStreamEventParser.parse(line: trimmed)
                    // Counted before it is handed on, so a reconnect resumes
                    // after the last event the caller actually saw.
                    nextIndex += 1
                    onEvent(event)
                    if event.isTurnBoundary {
                        sawBoundary = true
                        break
                    }
                }
            } catch let error as EveError {
                throw error
            } catch {
                // Transient disconnect: reconnect from the next index.
                try Task.checkCancellation()
            }
            if sawBoundary || reconnectsLeft <= 0 {
                return
            }
            try Task.checkCancellation()
            reconnectsLeft -= 1
        }
    }

    private func openStream(sessionId: String, startIndex: Int) async throws -> URLSession.AsyncBytes {
        var lastStatus = 0
        var lastBody = ""
        for attempt in 0..<Self.streamOpenAttempts {
            try Task.checkCancellation()
            var components = URLComponents(
                url: url("/eve/v1/session/\(sessionId)/stream"),
                resolvingAgainstBaseURL: false
            )
            if startIndex > 0 {
                components?.queryItems = [URLQueryItem(name: "startIndex", value: String(startIndex))]
            }
            guard let streamURL = components?.url else { throw URLError(.badURL) }
            var request = URLRequest(url: streamURL)
            request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
            authorize(&request)
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw EveError.http(status: 0, body: "Not an HTTP response")
            }
            if (200..<300).contains(http.statusCode) {
                return bytes
            }
            lastStatus = http.statusCode
            lastBody = (try? await Self.text(from: bytes)) ?? ""
            if !Self.retryableStreamOpenStatuses.contains(http.statusCode) {
                throw EveError.http(status: http.statusCode, body: lastBody)
            }
            if attempt < Self.streamOpenAttempts - 1 {
                try await Task.sleep(nanoseconds: Self.streamOpenRetryDelay(attempt: attempt))
            }
        }
        throw EveError.http(status: lastStatus, body: lastBody)
    }

    /// The stream endpoint is usually ready within a few hundred ms of the send,
    /// so the first attempts fire quickly, then settle at 250ms.
    private static func streamOpenRetryDelay(attempt: Int) -> UInt64 {
        switch attempt {
        case 0: return 100_000_000
        case 1: return 150_000_000
        case 2: return 200_000_000
        default: return 250_000_000
        }
    }

    private static func text(from bytes: URLSession.AsyncBytes) async throws -> String {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func authorize(_ request: inout URLRequest) {
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    /// `URL.appending(path:)` percent-encodes the whole path; the Eve routes are
    /// literal, so they are joined the way `ComputerClient` joins Connect paths.
    func url(_ path: String) -> URL {
        var base = baseURL.absoluteString
        if base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path) ?? baseURL
    }
}
