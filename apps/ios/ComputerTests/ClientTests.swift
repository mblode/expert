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
