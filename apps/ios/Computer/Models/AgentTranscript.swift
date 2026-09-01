import Foundation

// MARK: - Transcript model

struct AgentChatMessage: Identifiable, Equatable {
    enum Role: Equatable {
        case user
        case assistant
    }

    let id: String
    let role: Role
    var parts: [AgentMessagePart]
    var isOptimistic = false

    /// A message shows something once it has text, a file or a tool marker.
    /// Until then the turn is still thinking.
    var hasVisibleContent: Bool {
        parts.contains { part in
            switch part {
            case .text(_, let text, _): return !text.isEmpty
            case .file, .toolCall: return true
            }
        }
    }
}

enum AgentToolStatus: Equatable {
    case running
    case completed
    case failed(String?)
    case rejected
}

/// A message is a list of parts, not a string: one assistant turn interleaves
/// prose, tool calls and the screenshots those calls came back with, and the
/// order they arrived in is the order they have to render in.
enum AgentMessagePart: Identifiable, Equatable {
    case text(id: String, text: String, isStreaming: Bool)
    case file(id: String, file: EveFile)
    case toolCall(id: String, name: String, input: [String: EveToolArgument], status: AgentToolStatus)

    var id: String {
        switch self {
        case .text(let id, _, _): return id
        case .file(let id, _): return id
        case .toolCall(let id, _, _, _): return id
        }
    }
}

// MARK: - Reducer

/// Pure reducer folding Eve stream events into a renderable transcript.
///
/// Every id it mints is derived from the wire (`turnId`, `stepIndex`, `callId`),
/// so applying the same events twice lands on the same transcript. That is what
/// lets one reducer serve both the live stream and a replay from index 0.
struct AgentTranscript: Equatable {
    private(set) var messages: [AgentChatMessage] = []
    private(set) var pendingInputRequests: [EveInputRequest] = []
    private(set) var failureMessage: String?
    private(set) var isSettled = false
    private var optimisticCount = 0

    /// Shows the user's message straight away; reconciled with the server-echoed
    /// `message.received` when it arrives.
    mutating func appendOptimisticUserMessage(_ text: String) {
        optimisticCount += 1
        let id = "optimistic-\(optimisticCount)"
        messages.append(
            AgentChatMessage(
                id: id,
                role: .user,
                parts: [.text(id: "\(id)-text", text: text, isStreaming: false)],
                isOptimistic: true
            )
        )
        failureMessage = nil
    }

    mutating func clearPendingInputRequests() {
        pendingInputRequests = []
    }

    mutating func apply(_ event: EveStreamEvent) {
        switch event {
        case .messageReceived(let turnId, let sequence, let message, let files):
            pendingInputRequests = []
            let id = "user-\(turnId)-\(sequence)"
            var parts: [AgentMessagePart] = [
                .text(id: "\(id)-text", text: message, isStreaming: false),
            ]
            for (index, file) in files.enumerated() {
                parts.append(.file(id: "\(id)-file-\(index)", file: file))
            }
            let confirmed = AgentChatMessage(id: id, role: .user, parts: parts)
            if let index = messages.firstIndex(where: { $0.id == id }) {
                messages[index] = confirmed
            } else if let index = messages.lastIndex(where: { $0.isOptimistic }) {
                // The echo of what was just sent: replace the local copy rather
                // than showing the message twice.
                messages[index] = confirmed
            } else {
                messages.append(confirmed)
            }

        case .messageAppended(let turnId, let stepIndex, let messageSoFar):
            // Cumulative text, so this replaces the part rather than appending
            // to it. Concatenating here would repeat the whole reply per token.
            upsertText(turnId: turnId, stepIndex: stepIndex, text: messageSoFar, isStreaming: true)

        case .messageCompleted(let turnId, let stepIndex, let message, _):
            if let message, !message.isEmpty {
                upsertText(turnId: turnId, stepIndex: stepIndex, text: message, isStreaming: false)
            } else {
                finishText(turnId: turnId, stepIndex: stepIndex)
            }

        case .actionsRequested(let turnId, _, let actions):
            for action in actions {
                appendToolPart(
                    turnId: turnId,
                    partId: action.callId,
                    name: action.name,
                    input: action.input
                )
            }

        case .actionResult(let turnId, let callId, let status, let errorMessage, let files):
            guard let callId else { return }
            let toolStatus: AgentToolStatus
            switch status {
            case "failed": toolStatus = .failed(errorMessage)
            case "rejected": toolStatus = .rejected
            default: toolStatus = .completed
            }
            updateToolPart(partId: callId, status: toolStatus)
            for (index, file) in files.enumerated() {
                appendFilePart(turnId: turnId, partId: "file-\(callId)-\(index)", file: file)
            }

        case .inputRequested(_, let requests):
            pendingInputRequests = requests

        case .turnFailed(_, _, let message), .stepFailed(_, _, let message):
            failureMessage = message
            finishStreamingParts()

        case .sessionFailed(_, let message):
            failureMessage = message
            isSettled = true
            finishStreamingParts()

        case .sessionWaiting, .sessionCompleted:
            isSettled = true
            finishStreamingParts()

        case .sessionStarted, .turnStarted, .turnCompleted, .other:
            break
        }
    }

    // MARK: Private helpers

    private mutating func ensureAssistantMessage(turnId: String) -> Int {
        let id = "assistant-\(turnId)"
        if let index = messages.firstIndex(where: { $0.id == id }) {
            return index
        }
        messages.append(AgentChatMessage(id: id, role: .assistant, parts: []))
        return messages.count - 1
    }

    private mutating func upsertText(turnId: String, stepIndex: Int, text: String, isStreaming: Bool) {
        let messageIndex = ensureAssistantMessage(turnId: turnId)
        let partId = "text-\(turnId)-\(stepIndex)"
        let part = AgentMessagePart.text(id: partId, text: text, isStreaming: isStreaming)
        if let partIndex = messages[messageIndex].parts.firstIndex(where: { $0.id == partId }) {
            messages[messageIndex].parts[partIndex] = part
        } else {
            messages[messageIndex].parts.append(part)
        }
    }

    private mutating func finishText(turnId: String, stepIndex: Int) {
        let partId = "text-\(turnId)-\(stepIndex)"
        guard let messageIndex = messages.firstIndex(where: { $0.id == "assistant-\(turnId)" }),
              let partIndex = messages[messageIndex].parts.firstIndex(where: { $0.id == partId }),
              case .text(_, let text, _) = messages[messageIndex].parts[partIndex] else {
            return
        }
        messages[messageIndex].parts[partIndex] = .text(id: partId, text: text, isStreaming: false)
    }

    private mutating func appendToolPart(
        turnId: String,
        partId: String,
        name: String,
        input: [String: EveToolArgument]
    ) {
        let messageIndex = ensureAssistantMessage(turnId: turnId)
        guard !messages[messageIndex].parts.contains(where: { $0.id == partId }) else { return }
        messages[messageIndex].parts.append(
            .toolCall(id: partId, name: name, input: input, status: .running)
        )
    }

    private mutating func appendFilePart(turnId: String, partId: String, file: EveFile) {
        let messageIndex = ensureAssistantMessage(turnId: turnId)
        guard !messages[messageIndex].parts.contains(where: { $0.id == partId }) else { return }
        messages[messageIndex].parts.append(.file(id: partId, file: file))
    }

    /// Carries the arguments forward: only the status changes when a call
    /// resolves, and dropping them here would blank the label mid-turn.
    private mutating func updateToolPart(partId: String, status: AgentToolStatus) {
        for messageIndex in messages.indices.reversed() {
            if let partIndex = messages[messageIndex].parts.firstIndex(where: { $0.id == partId }),
               case .toolCall(_, let name, let input, _) = messages[messageIndex].parts[partIndex] {
                messages[messageIndex].parts[partIndex] = .toolCall(
                    id: partId,
                    name: name,
                    input: input,
                    status: status
                )
                return
            }
        }
    }

    private mutating func finishStreamingParts() {
        for messageIndex in messages.indices {
            for partIndex in messages[messageIndex].parts.indices {
                if case .text(let id, let text, true) = messages[messageIndex].parts[partIndex] {
                    messages[messageIndex].parts[partIndex] = .text(id: id, text: text, isStreaming: false)
                }
            }
        }
    }
}

// MARK: - Presentation

/// One agent action as the transcript presents it.
struct AgentToolStep: Identifiable, Equatable {
    let id: String
    let name: String
    let input: [String: EveToolArgument]
    let status: AgentToolStatus

    init(id: String, name: String, input: [String: EveToolArgument] = [:], status: AgentToolStatus) {
        self.id = id
        self.name = name
        self.input = input
        self.status = status
    }

    /// The arguments worth showing beside a tool name, most identifying first.
    /// A turn calls `computer` over and over, and without these the steps render
    /// as identical rows that read as one duplicated call.
    ///
    /// Plumbing (`request_id`, `display`, `timeout_sec`) is deliberately absent:
    /// an idempotency key disambiguates nothing a reader can act on.
    private static let summaryKeys = ["actions", "argv", "path", "command", "query", "text", "url"]
    private static let maxSummaryValue = 28

    var displayName: String {
        name.replacingOccurrences(of: "_", with: " ")
    }

    /// What identifies this particular call, or nil when nothing does — a bare
    /// name beats an invented summary.
    var summary: String? {
        for key in Self.summaryKeys {
            guard let value = input[key] else { continue }
            let text = value.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            return text.count > Self.maxSummaryValue
                ? "\(text.prefix(Self.maxSummaryValue - 1))…"
                : text
        }
        return nil
    }

    private var summarizedName: String {
        guard let summary else { return displayName }
        return "\(displayName) · \(summary)"
    }

    /// Failures are marked in the label rather than printed in full: the server
    /// messages run long, and the model usually recovers on the next step.
    var label: String {
        switch status {
        case .running, .completed:
            return summarizedName
        case .failed:
            return "Failed: \(summarizedName)"
        case .rejected:
            // A declined approval has to read as "did not run"; the bare name
            // would read as if it had.
            return "Declined: \(summarizedName)"
        }
    }

    var isRunning: Bool { status == .running }

    var systemImage: String {
        switch name {
        case "computer": return "display"
        case "shell": return "terminal"
        case "read_file": return "doc.text"
        case "write_file": return "square.and.pencil"
        case "ask_question": return "questionmark.circle"
        default: return "bolt"
        }
    }
}

/// A message's parts as the transcript renders them: a run of consecutive tool
/// calls collapses into one group, so a multi-step turn reads as one chain of
/// actions instead of a column of loose rows.
enum AgentRenderedPart: Identifiable, Equatable {
    case text(id: String, text: String)
    case file(id: String, file: EveFile)
    case toolSteps(id: String, steps: [AgentToolStep])

    var id: String {
        switch self {
        case .text(let id, _), .file(let id, _), .toolSteps(let id, _): return id
        }
    }

    /// Empty text parts are dropped: a step that only called tools still emits
    /// one, and rendering it would open a gap above the group.
    static func grouping(_ parts: [AgentMessagePart]) -> [AgentRenderedPart] {
        var rendered: [AgentRenderedPart] = []
        for part in parts {
            switch part {
            case .text(let id, let text, _):
                if !text.isEmpty { rendered.append(.text(id: id, text: text)) }

            case .file(let id, let file):
                rendered.append(.file(id: id, file: file))

            case .toolCall(let id, let name, let input, let status):
                let step = AgentToolStep(id: id, name: name, input: input, status: status)
                if case .toolSteps(let groupId, let steps)? = rendered.last {
                    rendered[rendered.count - 1] = .toolSteps(id: groupId, steps: steps + [step])
                } else {
                    rendered.append(.toolSteps(id: "steps-\(id)", steps: [step]))
                }
            }
        }
        return rendered
    }
}

extension EveInputOption {
    /// Eve marks the destructive choice itself, and the client must never infer
    /// it from the option id: on a `tool-approval` the dangerous answer is
    /// "approve", while on a `session-limit` it is the one that ends the session.
    var isDestructive: Bool { style == "danger" }
}

extension EveInputRequest {
    /// A plain question keeps the question card; an approval and a session limit
    /// get the confirmation card, which names what is about to run.
    var isQuestion: Bool { kind == "question" }

    /// The call this approval is about, or nil when there is nothing to name.
    var approvalStep: AgentToolStep? {
        guard kind == "tool-approval", let action else { return nil }
        return AgentToolStep(
            id: action.callId,
            name: action.toolName,
            input: action.input,
            status: .running
        )
    }
}
