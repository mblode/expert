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
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.messages) { msg in
                            Text(msg.text)
                                .padding(10)
                                .background(msg.role == .user ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .frame(maxWidth: .infinity, alignment: msg.role == .user ? .trailing : .leading)
                        }
                    }
                    .padding()
                }
                HStack {
                    TextField("Message", text: $draft, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                    Button("Send") {
                        let t = draft
                        draft = ""
                        Task { await model.sendChat(t) }
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding()
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
