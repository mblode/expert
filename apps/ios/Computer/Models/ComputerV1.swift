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

    public enum SeatState: String, Codable, Sendable {
        case agent = "AGENT"
        case waiting = "WAITING"
        case human = "HUMAN"
    }

    public enum ErrorCode: String, Codable, Sendable {
        case unauthenticated = "UNAUTHENTICATED"
        case seatHeld = "SEAT_HELD"
        case outOfBounds = "OUT_OF_BOUNDS"
        case pathRejected = "PATH_REJECTED"
        case daemonDown = "DAEMON_DOWN"
        case validation = "VALIDATION"
        case conflict = "CONFLICT"
    }

    public struct Point: Codable, Equatable, Sendable {
        public var x: Int
        public var y: Int
        public init(x: Int, y: Int) {
            self.x = x
            self.y = y
        }
    }

    public struct BoxStatus: Codable, Sendable {
        public var state: SeatState
        public var vncUrl: String
        public var display: Display
        public init(state: SeatState, vncUrl: String, display: Display) {
            self.state = state
            self.vncUrl = vncUrl
            self.display = display
        }

        enum CodingKeys: String, CodingKey {
            case state
            case vncUrl = "vnc_url"
            case display
        }
    }

    public struct PairRequest: Codable, Sendable {
        public var code: String
        public init(code: String) { self.code = code }
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
        public init(present: Bool) { self.present = present }
    }

    public enum PointerRequest: Codable, Sendable {
        case move(dx: Int, dy: Int, grab: Bool?)
        case click(button: String?)

        enum CodingKeys: String, CodingKey { case type, dx, dy, grab, button }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .move(let dx, let dy, let grab):
                try c.encode("move", forKey: .type)
                try c.encode(dx, forKey: .dx)
                try c.encode(dy, forKey: .dy)
                try c.encodeIfPresent(grab, forKey: .grab)
            case .click(let button):
                try c.encode("click", forKey: .type)
                try c.encodeIfPresent(button, forKey: .button)
            }
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(String.self, forKey: .type)
            switch type {
            case "move":
                self = .move(
                    dx: try c.decode(Int.self, forKey: .dx),
                    dy: try c.decode(Int.self, forKey: .dy),
                    grab: try c.decodeIfPresent(Bool.self, forKey: .grab)
                )
            case "click":
                self = .click(button: try c.decodeIfPresent(String.self, forKey: .button))
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
        public init(text: String) { self.text = text }
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
        status: "/computer.v1.Seat/Status",
        setPresence: "/computer.v1.Seat/SetPresence",
        pointer: "/computer.v1.Seat/Pointer",
        type: "/computer.v1.Seat/Type",
        clipboardGet: "/computer.v1.Seat/ClipboardGet",
        clipboardSet: "/computer.v1.Seat/ClipboardSet"
    )
}
