import XCTest
@testable import Computer

final class CoordinateTests: XCTestCase {
    func testLetterboxMapsCornersToDisplay() {
        let bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
        let tl = CoordinateMap.desktopPoint(from: CGPoint(x: 0, y: 0), in: bounds)
        XCTAssertGreaterThanOrEqual(tl.x, 0)
        XCTAssertGreaterThanOrEqual(tl.y, 0)

        let scale = min(390.0 / 1280.0, 844.0 / 800.0)
        let w = 1280 * scale
        let h = 800 * scale
        let x0 = (390 - w) / 2
        let y0 = (844 - h) / 2
        let origin = CoordinateMap.desktopPoint(from: CGPoint(x: x0, y: y0), in: bounds)
        XCTAssertEqual(origin.x, 0)
        XCTAssertEqual(origin.y, 0)

        let far = CoordinateMap.desktopPoint(from: CGPoint(x: x0 + w - 0.1, y: y0 + h - 0.1), in: bounds)
        XCTAssertEqual(far.x, 1279)
        XCTAssertEqual(far.y, 799)
    }

    func testRoundTripCenter() {
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
        let view = CoordinateMap.viewPoint(from: (640, 400), in: bounds)
        let back = CoordinateMap.desktopPoint(from: view, in: bounds)
        XCTAssertEqual(back.x, 640)
        XCTAssertEqual(back.y, 400)
    }
}
