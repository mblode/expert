import SwiftUI

struct ComputerView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var seat = SeatController()
    @State private var showClipboard = false
    @State private var showKeyboard = false
    @State private var typed = ""
    @State private var showMenu = false
    @State private var showNewBot = false
    @State private var newBotId = ""
    @State private var newBotError: String?
    @State private var newBot: ComputerV1.BotCredentials?
    @State private var tokenCopied = false
    @State private var confirmTokenClose = false
    @State private var confirmClose = false

    /// The agent is driving this screen: every gesture would be refused, and
    /// closing is the only thing here that is still safe to do.
    private var agentHoldsSeat: Bool { model.currentScreen?.state == .agent }

    var body: some View {
        VStack(spacing: 0) {
            if model.waiting || model.status?.state == .waiting {
                WaitingBanner()
            }
            GeometryReader { geo in
                ZStack {
                    if let url = vncURL {
                        VncView(url: url, reloadToken: model.vncReload) { message in
                            model.reportDesktopFailure(message)
                        }
                        .allowsHitTesting(false)
                    } else {
                        Color.black
                    }
                    DesktopGestures(seat: seat, enabled: !seat.trackpad && !agentHoldsSeat)
                        .opacity(seat.trackpad ? 0 : 1)
                    if seat.trackpad {
                        TrackpadView(seat: seat, enabled: !agentHoldsSeat)
                    }
                    if let c = seat.cursor {
                        Circle()
                            .fill(Color.white.opacity(0.85))
                            .frame(width: 10, height: 10)
                            .position(CoordinateMap.viewPoint(from: (c.x, c.y), in: CGRect(origin: .zero, size: geo.size)))
                            .allowsHitTesting(false)
                    }
                    // Over the pixels, because the failure this reports is that
                    // there are none — the black underneath explains nothing.
                    VStack {
                        HStack {
                            closeButton
                            Spacer()
                            // The ••• that exits trackpad mode is in the bottom
                            // bar, so the badge cannot cover its own way out.
                            if seat.trackpad {
                                Label("Trackpad", systemImage: "hand.point.up.left.fill")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(.ultraThinMaterial, in: Capsule())
                                    .accessibilityLabel("Trackpad mode is on")
                            }
                        }
                        .padding(8)
                        if let failure = model.reach.failure {
                            UnreachableBanner(message: failure.message, retryable: failure.retryable) {
                                Task { await model.retry() }
                            }
                        }
                        if let failure = model.seatFailure {
                            UnreachableBanner(message: seatFailureMessage(failure), retryable: true) {
                                Task { await model.retrySeatChange() }
                            }
                        }
                        Spacer()
                        // One calm statement instead of a refusal per tap: the
                        // gesture layers are off above, so nothing else says it.
                        if agentHoldsSeat {
                            Label("The agent is driving. Take the seat to use this screen.", systemImage: "hand.raised.fill")
                                .font(.footnote.weight(.medium))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background(.ultraThinMaterial)
                        } else if let error = seat.error {
                            SeatErrorBanner(message: error) { seat.error = nil }
                        }
                    }
                }
            }
            bottomBar
        }
        .background(Color.black)
        .task {
            await model.refreshStatus()
            if let client = model.client {
                seat.attach(client)
                syncScreen()
            }
        }
        .onChange(of: model.selectedScreen) {
            syncScreen()
        }
        .sheet(isPresented: $showClipboard) {
            if let client = model.client {
                ClipboardSheet(client: client, display: seat.display)
            }
        }
        .sheet(isPresented: $showKeyboard) {
            NavigationStack {
                TextField("Type into the focused field", text: $typed, axis: .vertical)
                    .padding()
                    .navigationTitle("Keyboard")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Send") {
                                let t = typed
                                typed = ""
                                showKeyboard = false
                                Task { await seat.type(t) }
                            }
                        }
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { showKeyboard = false }
                        }
                    }
            }
            .presentationDetents([.medium])
        }
        .sheet(isPresented: .init(get: { newBot != nil }, set: { if !$0 { newBot = nil } })) {
            if let bot = newBot {
                newBotTokenSheet(bot)
            }
        }
        .alert("Couldn’t create the Bot", isPresented: .init(get: { newBotError != nil }, set: { if !$0 { newBotError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(newBotError ?? "")
        }
    }

    /// Closing is navigation and never a seat change, so it is always offered —
    /// otherwise the only way out while the agent drives is to take the seat.
    private var closeButton: some View {
        Button {
            if agentHoldsSeat { dismiss() } else { confirmClose = true }
        } label: {
            Image(systemName: "xmark")
                .font(.body.weight(.semibold))
                .padding(10)
                .background(.ultraThinMaterial, in: Circle())
        }
        .accessibilityLabel("Close the computer")
        .confirmationDialog("You still have the seat", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Close and keep the seat") { dismiss() }
            Button("Hand the seat back and close") {
                Task { if await model.imDone() { dismiss() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Closing leaves the agent blocked until you hand the seat back.")
        }
    }

    private func seatFailureMessage(_ failure: AppModel.SeatFailure) -> String {
        failure.present
            ? "You do not have the seat: \(failure.message)"
            : "You still have the seat — the hand-back failed: \(failure.message)"
    }

    /// The hub mints this token once and cannot show it again, so it gets a
    /// sheet that has to be answered rather than a message you can swipe off.
    private func newBotTokenSheet(_ bot: ComputerV1.BotCredentials) -> some View {
        NavigationStack {
            Form {
                Section("Token") {
                    Text(bot.token)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = bot.token
                        tokenCopied = true
                    } label: {
                        Label(tokenCopied ? "Copied" : "Copy token",
                              systemImage: tokenCopied ? "checkmark" : "doc.on.doc")
                    }
                }
                Section {
                    LabeledContent("Bot", value: bot.id)
                    LabeledContent("Screen", value: "\(bot.display)")
                } footer: {
                    Text("Shown once. Losing it means creating the Bot again.")
                }
            }
            .navigationTitle("\(bot.id) is live")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if tokenCopied { newBot = nil } else { confirmTokenClose = true }
                    }
                }
            }
            .confirmationDialog("Close without the token?", isPresented: $confirmTokenClose, titleVisibility: .visible) {
                Button("Close anyway", role: .destructive) { newBot = nil }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("It is not stored anywhere and cannot be shown again.")
            }
        }
        .interactiveDismissDisabled()
    }

    /// Point the seat at the selected Bot's screen (nil selection = primary).
    private func syncScreen() {
        if let screen = model.currentScreen {
            seat.display = screen.display == 1 ? nil : screen.display
            seat.vncURL = URL(string: screen.vncUrl)
        } else if let s = model.status {
            seat.display = nil
            seat.vncURL = URL(string: s.vncUrl)
        }
    }

    private var vncURL: URL? {
        seat.vncURL ?? model.status.flatMap { URL(string: $0.vncUrl) }
    }

    private var bottomBar: some View {
        HStack(spacing: 16) {
            Button { showKeyboard = true } label: {
                Label("Keyboard", systemImage: "keyboard")
            }
            Button { showClipboard = true } label: {
                Label("Clipboard", systemImage: "doc.on.clipboard")
            }
            Menu {
                Button(seat.trackpad ? "Exit trackpad" : "Trackpad mode") {
                    seat.trackpad.toggle()
                }
                Button("Recenter pointer") { Task { await seat.recenter() } }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            Menu {
                ForEach(model.screens) { screen in
                    Button {
                        model.selectScreen(screen)
                    } label: {
                        if screen.display == model.currentScreen?.display {
                            Label(screen.botId, systemImage: "checkmark")
                        } else {
                            Text(screen.botId)
                        }
                    }
                }
                Divider()
                Button {
                    showNewBot = true
                } label: {
                    Label("New Bot…", systemImage: "plus")
                }
            } label: {
                Label("Screen", systemImage: "rectangle.on.rectangle")
            }
            .alert("New Bot", isPresented: $showNewBot) {
                TextField("name, e.g. night", text: $newBotId)
                    .textInputAutocapitalization(.never)
                Button("Create") {
                    let id = newBotId.trimmingCharacters(in: .whitespaces)
                    newBotId = ""
                    Task {
                        do {
                            tokenCopied = false
                            newBot = try await model.createBot(id: id)
                        } catch {
                            newBotError = error.localizedDescription
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Gets its own screen on the shared box.")
            }
            Spacer()
            // While the agent holds the seat every gesture here is refused, so
            // the bar offers the way in rather than looking broken.
            if agentHoldsSeat {
                Button {
                    Task { await model.takeSeat() }
                } label: {
                    Text("Take the seat")
                        .fontWeight(.semibold)
                }
                .buttonStyle(.bordered)
            } else {
                // Only a hand-back that the box confirmed closes the screen.
                Button {
                    Task { if await model.imDone() { dismiss() } }
                } label: {
                    Text("I’m done")
                        .fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }
}

@MainActor
final class SeatController: ObservableObject {
    @Published var trackpad = false
    @Published var error: String?
    @Published var cursor: ComputerV1.Point?
    @Published var vncURL: URL?
    /// Window index of the screen being driven. Nil = primary.
    @Published var display: Int?
    private var client: ComputerClient?

    func attach(_ client: ComputerClient) {
        self.client = client
        cursor = ComputerV1.Point(x: 640, y: 400)
    }

    func move(dx: Int, dy: Int, grab: Bool = false) async {
        guard let client else { return }
        // Move the drawn cursor now and reconcile with the box afterwards.
        // Waiting for the round trip to paint it is what makes a remote
        // desktop feel broken: your finger is here and the pointer is behind.
        if let at = cursor {
            cursor = ComputerV1.Point(
                x: min(max(at.x + dx, 0), ComputerV1.display.width - 1),
                y: min(max(at.y + dy, 0), ComputerV1.display.height - 1)
            )
        }
        await perform { try await client.pointer(.move(dx: dx, dy: dy, grab: grab, display: self.display)) }
    }

    func click(button: String = "left") async {
        guard let client else { return }
        await perform { try await client.pointer(.click(button: button, display: self.display)) }
    }

    func tapDesktop(x: Int, y: Int) async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: x - cur.x, dy: y - cur.y)
        await click()
    }

    func dragTo(x: Int, y: Int) async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: x - cur.x, dy: y - cur.y, grab: true)
    }

    func scroll(dx: Int, dy: Int) async {
        guard let client else { return }
        await perform { try await client.pointer(.scroll(dx: dx, dy: dy, display: self.display)) }
    }

    func type(_ text: String) async {
        guard let client else { return }
        await perform { try await client.type(text, display: self.display) }
    }

    func recenter() async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: 640 - cur.x, dy: 400 - cur.y)
    }

    /// SEAT_HELD and OUT_OF_BOUNDS are the two things the seat says most, and
    /// dropping them leaves a screen that ignores every gesture with no reason
    /// given. Success clears the last one. A pan refused while the agent holds
    /// the seat lands here at gesture rate, so only a change is published.
    private func perform(_ call: () async throws -> ComputerV1.PointerResponse) async {
        do {
            cursor = try await call().cursor
            if error != nil { error = nil }
        } catch {
            let message = error.localizedDescription
            if self.error != message { self.error = message }
        }
    }
}
