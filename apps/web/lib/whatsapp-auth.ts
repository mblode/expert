import { APIError } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { attachPhoneLogin, consumeWhatsAppCode } from "./whatsapp-login";

export function whatsappAuth() {
  return {
    id: "whatsapp-login",
    endpoints: {
      signInWhatsApp: createAuthEndpoint("/sign-in/whatsapp", { method: "POST" }, async (ctx) => {
        const origin = ctx.request?.headers.get("origin");
        if (!origin || !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false }))
          throw new APIError("FORBIDDEN", { message: "Sign in from hello.expert." });
        const body: unknown = ctx.body;
        if (
          !body ||
          typeof body !== "object" ||
          !("phone" in body) ||
          !("code" in body) ||
          typeof body.phone !== "string" ||
          typeof body.code !== "string" ||
          body.phone.length > 40
        )
          throw new APIError("BAD_REQUEST", {
            message: "Enter your phone number and six-digit code.",
          });
        const identity = await consumeWhatsAppCode(body.phone, body.code);
        if (!identity)
          throw new APIError("BAD_REQUEST", {
            message: "That code is invalid or expired. Message Vibey ‘sign in’ for a new code.",
          });
        let { userId } = identity;
        if (!userId && identity.phoneId) {
          const email = `${identity.phoneId}@phone.invalid`;
          const existing = await ctx.context.internalAdapter.findUserByEmail(email);
          const created =
            existing?.user ??
            (await ctx.context.internalAdapter.createUser(
              {
                name: "My account",
                email,
                emailVerified: false,
              },
              { method: "whatsapp" },
            ));
          userId = (await attachPhoneLogin(identity.phoneId, created.id)) ?? null;
        }
        const user = userId ? await ctx.context.internalAdapter.findUserById(userId) : null;
        if (!user)
          throw new APIError("BAD_REQUEST", {
            message: "Account unavailable. Please use your existing sign-in method.",
          });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session)
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Could not sign in. Request a new code and try again.",
          });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ user: { id: user.id, name: user.name }, success: true });
      }),
    },
    rateLimit: [{ pathMatcher: (path) => path === "/sign-in/whatsapp", window: 60, max: 10 }],
  } satisfies BetterAuthPlugin;
}
