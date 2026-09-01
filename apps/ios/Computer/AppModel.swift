import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var session: Session?
    @Published var messages: [ChatMessage] = []
    @Published var status: ComputerV1.BoxStatus?
    @Published var waiting = false
    @Published var pairError: String?
    @Published var busy = false
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

    func restore() {
        session = store.load()
        if session != nil { Task { await refreshStatus() } }
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
        store.clear()
        session = nil
        messages = []
        status = nil
        waiting = false
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
        } catch {
            // keep last known
        }
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

    func sendChat(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let client else { return }
        messages.append(ChatMessage(role: .user, text: trimmed))
        messages.append(ChatMessage(role: .assistant, text: ""))
        let idx = messages.count - 1
        do {
            // The stream callback is @Sendable, so accumulate into the array
            // element on the MainActor rather than carrying a mutable struct across.
            try await client.chat(message: trimmed, botId: currentScreen?.botId) { event in
                Task { @MainActor in
                    guard self.messages.indices.contains(idx) else { return }
                    switch event.type {
                    case "delta":
                        self.messages[idx].text += event.text ?? ""
                    case "waiting":
                        self.waiting = true
                        if self.messages[idx].text.isEmpty {
                            self.messages[idx].text = event.message ?? "Seat is waiting."
                        }
                    case "error":
                        self.messages[idx].text += "\n\(event.message ?? event.code ?? "error")"
                    default:
                        break
                    }
                }
            }
        } catch {
            messages[idx].text = error.localizedDescription
        }
        await refreshStatus()
    }

    func imDone() async {
        guard let client else { return }
        do {
            status = try await client.setPresence(present: false, display: selectedScreen?.display)
            waiting = false
        } catch {
            pairError = error.localizedDescription
        }
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

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant }
    let id = UUID()
    var role: Role
    var text: String
}
