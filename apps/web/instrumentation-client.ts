import { posthog } from "posthog-js";

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
// Setup and login can carry a one-time invitation in their return URL.
// Do not initialise analytics or replay on those credential-bearing pages.
const setupPage = ["/start", "/login"].includes(window.location.pathname);
if (token && !setupPage) {
  posthog.init(token, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    defaults: "2026-05-30",
    // Also covers client navigation from an already instrumented workspace.
    before_send: (event) =>
      ["/start", "/login"].includes(window.location.pathname) ? null : event,
  });
}
