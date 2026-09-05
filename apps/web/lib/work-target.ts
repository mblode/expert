export type WorkView = "computer" | "plugins" | "code";
export interface WorkTarget {
  view: WorkView;
  hub: string;
  bot: string;
  conversation?: string;
}

/** Only our work route may survive login, never an arbitrary redirect URL. */
export function workReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  try {
    const url = new URL(value, "https://local.invalid");
    return url.origin === "https://local.invalid" && url.pathname === "/work"
      ? `${url.pathname}${url.search}`
      : "/";
  } catch {
    return "/";
  }
}

export function parseWorkTarget(
  params: Record<string, string | string[] | undefined>,
): WorkTarget | null {
  const { view, hub, bot, conversation } = params;
  if (
    typeof view !== "string" ||
    !["computer", "plugins", "code"].includes(view) ||
    typeof hub !== "string" ||
    typeof bot !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,47}$/.test(bot)
  )
    return null;
  if (
    conversation !== undefined &&
    (typeof conversation !== "string" || !/^conv_[A-Za-z0-9_-]{1,64}$/.test(conversation))
  )
    return null;
  return {
    view: view as WorkView,
    hub: hub.replace(/\/$/, ""),
    bot,
    ...(conversation ? { conversation } : {}),
  };
}

/** A link selects context. The signed-in seat is the authority; never fetch its supplied hub. */
export function workTargetMatches(target: WorkTarget, hubUrl: string): boolean {
  return target.hub === hubUrl.replace(/\/$/, "");
}
