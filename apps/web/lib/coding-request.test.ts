import { expect, it } from "vitest";
import { codingRequestId } from "./coding-request";

it("recovers the same launch after reload without storing a brief, and separates scopes", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const first = await codingRequestId(storage, "account-one", "private brief");
  expect(await codingRequestId(storage, "account-one", "private brief")).toEqual(first);
  expect(await codingRequestId(storage, "account-two", "private brief")).not.toEqual(first);
  expect(await codingRequestId(storage, "account-one", "changed brief")).not.toEqual(first);
  expect(JSON.stringify([...values])).not.toContain("private brief");
});
