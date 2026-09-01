import Foundation

/// Product config. Keys come from Info.plist (`INFOPLIST_KEY_*` in the Xcode
/// project) so secrets stay out of git — fill them from `.env.example`.
enum ComputerConfig {
    static var supabaseURL: String { plist("SUPABASE_URL") }
    static var supabaseAnonKey: String { plist("SUPABASE_ANON_KEY") }
    static var hubURL: String { plist("COMPUTER_HUB_URL") }

    static var emailSignInEnabled: Bool {
        !supabaseURL.isEmpty && !supabaseAnonKey.isEmpty
    }

    private static func plist(_ key: String) -> String {
        let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum EmailOTP {
    static func isEmail(_ raw: String) -> Bool {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = s.firstIndex(of: "@") else { return false }
        let host = s[s.index(after: at)...]
        return s.count >= 3 && host.contains(".")
    }

    static func isCode(_ raw: String) -> Bool {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.count == 6 && s.allSatisfy(\.isNumber)
    }
}
