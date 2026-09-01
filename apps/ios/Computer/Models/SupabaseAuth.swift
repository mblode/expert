import Foundation

struct SupabaseSession: Equatable, Sendable {
    var accessToken: String
    var email: String?
}

enum SupabaseAuthError: LocalizedError {
    case notConfigured
    case invalidEmail
    case invalidCode
    case http(Int, String)
    case decode

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Email sign-in is not configured on this build."
        case .invalidEmail:
            return "Enter a valid email address."
        case .invalidCode:
            return "Enter the 6-digit code."
        case .http(_, let message):
            return message
        case .decode:
            return "Unexpected sign-in response."
        }
    }
}

/// Thin GoTrue client. Email OTP is performed here; the hub only sees the JWT.
struct SupabaseAuth: Sendable {
    var url: URL
    var anonKey: String
    var session: URLSession = .shared

    static func fromConfig() -> SupabaseAuth? {
        guard ComputerConfig.emailSignInEnabled,
              let url = URL(string: ComputerConfig.supabaseURL) else { return nil }
        return SupabaseAuth(url: url, anonKey: ComputerConfig.supabaseAnonKey)
    }

    func sendOtp(email: String) async throws {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard EmailOTP.isEmail(trimmed) else { throw SupabaseAuthError.invalidEmail }
        let body: [String: Any] = ["email": trimmed, "create_user": true]
        _ = try await post("otp", body: body)
    }

    func verifyOtp(email: String, code: String) async throws -> SupabaseSession {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard EmailOTP.isEmail(trimmed) else { throw SupabaseAuthError.invalidEmail }
        guard EmailOTP.isCode(token) else { throw SupabaseAuthError.invalidCode }
        let json = try await post("verify", body: [
            "type": "email",
            "email": trimmed,
            "token": token,
        ])
        return try Self.parseSession(json, fallbackEmail: trimmed)
    }

    static func parseSession(_ json: [String: Any], fallbackEmail: String) throws -> SupabaseSession {
        let access = json["access_token"] as? String
        let nested = json["session"] as? [String: Any]
        let token = access ?? (nested?["access_token"] as? String)
        guard let token, !token.isEmpty else { throw SupabaseAuthError.decode }
        let user = (json["user"] as? [String: Any]) ?? (nested?["user"] as? [String: Any])
        let email = (user?["email"] as? String) ?? fallbackEmail
        return SupabaseSession(accessToken: token, email: email)
    }

    private func post(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        var req = URLRequest(url: url.appending(path: "auth/v1/\(path)"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(anonKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if status >= 400 {
            let message = (obj?["error_description"] as? String)
                ?? (obj?["msg"] as? String)
                ?? (obj?["message"] as? String)
                ?? "HTTP \(status)"
            throw SupabaseAuthError.http(status, message)
        }
        return obj ?? [:]
    }
}
