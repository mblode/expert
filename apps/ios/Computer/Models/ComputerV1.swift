// computer.v1 — Swift view of api/computer.proto / DESIGN.md
// Hand-written Codable (no protobuf plugin). Keep in lockstep with packages/proto/ts.

import Foundation

public enum ComputerV1 {
    public static let specId = "computer.v1"
    public static let version = "1.0.0"
    public static let display = Display(width: 1280, height: 800, scale: 1)

    public struct Display: Codable, Equatable, Sendable {
        public var width: Int
        public var height: Int
        public var scale: Int
        public init(width: Int, height: Int, scale: Int) {
            self.width = width
            self.height = height
            self.scale = scale
        }
    }

    /// Hub → phone status enums degrade instead of throwing: the hub is deployed
    /// independently of the App Store build, so a state added on the box must not
    /// break the typed parse on every phone already in a pocket.
    public enum SeatState: String, Codable, Sendable {
        case agent = "AGENT"
        case waiting = "WAITING"
        case human = "HUMAN"
        /// A state this build does not know. Never sent by us.
        case unknown = "UNKNOWN"

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = SeatState(rawValue: raw) ?? .unknown
        }
    }

    public enum ErrorCode: String, Codable, Sendable {
        case unauthenticated = "UNAUTHENTICATED"
        case seatHeld = "SEAT_HELD"
        case outOfBounds = "OUT_OF_BOUNDS"
        case pathRejected = "PATH_REJECTED"
        case daemonDown = "DAEMON_DOWN"
        case validation = "VALIDATION"
        case conflict = "CONFLICT"
        /// A hub policy rule refused the call. Not a failure of the box.
        case denied = "DENIED"
        /// A code this build does not know. The message still reaches the user.
        case unknown = "UNKNOWN"

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = ErrorCode(rawValue: raw) ?? .unknown
        }
    }

    public struct Point: Codable, Equatable, Sendable {
        public var x: Int
        public var y: Int
        public init(x: Int, y: Int) {
            self.x = x
            self.y = y
        }
    }

    /// One Bot's screen on the shared box. Window index = X display number.
    public struct ScreenStatus: Codable, Equatable, Sendable, Identifiable {
        public var botId: String
        public var display: Int
        public var state: SeatState
        public var vncUrl: String
        public var id: Int { display }
        public init(botId: String, display: Int, state: SeatState, vncUrl: String) {
            self.botId = botId
            self.display = display
            self.state = state
            self.vncUrl = vncUrl
        }

        enum CodingKeys: String, CodingKey {
            case botId = "bot_id"
            case display
            case state
            case vncUrl = "vnc_url"
        }
    }

    public struct BoxStatus: Codable, Sendable {
        public var state: SeatState
        public var vncUrl: String
        public var display: Display
        public var screens: [ScreenStatus]
        public init(state: SeatState, vncUrl: String, display: Display, screens: [ScreenStatus]) {
            self.state = state
            self.vncUrl = vncUrl
            self.display = display
            self.screens = screens
        }

        enum CodingKeys: String, CodingKey {
            case state
            case vncUrl = "vnc_url"
            case display
            case screens
        }
    }

    public struct PairRequest: Codable, Sendable {
        public var code: String
        public init(code: String) { self.code = code }
    }

    public struct SessionRequest: Codable, Sendable {
        public init() {}
    }

    public struct PairResponse: Codable, Sendable {
        public var token: String
        public var vncUrl: String
        public var status: BoxStatus

        enum CodingKeys: String, CodingKey {
            case token
            case vncUrl = "vnc_url"
            case status
        }
    }

    public struct SetPresenceRequest: Codable, Sendable {
        public var present: Bool
        public var display: Int?
        public init(present: Bool, display: Int? = nil) {
            self.present = present
            self.display = display
        }
    }

    public struct StatusRequest: Codable, Sendable {
        public var display: Int?
        public init(display: Int? = nil) { self.display = display }
    }

    public struct ClipboardGetRequest: Codable, Sendable {
        public var display: Int?
        public init(display: Int? = nil) { self.display = display }
    }

    public struct ClipboardSetRequest: Codable, Sendable {
        public var text: String
        public var display: Int?
        public init(text: String, display: Int? = nil) {
            self.text = text
            self.display = display
        }
    }

    public struct CreateBotRequest: Codable, Sendable {
        public var id: String
        public init(id: String) { self.id = id }
    }

    public struct BotCredentials: Codable, Sendable {
        public var id: String
        public var display: Int
        /// Shown once; the Bot's identity.
        public var token: String
    }

    public struct DeleteBotRequest: Codable, Sendable {
        public var id: String
        public init(id: String) { self.id = id }
    }

    public enum PointerRequest: Codable, Sendable {
        case move(dx: Int, dy: Int, grab: Bool?, display: Int?)
        case click(button: String?, display: Int?)
        /// Wheel notches at the current cursor; the box supplies the position.
        case scroll(dx: Int, dy: Int, display: Int?)

        enum CodingKeys: String, CodingKey { case type, dx, dy, grab, button, display }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .move(let dx, let dy, let grab, let display):
                try c.encode("move", forKey: .type)
                try c.encode(dx, forKey: .dx)
                try c.encode(dy, forKey: .dy)
                try c.encodeIfPresent(grab, forKey: .grab)
                try c.encodeIfPresent(display, forKey: .display)
            case .click(let button, let display):
                try c.encode("click", forKey: .type)
                try c.encodeIfPresent(button, forKey: .button)
                try c.encodeIfPresent(display, forKey: .display)
            case .scroll(let dx, let dy, let display):
                try c.encode("scroll", forKey: .type)
                try c.encode(dx, forKey: .dx)
                try c.encode(dy, forKey: .dy)
                try c.encodeIfPresent(display, forKey: .display)
            }
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(String.self, forKey: .type)
            let display = try c.decodeIfPresent(Int.self, forKey: .display)
            switch type {
            case "move":
                self = .move(
                    dx: try c.decode(Int.self, forKey: .dx),
                    dy: try c.decode(Int.self, forKey: .dy),
                    grab: try c.decodeIfPresent(Bool.self, forKey: .grab),
                    display: display
                )
            case "click":
                self = .click(button: try c.decodeIfPresent(String.self, forKey: .button), display: display)
            case "scroll":
                self = .scroll(
                    dx: try c.decode(Int.self, forKey: .dx),
                    dy: try c.decode(Int.self, forKey: .dy),
                    display: display
                )
            default:
                throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: type)
            }
        }
    }

    public struct PointerResponse: Codable, Sendable {
        public var cursor: Point
        public var seat: SeatState
    }

    public struct TypeRequest: Codable, Sendable {
        public var text: String
        public var display: Int?
        public init(text: String, display: Int? = nil) {
            self.text = text
            self.display = display
        }
    }

    public struct Clipboard: Codable, Sendable {
        public var text: String
        public init(text: String) { self.text = text }
    }

    public struct ApiError: Codable, Sendable {
        public var error: Body
        public struct Body: Codable, Sendable {
            public var code: ErrorCode
            public var message: String
            /// DAEMON_DOWN only: why the box is unreachable, at what stage, and
            /// whether trying again can help. Absent on every other code, and on
            /// a hub older than the release that added them.
            public var reason: String?
            public var phase: String?
            public var retryable: Bool?
        }
    }

    public static let agentPaths = (
        spec: "/computer.v1.Agent/Spec",
        computer: "/computer.v1.Agent/Computer",
        shell: "/computer.v1.Agent/Shell",
        readFile: "/computer.v1.Agent/ReadFile",
        writeFile: "/computer.v1.Agent/WriteFile"
    )

    public static let seatPaths = (
        pair: "/computer.v1.Seat/Pair",
        session: "/computer.v1.Seat/Session",
        status: "/computer.v1.Seat/Status",
        setPresence: "/computer.v1.Seat/SetPresence",
        pointer: "/computer.v1.Seat/Pointer",
        type: "/computer.v1.Seat/Type",
        clipboardGet: "/computer.v1.Seat/ClipboardGet",
        clipboardSet: "/computer.v1.Seat/ClipboardSet",
        createBot: "/computer.v1.Seat/CreateBot",
        deleteBot: "/computer.v1.Seat/DeleteBot"
    )
}
