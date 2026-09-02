/**
 * Which groups an account serves.
 *
 * `group_policy: "all"` serves every group the number is in and ignores the
 * list; `"listed"` serves only `allowed_groups`, and an empty list under it
 * serves none. The old bridge folded both into one Set where empty meant
 * "all", which made "serve nothing yet" unrepresentable: the page needs that
 * state for a freshly linked number before the owner has ticked a group.
 * Every gate in the bridge (inbound classification, edit replies, media
 * sends, seeding) goes through `groupAllowed` so the two fields cannot drift.
 */
export interface GroupGate {
  policy: "all" | "listed";
  groups: ReadonlySet<string>;
}

export const groupAllowed = (gate: GroupGate, jid: string): boolean =>
  gate.policy === "all" || gate.groups.has(jid);

/** Every group, the default. */
export const allGroups: GroupGate = { groups: new Set(), policy: "all" };

/** Only these groups; an empty list is no group at all. */
export const listedGroups = (jids: Iterable<string>): GroupGate => ({
  groups: new Set(jids),
  policy: "listed",
});
