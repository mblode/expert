import SwiftUI

struct SignInView: View {
    @EnvironmentObject var model: AppModel
    @State private var email = ""
    @State private var code = ""
    @State private var hub = ComputerConfig.hubURL
    @State private var step: Step = .email
    @State private var showPair = false

    enum Step {
        case email
        case code
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(step == .email
                         ? "Sign in with your email. iPhone, web, Mac, and Windows all attach to the same desktop."
                         : "Enter the 6-digit code sent to \(email.trimmingCharacters(in: .whitespacesAndNewlines)).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if ComputerConfig.hubURL.isEmpty {
                    Section("Hub") {
                        TextField("https://computer.example.com", text: $hub)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                }

                if step == .email {
                    Section("Email") {
                        TextField("you@example.com", text: $email)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                            .textContentType(.username)
                    }
                    Section {
                        Button("Send code") {
                            Task { await send() }
                        }
                        .disabled(!EmailOTP.isEmail(email) || model.busy)
                    }
                } else {
                    Section("Code") {
                        TextField("000000", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .font(.title2.monospacedDigit())
                    }
                    Section {
                        Button("Sign in") {
                            Task { await verify() }
                        }
                        .disabled(!EmailOTP.isCode(code) || model.busy)
                        Button("Use a different email") {
                            step = .email
                            code = ""
                            model.pairError = nil
                        }
                    }
                }

                if let err = model.pairError {
                    Section { Text(err).foregroundStyle(.red) }
                }

                Section {
                    Button("Use a setup code instead") { showPair = true }
                }
            }
            .navigationTitle("Computer")
            .navigationDestination(isPresented: $showPair) {
                PairView()
            }
        }
    }

    private func send() async {
        await model.sendOtp(email: email)
        if model.pairError == nil { step = .code }
    }

    private func verify() async {
        let host = hub.isEmpty ? ComputerConfig.hubURL : hub
        await model.signIn(host: host, email: email, code: code)
    }
}
