# Computer desktop (Mac + Windows)

Tauri 2 wrapper around `apps/web`. Same email OTP sign-in, same computer.

```sh
# from the repo root — needs Rust (https://rustup.rs) and the web app deps
npm install
npm run desktop
```

`npm run desktop` starts the Next.js web client and opens the Tauri window on it. A signed release build is not required for development.
