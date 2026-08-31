import Foundation

struct ChatEvent: Decodable {
    var type: String
    var text: String?
    var message: String?
    var code: String?
    var request_id: String?
}

enum ClientError: LocalizedError {
    case http(ComputerV1.ApiError)
    case status(Int)
    case decode

    var errorDescription: String? {
        switch self {
        case .http(let e): return e.error.message
        case .status(let n): return "HTTP \(n)"
        case .decode: return "bad response"
        }
    }
}

struct ComputerClient: Sendable {
    var baseURL: URL
    var token: String?

    func pair(code: String) async throws -> ComputerV1.PairResponse {
        try await post(ComputerV1.seatPaths.pair, ComputerV1.PairRequest(code: code), auth: false)
    }

    func status() async throws -> ComputerV1.BoxStatus {
        try await post(ComputerV1.seatPaths.status, [String: String]())
    }

    func setPresence(present: Bool) async throws -> ComputerV1.BoxStatus {
        try await post(ComputerV1.seatPaths.setPresence, ComputerV1.SetPresenceRequest(present: present))
    }

    func pointer(_ req: ComputerV1.PointerRequest) async throws -> ComputerV1.PointerResponse {
        try await post(ComputerV1.seatPaths.pointer, req)
    }

    func type(_ text: String) async throws -> ComputerV1.PointerResponse {
        try await post(ComputerV1.seatPaths.type, ComputerV1.TypeRequest(text: text))
    }

    func clipboardGet() async throws -> ComputerV1.Clipboard {
        try await post(ComputerV1.seatPaths.clipboardGet, [String: String]())
    }

    func clipboardSet(_ text: String) async throws -> ComputerV1.Clipboard {
        try await post(ComputerV1.seatPaths.clipboardSet, ComputerV1.Clipboard(text: text))
    }

    func chat(message: String, onEvent: @escaping @Sendable (ChatEvent) -> Void) async throws {
        var req = URLRequest(url: baseURL.appending(path: "chat"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONEncoder().encode(["message": message])
        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw ClientError.status(http.statusCode)
        }
        for try await line in bytes.lines {
            guard line.hasPrefix("data: ") else { continue }
            let payload = String(line.dropFirst(6))
            if let data = payload.data(using: .utf8),
               let ev = try? JSONDecoder().decode(ChatEvent.self, from: data) {
                onEvent(ev)
            }
        }
    }

    private func post<In: Encodable, Out: Decodable>(_ path: String, _ body: In, auth: Bool = true) async throws -> Out {
        var req = URLRequest(url: baseURL.appending(path: String(path.drop(while: { $0 == "/" }))))
        // appending(path:) strips leading slash; Connect paths include the package.
        req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
        if auth, let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            if let err = try? JSONDecoder().decode(ComputerV1.ApiError.self, from: data) {
                throw ClientError.http(err)
            }
            throw ClientError.status(status)
        }
        do {
            return try JSONDecoder().decode(Out.self, from: data)
        } catch {
            throw ClientError.decode
        }
    }

    func url(_ path: String) -> URL {
        var base = baseURL.absoluteString
        if base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path)!
    }
}
