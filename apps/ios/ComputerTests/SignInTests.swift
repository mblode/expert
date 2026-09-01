import XCTest
@testable import Computer

final class SignInTests: XCTestCase {
    func testEmailAndOtpShape() {
        XCTAssertTrue(EmailOTP.isEmail("you@example.com"))
        XCTAssertFalse(EmailOTP.isEmail("not-an-email"))
        XCTAssertTrue(EmailOTP.isCode("123456"))
        XCTAssertFalse(EmailOTP.isCode("12345"))
        XCTAssertFalse(EmailOTP.isCode("abcdef"))
    }

    func testParseGoTrueVerifyResponse() throws {
        let json: [String: Any] = [
            "access_token": "jwt-access",
            "user": ["email": "you@example.com", "id": "11111111-1111-4111-8111-111111111111"],
        ]
        let session = try SupabaseAuth.parseSession(json, fallbackEmail: "fallback@example.com")
        XCTAssertEqual(session.accessToken, "jwt-access")
        XCTAssertEqual(session.email, "you@example.com")
    }

    func testSessionPath() {
        let client = ComputerClient(baseURL: URL(string: "https://computer.example")!, token: nil)
        XCTAssertEqual(
            client.url(ComputerV1.seatPaths.session).absoluteString,
            "https://computer.example/computer.v1.Seat/Session"
        )
    }

    func testSessionRequestEncodesEmptyObject() throws {
        let data = try JSONEncoder().encode(ComputerV1.SessionRequest())
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?.isEmpty, true)
    }
}
