import XCTest
@testable import Computer

final class PairTests: XCTestCase {
    func testParseQRExtractsHostAndCode() throws {
        let parsed = PairURL.parsePairQR(
            "computer://pair?host=https://computer.tailnet.ts.net&code=secret-1"
        )
        XCTAssertEqual(parsed.host, "https://computer.tailnet.ts.net")
        XCTAssertEqual(parsed.code, "secret-1")
    }

    func testParseHostAddsHTTPS() throws {
        let url = try PairURL.parseHost("computer.tailnet.ts.net")
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "computer.tailnet.ts.net")
    }

    func testParseHostFromQRURL() throws {
        let url = try PairURL.parseHost("computer://pair?host=https://example.ts.net&code=x")
        XCTAssertEqual(url.absoluteString, "https://example.ts.net")
    }
}
