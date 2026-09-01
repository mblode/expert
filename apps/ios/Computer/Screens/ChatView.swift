import SwiftUI

struct ChatView: View {
    @EnvironmentObject var model: AppModel
    @State private var draft = ""
    @State private var showComputer = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if model.waiting {
                    WaitingBanner()
                }
                if let failure = model.reach.failure {
                    UnreachableBanner(message: failure.message, retryable: failure.retryable) {
                        Task { await model.retry() }
                    }
                }
                transcript
                composer
            }
            .navigationTitle("Chat")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Unpair") { model.unpair() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Open computer") { showComputer = true }
                }
            }
            .fullScreenCover(isPresented: $showComputer) {
                ComputerView()
                    .environmentObject(model)
            }
            .task { await model.refreshStatus() }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if model.restoring {
                        ProgressView("Catching up on this conversation")
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(model.messages) { message in
                        AgentMessageView(message: message)
                            .id(message.id)
                    }
                    if model.isThinking {
                        Label("Thinking", systemImage: "ellipsis")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    // Answering resumes the parked turn, so the card only shows
                    // while nothing else is in flight.
                    if let request = model.pendingInputRequests.first, !model.isBusy {
                        AgentInputRequestCard(request: request) { response in
                            model.answer(response)
                        }
                    }
                    if let error = model.turnError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    Color.clear.frame(height: 1).id(Self.bottomAnchor)
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages) { _, _ in
                withAnimation { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
            }
        }
    }

    private static let bottomAnchor = "bottom"

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
            if model.isBusy {
                Button {
                    model.stop()
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Stop the agent")
            } else {
                Button {
                    let text = draft
                    draft = ""
                    model.send(text)
                } label: {
                    Label("Send", systemImage: "arrow.up")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
        }
        .padding()
    }
}

struct WaitingBanner: View {
    var body: some View {
        Text("The agent is waiting. Open Computer, then tap I’m done.")
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(10)
            .background(Color.orange.opacity(0.9))
            .foregroundStyle(.black)
    }
}

/// The box did not answer. Said out loud with a way back, because the
/// alternative is a stale status behind pixels that never arrive.
struct UnreachableBanner: View {
    let message: String
    let retryable: Bool
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
            if retryable {
                Button("Retry", action: retry)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
            }
        }
        .padding(10)
        .background(Color.red.opacity(0.9))
        .foregroundStyle(.white)
    }
}

/// A refused pointer or keystroke — SEAT_HELD while the agent is driving,
/// OUT_OF_BOUNDS off the edge of the desktop. Tap to dismiss.
struct SeatErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        Button(action: dismiss) {
            Label(message, systemImage: "hand.raised.fill")
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.ultraThinMaterial)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Dismiss")
    }
}
