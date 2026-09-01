import SwiftUI
import UIKit

/// One chat message: a right-aligned bubble for the user, and lead-aligned text
/// plus a collapsible chain of tool steps for the agent.
struct AgentMessageView: View {
    let message: AgentChatMessage

    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            assistantContent
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            Text(combinedText)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.2))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .opacity(message.isOptimistic ? 0.6 : 1)
        }
    }

    private var combinedText: String {
        message.parts
            .compactMap { if case .text(_, let text, _) = $0 { return text } else { return nil } }
            .joined(separator: "\n")
    }

    private var assistantContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(AgentRenderedPart.grouping(message.parts)) { part in
                switch part {
                case .text(_, let text):
                    AgentMarkdownText(text: text)
                case .file(_, let file):
                    AgentFileView(file: file)
                case .toolSteps(_, let steps):
                    AgentToolStepsView(steps: steps)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Text

/// Inline markdown while it streams: `.inlineOnlyPreservingWhitespace` renders
/// bold, links and inline code without swallowing the newlines, and a half-typed
/// document that fails to parse falls back to plain text rather than blanking.
struct AgentMarkdownText: View {
    let text: String

    var body: some View {
        markdown
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var markdown: Text {
        if let attributed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) {
            return Text(attributed)
        }
        return Text(text)
    }
}

// MARK: - Files

/// A file on a message. The computer tool's screenshots arrive as bytes on the
/// tool result, a user attachment as a URL; anything that is not an image, or an
/// image that will not load, falls back to naming itself.
struct AgentFileView: View {
    let file: EveFile

    var body: some View {
        if file.isImage, let image = file.bytes.flatMap(UIImage.init(data:)) {
            frame(Image(uiImage: image))
        } else if file.isImage, let url = file.url.flatMap(URL.init(string:)) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image): frame(image)
                case .failure: chip
                default: ProgressView().frame(height: 80)
                }
            }
        } else {
            chip
        }
    }

    private func frame(_ image: Image) -> some View {
        image
            .resizable()
            .scaledToFit()
            .frame(maxHeight: 260)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.secondary.opacity(0.25))
            )
            .accessibilityLabel(file.filename ?? "Screenshot of the computer")
    }

    private var chip: some View {
        Label(file.filename ?? file.mediaType, systemImage: "doc")
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.secondary.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - Tool steps

/// A run of agent actions as one collapsible chain, closed by default: on a
/// phone the steps are context for the reply, not the reply.
struct AgentToolStepsView: View {
    let steps: [AgentToolStep]

    @State private var isExpanded = false

    private var isRunning: Bool { steps.contains(where: \.isRunning) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Text(headline)
                        .font(.footnote.weight(.medium))
                    if isRunning {
                        ProgressView().controlSize(.mini)
                    }
                }
                .foregroundStyle(.secondary)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isExpanded ? "Hide the agent's steps" : "Show the agent's steps")

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(steps) { step in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: step.systemImage)
                                .font(.caption)
                                .frame(width: 16)
                            Text(step.isRunning ? "\(step.label)…" : step.label)
                                .font(.footnote)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(step.isRunning ? Color.secondary : Color.primary)
                    }
                }
                .padding(.leading, 4)
                .padding(.top, 4)
            }
        }
        .animation(.easeOut(duration: 0.2), value: isExpanded)
    }

    /// Collapsed, the chain still says what it is doing — the running step, or
    /// how much work it did.
    private var headline: String {
        if let running = steps.first(where: \.isRunning) {
            return running.label
        }
        return steps.count == 1 ? steps[0].label : "\(steps.count) steps"
    }
}

// MARK: - Human-in-the-loop

/// One request for input, routed on `kind`. An approval and a question arrive on
/// the same protocol and are told apart only here: the approval policy parks a
/// call exactly when it is about to touch the box, so a card that says "Approve"
/// and nothing else is shown at the moment someone most needs to know what they
/// are agreeing to.
struct AgentInputRequestCard: View {
    let request: EveInputRequest
    let onAnswer: (EveInputResponse) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let step = request.approvalStep {
                // The same formatter the steps use, so a tool is named the same
                // whether it ran or asked first.
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: step.systemImage)
                        .font(.caption)
                    Text(step.displayName)
                        .font(.subheadline.weight(.semibold))
                    if let summary = step.summary {
                        Text(summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }

            Text(request.prompt)
                .font(request.isQuestion ? .body.weight(.semibold) : .subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(request.options) { option in
                Button(role: option.isDestructive ? .destructive : nil) {
                    onAnswer(EveInputResponse(requestId: request.requestId, optionId: option.id))
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.label)
                        if let detail = option.detail {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }

            if request.allowFreeform {
                Text("Or type a reply below.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.25))
        )
    }
}
