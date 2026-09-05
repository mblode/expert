/** Session storage preserves a launch across reloads without storing the brief or a credential. */
export async function codingRequestId(
  storage: Pick<Storage, "getItem" | "setItem">,
  scope: string,
  payload: string,
): Promise<{ id: string; storageKey: string }> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([scope, payload])),
  );
  const fingerprint = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const storageKey = `coding-request:${fingerprint}`;
  const previous = storage.getItem(storageKey);
  const id = previous && /^[0-9a-f-]{36}$/.test(previous) ? previous : crypto.randomUUID();
  storage.setItem(storageKey, id);
  return { id, storageKey };
}
