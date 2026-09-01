/** Server-only: which social providers have credentials at this build/runtime. */
export function socialProvidersAvailable(): { google: boolean; apple: boolean } {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    apple: Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET),
  };
}

export function googleSocialConfig():
  | { clientId: string; clientSecret: string }
  | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

export function appleSocialConfig():
  | { clientId: string; clientSecret: string; appBundleIdentifier?: string }
  | undefined {
  const clientId = process.env.APPLE_CLIENT_ID;
  const clientSecret = process.env.APPLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const appBundleIdentifier = process.env.APPLE_APP_BUNDLE_IDENTIFIER;
  return appBundleIdentifier ? { clientId, clientSecret, appBundleIdentifier } : { clientId, clientSecret };
}
