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
