# WhatsApp web sign-in

A private owner messages Vibey `sign in` and receives a six-digit code. On
hello.expert/login they enter their international WhatsApp number and that code.
Email remains an alternative for existing accounts. Workspace links lead to the
same sign-in page, which returns an already signed-in person to their workspace.

The authenticated gateway handles sign-in commands before model ingress. Codes
never enter assistant history. Only ready phone accounts or active verified
connections receive codes. No new computer is provisioned by the login endpoint.

Codes are HMAC-hashed with the authentication secret, last five minutes, permit
five incorrect guesses, and are consumed atomically. Issuance has a 30-second
cooldown. The Better Auth endpoint requires a trusted browser origin and creates
its usual HttpOnly session cookie. An existing phone owner retains their auth
user ID. An unclaimed phone computer attaches to a new internal user with an
unverified placeholder email, never another tenant. Repeating the login preserves
that identity; a concurrent email claim cannot be overwritten.

Verification covers incorrect phones, expired codes, attempt exhaustion, resend
cooldown, concurrent replay, existing ownership, new-user sessions, and rejection
of untrusted origins before consuming a code. Run `npm run check`, then verify
code delivery and browser sign-in through the owner's real WhatsApp account.

Email recovery enrollment and one-tap magic links are not part of this change.
Rollback restores the email-first UI and removes the WhatsApp auth plugin; keep
phone ownership rows and user records so existing computers remain attached.

Production verification, 2026-09-05: full `npm run check` passed. Chrome
confirmed code delivery through Vibey and successful sign-in to the existing
owner workspace after signing out. New phone-user creation, origin rejection
and replay protection were verified through a real Better Auth handler test.
