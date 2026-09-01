import XCTest
@testable import Computer

// MARK: - NDJSON parsing

final class EveStreamEventParserTests: XCTestCase {
    func testParsesCumulativeAssistantDelta() throws {
        let line = """
        {"type":"message.appended","data":{"turnId":"turn_0","stepIndex":0,"messageDelta":" there",\
        "messageSoFar":"Hi there","sequence":3},"meta":{"id":"evt_1","at":"2026-07-27T18:04:11.912Z"}}
        """
        let event = try EveStreamEventParser.parse(line: line)
        XCTAssertEqual(
            event,
            .messageAppended(turnId: "turn_0", stepIndex: 0, messageSoFar: "Hi there")
        )
    }

    func testParsesToolCallAndResult() throws {
        let requested = try EveStreamEventParser.parse(line: """
        {"type":"actions.requested","data":{"turnId":"turn_0","stepIndex":0,"actions":[\
        {"callId":"call_1","kind":"tool-call","toolName":"shell","input":{"argv":["ls","-la"],"request_id":"r1"}}]}}
        """)
        guard case .actionsRequested(_, _, let actions) = requested else {
            return XCTFail("expected actions.requested, got \(requested)")
        }
        XCTAssertEqual(actions.first?.callId, "call_1")
        XCTAssertEqual(actions.first?.name, "shell")
        XCTAssertEqual(actions.first?.input["argv"], .list(["ls", "-la"]))

        let result = try EveStreamEventParser.parse(line: """
        {"type":"action.result","data":{"turnId":"turn_0","status":"completed",\
        "result":{"callId":"call_1","kind":"tool-result","toolName":"shell","output":{"exit_code":0}}}}
        """)
        XCTAssertEqual(
            result,
            .actionResult(
                turnId: "turn_0",
                callId: "call_1",
                status: "completed",
                errorMessage: nil,
                files: []
            )
        )
    }

    /// The computer tool answers with base64 screenshots inside its own JSON
    /// output; the phone finds them by shape, and shows each one once.
    func testActionResultLiftsScreenshotsOutOfToolOutput() throws {
        let event = try EveStreamEventParser.parse(line: """
        {"type":"action.result","data":{"turnId":"turn_0","status":"completed","result":{"callId":"call_2",\
        "kind":"tool-result","toolName":"computer","output":{"results":[{"kind":"ok","image_b64":"aGVsbG8=",\
        "media_type":"image/jpeg"}],"screenshot_b64":"aGVsbG8=","seat":"AGENT"}}}}
        """)
        guard case .actionResult(_, _, _, _, let files) = event else {
            return XCTFail("expected action.result, got \(event)")
        }
        XCTAssertEqual(files.count, 1, "the repeated screenshot is shown once")
        XCTAssertEqual(files.first?.mediaType, "image/jpeg")
        XCTAssertEqual(files.first?.bytes, Data("hello".utf8))
    }

    func testParsesInputRequestWithApprovalAction() throws {
        let event = try EveStreamEventParser.parse(line: """
        {"type":"input.requested","data":{"turnId":"turn_0","requests":[{"kind":"tool-approval",\
        "requestId":"req_A","prompt":"Run this command?","options":[{"id":"approve","label":"Approve","style":"danger"},\
        {"id":"cancel","label":"Cancel"}],"action":{"kind":"tool-call","callId":"call_9","toolName":"shell",\
        "input":{"argv":["rm","-rf","/tmp/x"]}}}]}}
        """)
        guard case .inputRequested(_, let requests) = event, let request = requests.first else {
            return XCTFail("expected input.requested, got \(event)")
        }
        XCTAssertEqual(request.kind, "tool-approval")
        XCTAssertFalse(request.isQuestion)
        XCTAssertEqual(request.options.map(\.id), ["approve", "cancel"])
        // Eve marks the destructive answer; approving is the dangerous one here.
        XCTAssertTrue(request.options[0].isDestructive)
        XCTAssertFalse(request.options[1].isDestructive)
        XCTAssertEqual(request.approvalStep?.name, "shell")
        XCTAssertEqual(request.approvalStep?.summary, "rm -rf /tmp/x")
    }

    func testTurnBoundaries() throws {
        let waiting = try EveStreamEventParser.parse(line: """
        {"type":"session.waiting","data":{"continuationToken":"s_1","wait":"next-user-message"}}
        """)
        XCTAssertEqual(waiting, .sessionWaiting)
        XCTAssertTrue(waiting.isTurnBoundary)

        let started = try EveStreamEventParser.parse(line: #"{"type":"turn.started","data":{"turnId":"turn_0"}}"#)
        XCTAssertFalse(started.isTurnBoundary)
    }

    /// A newer agent must not break an older phone.
    func testUnknownEventTypeDegradesToOther() throws {
        let event = try EveStreamEventParser.parse(line: """
        {"type":"reasoning.appended","data":{"turnId":"turn_0","reasoningSoFar":"…"}}
        """)
        XCTAssertEqual(event, .other(type: "reasoning.appended"))
    }

    func testMalformedLineThrows() {
        XCTAssertThrowsError(try EveStreamEventParser.parse(line: "{not json"))
        XCTAssertThrowsError(try EveStreamEventParser.parse(line: #"{"data":{}}"#)) { error in
            XCTAssertEqual(error as? EveError, .malformedEvent(#"{"data":{}}"#))
        }
    }
}

// MARK: - Reducer

final class AgentTranscriptTests: XCTestCase {
    /// `message.appended` carries the whole message so far, so a stream of them
    /// has to upsert one part — concatenating would repeat the reply per token.
    func testCumulativeDeltasProduceOneTextPart() {
        var transcript = AgentTranscript()
        transcript.apply(.turnStarted(turnId: "turn_0"))
        for soFar in ["Open", "Opening", "Opening Safari"] {
            transcript.apply(.messageAppended(turnId: "turn_0", stepIndex: 0, messageSoFar: soFar))
        }

        XCTAssertEqual(transcript.messages.count, 1)
        XCTAssertEqual(transcript.messages[0].role, .assistant)
        XCTAssertEqual(
            transcript.messages[0].parts,
            [.text(id: "text-turn_0-0", text: "Opening Safari", isStreaming: true)]
        )

        transcript.apply(
            .messageCompleted(turnId: "turn_0", stepIndex: 0, message: nil, finishReason: "stop")
        )
        XCTAssertEqual(
            transcript.messages[0].parts,
            [.text(id: "text-turn_0-0", text: "Opening Safari", isStreaming: false)]
        )
    }

    func testToolCallGoesFromRunningToCompleted() {
        var transcript = AgentTranscript()
        transcript.apply(
            .actionsRequested(
                turnId: "turn_0",
                stepIndex: 0,
                actions: [
                    EveActionRequest(
                        callId: "call_1",
                        kind: "tool-call",
                        name: "computer",
                        input: ["actions": .list(["click"])]
                    ),
                ]
            )
        )
        XCTAssertEqual(
            transcript.messages.first?.parts.first,
            .toolCall(id: "call_1", name: "computer", input: ["actions": .list(["click"])], status: .running)
        )

        let screenshot = EveFile(mediaType: "image/png", bytes: Data("png".utf8))
        transcript.apply(
            .actionResult(
                turnId: "turn_0",
                callId: "call_1",
                status: "completed",
                errorMessage: nil,
                files: [screenshot]
            )
        )
        XCTAssertEqual(
            transcript.messages.first?.parts,
            [
                // The arguments survive the transition: dropping them would
                // blank the step label the moment the call finished.
                .toolCall(
                    id: "call_1",
                    name: "computer",
                    input: ["actions": .list(["click"])],
                    status: .completed
                ),
                .file(id: "file-call_1-0", file: screenshot),
            ]
        )
    }

    func testRepeatedEventsAreIdempotent() {
        var live = AgentTranscript()
        var replayed = AgentTranscript()
        let events: [EveStreamEvent] = [
            .messageReceived(turnId: "turn_0", sequence: 0, message: "hello", files: []),
            .actionsRequested(
                turnId: "turn_0",
                stepIndex: 0,
                actions: [EveActionRequest(callId: "call_1", kind: "tool-call", name: "shell")]
            ),
            .actionResult(turnId: "turn_0", callId: "call_1", status: "failed", errorMessage: "boom", files: []),
            .messageAppended(turnId: "turn_0", stepIndex: 1, messageSoFar: "done"),
            .sessionWaiting,
        ]
        for event in events { live.apply(event) }
        // A replay from index 0 re-applies the same events; ids are derived from
        // the wire, so it has to land on the same transcript.
        for event in events + events { replayed.apply(event) }

        XCTAssertEqual(live.messages, replayed.messages)
        XCTAssertTrue(live.isSettled)
    }

    func testServerEchoReplacesTheOptimisticUserMessage() {
        var transcript = AgentTranscript()
        transcript.appendOptimisticUserMessage("take a screenshot")
        XCTAssertEqual(transcript.messages.count, 1)
        XCTAssertTrue(transcript.messages[0].isOptimistic)

        transcript.apply(.messageReceived(turnId: "turn_0", sequence: 0, message: "take a screenshot", files: []))
        XCTAssertEqual(transcript.messages.count, 1)
        XCTAssertEqual(transcript.messages[0].id, "user-turn_0-0")
        XCTAssertFalse(transcript.messages[0].isOptimistic)
    }

    func testTurnFailureIsSurfacedAndStreamingStops() {
        var transcript = AgentTranscript()
        transcript.apply(.messageAppended(turnId: "turn_0", stepIndex: 0, messageSoFar: "half"))
        transcript.apply(.turnFailed(turnId: "turn_0", code: "model_error", message: "The agent stalled."))

        XCTAssertEqual(transcript.failureMessage, "The agent stalled.")
        XCTAssertEqual(
            transcript.messages[0].parts,
            [.text(id: "text-turn_0-0", text: "half", isStreaming: false)]
        )
    }

    /// Consecutive tool calls collapse into one group; text breaks the run.
    func testConsecutiveToolCallsGroup() {
        let parts: [AgentMessagePart] = [
            .toolCall(id: "a", name: "computer", input: [:], status: .completed),
            .toolCall(id: "b", name: "computer", input: [:], status: .running),
            .text(id: "t", text: "Done.", isStreaming: false),
            .toolCall(id: "c", name: "shell", input: [:], status: .running),
        ]
        let rendered = AgentRenderedPart.grouping(parts)
        XCTAssertEqual(rendered.count, 3)
        guard case .toolSteps(_, let first) = rendered[0], case .toolSteps(_, let last) = rendered[2] else {
            return XCTFail("expected the runs to group, got \(rendered)")
        }
        XCTAssertEqual(first.map(\.id), ["a", "b"])
        XCTAssertEqual(last.map(\.id), ["c"])
    }

    func testStepLabelNamesTheCallItIsAbout() {
        let running = AgentToolStep(
            id: "call_1",
            name: "read_file",
            input: ["path": .string("/etc/hosts")],
            status: .running
        )
        XCTAssertEqual(running.label, "read file · /etc/hosts")

        let failed = AgentToolStep(id: "call_2", name: "shell", status: .failed("exit 1"))
        XCTAssertEqual(failed.label, "Failed: shell")

        let declined = AgentToolStep(id: "call_3", name: "shell", status: .rejected)
        XCTAssertEqual(declined.label, "Declined: shell")
    }
}

// MARK: - Cursor

final class EveCursorStoreTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "EveCursorStoreTests")!
        EveCursorStore.clear(defaults)
    }

    func testRoundTripsAndClearsWithoutASession() {
        XCTAssertEqual(EveCursorStore.load(defaults), .initial)

        EveCursorStore.save(EveSessionCursor(sessionId: "sess_1", streamIndex: 7), to: defaults)
        XCTAssertEqual(
            EveCursorStore.load(defaults),
            EveSessionCursor(sessionId: "sess_1", streamIndex: 7)
        )

        // A session that ended terminally resets to `.initial`; persisting that
        // has to forget the old id rather than keep resuming a dead session.
        EveCursorStore.save(.initial, to: defaults)
        XCTAssertEqual(EveCursorStore.load(defaults), .initial)
    }
}
