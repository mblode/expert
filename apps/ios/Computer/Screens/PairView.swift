import SwiftUI

struct PairView: View {
    @EnvironmentObject var model: AppModel
    @State private var host = ""
    @State private var code = ""
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Hub") {
                    TextField("https://computer.tailnet.ts.net", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Setup code", text: $code)
                        .textInputAutocapitalization(.never)
                }
                Section {
                    Button("Pair") {
                        Task { await model.pair(host: host, code: code) }
                    }
                    .disabled(host.isEmpty || code.isEmpty || model.busy)
                    Button("Scan QR") { showScanner = true }
                }
                if let err = model.pairError {
                    Section { Text(err).foregroundStyle(.red) }
                }
                Section {
                    Text("Local-dev fallback. Product sign-in is email OTP. This path saves the hub URL and a seat token in Keychain.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Computer")
            .sheet(isPresented: $showScanner) {
                QRScanner { payload in
                    showScanner = false
                    let parsed = PairURL.parsePairQR(payload)
                    if !parsed.host.isEmpty { host = parsed.host }
                    if let c = parsed.code { code = c }
                }
            }
        }
    }
}
