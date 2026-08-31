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

    func testPointerMoveEncodesGrab() throws {
        let data = try JSONEncoder().encode(ComputerV1.PointerRequest.move(dx: 4, dy: -2, grab: true))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "move")
        XCTAssertEqual(obj?["dx"] as? Int, 4)
        XCTAssertEqual(obj?["dy"] as? Int, -2)
        XCTAssertEqual(obj?["grab"] as? Bool, true)
    }

    func testDisplayScopedMergesDisplayKey() throws {
        let data = try JSONEncoder().encode(
            ComputerV1.DisplayScoped(ComputerV1.TypeRequest(text: "hi"), display: 2)
        )
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["text"] as? String, "hi")
        XCTAssertEqual(obj?["display"] as? Int, 2)

        let bare = try JSONEncoder().encode(
            ComputerV1.DisplayScoped(ComputerV1.TypeRequest(text: "hi"), display: nil)
        )
        let bareObj = try JSONSerialization.jsonObject(with: bare) as? [String: Any]
        XCTAssertNil(bareObj?["display"])
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
        XCTAssertEqual(status.screens?.count, 2)
        XCTAssertEqual(status.screens?[1].botId, "night")
        XCTAssertEqual(status.screens?[1].display, 2)
        XCTAssertEqual(status.screens?[1].state, .waiting)
    }

    func testBoxStatusDecodesWithoutScreens() throws {
        // Older single-screen hub omits `screens`.
        let json = """
        {"state": "AGENT", "vnc_url": "https://h/vnc", "display": {"width": 1280, "height": 800, "scale": 1}}
        """
        let status = try JSONDecoder().decode(ComputerV1.BoxStatus.self, from: Data(json.utf8))
        XCTAssertNil(status.screens)
    }

    func testSeatStateRoundTrip() throws {
        let status = ComputerV1.BoxStatus(
            state: .waiting,
            vncUrl: "https://h/vnc/index.html?view_only=1",
            display: ComputerV1.display
        )
        let data = try JSONEncoder().encode(status)
        let back = try JSONDecoder().decode(ComputerV1.BoxStatus.self, from: data)
        XCTAssertEqual(back.state, .waiting)
        XCTAssertEqual(back.display.width, 1280)
        XCTAssertEqual(back.display.height, 800)
    }
}
