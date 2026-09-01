import XCTest
@testable import Computer

final class ClientTests: XCTestCase {
    func testConnectPaths() {
        let client = ComputerClient(baseURL: URL(string: "https://computer.example.ts.net")!, token: "t")
        XCTAssertEqual(
            client.url(ComputerV1.seatPaths.pair).absoluteString,
            "https://computer.example.ts.net/computer.v1.Seat/Pair"
        )
        XCTAssertEqual(
            client.url(ComputerV1.seatPaths.pointer).absoluteString,
            "https://computer.example.ts.net/computer.v1.Seat/Pointer"
        )
        XCTAssertEqual(
            client.url(ComputerV1.agentPaths.spec).absoluteString,
            "https://computer.example.ts.net/computer.v1.Agent/Spec"
        )
    }

    func testPointerMoveEncodesGrabAndDisplay() throws {
        let data = try JSONEncoder().encode(ComputerV1.PointerRequest.move(dx: 4, dy: -2, grab: true, display: 2))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "move")
        XCTAssertEqual(obj?["dx"] as? Int, 4)
        XCTAssertEqual(obj?["dy"] as? Int, -2)
        XCTAssertEqual(obj?["grab"] as? Bool, true)
        XCTAssertEqual(obj?["display"] as? Int, 2)

        let primary = try JSONEncoder().encode(ComputerV1.PointerRequest.click(button: nil, display: nil))
        let primaryObj = try JSONSerialization.jsonObject(with: primary) as? [String: Any]
        XCTAssertNil(primaryObj?["display"])
    }

    func testPointerScrollEncodes() throws {
        let data = try JSONEncoder().encode(ComputerV1.PointerRequest.scroll(dx: 0, dy: 3, display: 2))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "scroll")
        XCTAssertEqual(obj?["dx"] as? Int, 0)
        XCTAssertEqual(obj?["dy"] as? Int, 3)
        XCTAssertEqual(obj?["display"] as? Int, 2)

        let back = try JSONDecoder().decode(ComputerV1.PointerRequest.self, from: data)
        guard case .scroll(let dx, let dy, let display) = back else { return XCTFail("not a scroll") }
        XCTAssertEqual(dx, 0)
        XCTAssertEqual(dy, 3)
        XCTAssertEqual(display, 2)
    }

    /// The hub deploys independently of the App Store build, so a state or code
    /// added on the box must degrade rather than fail the whole parse.
    func testUnknownStatusEnumsDegrade() throws {
        let json = """
        {
          "state": "REBOOTING",
          "vnc_url": "https://h/vnc/index.html?view_only=1",
          "display": {"width": 1280, "height": 800, "scale": 1},
          "screens": [{"bot_id": "main", "display": 1, "state": "REBOOTING", "vnc_url": "https://h/v"}]
        }
        """
        let status = try JSONDecoder().decode(ComputerV1.BoxStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.state, .unknown)
        XCTAssertEqual(status.screens[0].state, .unknown)

        let err = try JSONDecoder().decode(
            ComputerV1.ApiError.self,
            from: Data(#"{"error":{"code":"WORKSPACE_GONE","message":"the box went away"}}"#.utf8)
        )
        XCTAssertEqual(err.error.code, .unknown)
        XCTAssertEqual(err.error.message, "the box went away")
        // An unrecognised code is retryable: a newer hub knowing more than this
        // build is not grounds for a dead end.
        XCTAssertTrue(ClientError.retryable(ClientError.http(err)))
    }

    func testRetryableSplitsTerminalFromTransient() throws {
        func error(_ code: String) -> ClientError {
            let json = #"{"error":{"code":"\#(code)","message":"x"}}"#
            return .http(try! JSONDecoder().decode(ComputerV1.ApiError.self, from: Data(json.utf8)))
        }
        XCTAssertTrue(ClientError.retryable(error("DAEMON_DOWN")))
        XCTAssertTrue(ClientError.retryable(error("SEAT_HELD")))
        XCTAssertFalse(ClientError.retryable(error("UNAUTHENTICATED")))
        XCTAssertFalse(ClientError.retryable(error("VALIDATION")))
        XCTAssertFalse(ClientError.retryable(error("DENIED")))
        XCTAssertTrue(ClientError.retryable(ClientError.status(503)))
        XCTAssertFalse(ClientError.retryable(ClientError.status(404)))
        // A transport failure never reached the hub, so it says nothing final.
        XCTAssertTrue(ClientError.retryable(URLError(.notConnectedToInternet)))
    }

    /// DAEMON_DOWN carries the answer; the code-derived default gives way to it.
    func testUnavailableEnvelopeOverridesTheCodeDefault() throws {
        let json = """
        {"error":{"code":"DAEMON_DOWN","message":"no route to the box",
          "reason":"instance_gone","phase":"route_missing","retryable":false}}
        """
        let err = try JSONDecoder().decode(ComputerV1.ApiError.self, from: Data(json.utf8))
        XCTAssertEqual(err.error.reason, "instance_gone")
        XCTAssertEqual(err.error.phase, "route_missing")
        XCTAssertFalse(ClientError.retryable(ClientError.http(err)))
    }

    func testTypeRequestCarriesDisplay() throws {
        let data = try JSONEncoder().encode(ComputerV1.TypeRequest(text: "hi", display: 2))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["text"] as? String, "hi")
        XCTAssertEqual(obj?["display"] as? Int, 2)
    }

    func testBoxStatusDecodesScreens() throws {
        let json = """
        {
          "state": "AGENT",
          "vnc_url": "https://h/vnc/index.html?view_only=1",
          "display": {"width": 1280, "height": 800, "scale": 1},
          "screens": [
            {"bot_id": "main", "display": 1, "state": "AGENT", "vnc_url": "https://h/vnc/index.html?view_only=1"},
            {"bot_id": "night", "display": 2, "state": "WAITING", "vnc_url": "https://h/vnc/index.html?view_only=1&display=2"}
          ]
        }
        """
        let status = try JSONDecoder().decode(ComputerV1.BoxStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.screens.count, 2)
        XCTAssertEqual(status.screens[1].botId, "night")
        XCTAssertEqual(status.screens[1].display, 2)
        XCTAssertEqual(status.screens[1].state, .waiting)
    }

    func testBotCredentialsDecode() throws {
        let json = """
        {"id": "night", "display": 2, "token": "bot_abc"}
        """
        let creds = try JSONDecoder().decode(ComputerV1.BotCredentials.self, from: Data(json.utf8))
        XCTAssertEqual(creds.id, "night")
        XCTAssertEqual(creds.display, 2)
        XCTAssertEqual(creds.token, "bot_abc")
    }

    func testSeatStateRoundTrip() throws {
        let status = ComputerV1.BoxStatus(
            state: .waiting,
            vncUrl: "https://h/vnc/index.html?view_only=1",
            display: ComputerV1.display,
            screens: []
        )
        let data = try JSONEncoder().encode(status)
        let back = try JSONDecoder().decode(ComputerV1.BoxStatus.self, from: data)
        XCTAssertEqual(back.state, .waiting)
        XCTAssertEqual(back.display.width, 1280)
        XCTAssertEqual(back.display.height, 800)
    }
}
