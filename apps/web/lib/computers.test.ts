import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HUB_URL } from "./config";
import {
  accessibleComputers,
  computerById,
  computersFromEnv,
  boundComputerId,
  isComputerOperator,
  pairComputer,
  parseComputerBindings,
  setupCodeFor,
  VIBEY_HUB_URL,
} from "./computers";

const vibeyCode = "vibey-setup";

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    COMPUTER_SETUP_CODE_VCMC: vibeyCode,
    ...extra,
  };
}

describe("computer catalog", () => {
  it("seeds one computer, Vibey, on its own hub", () => {
    const computers = computersFromEnv({});
    expect(computers.map((c) => c.id)).toEqual(["vibey"]);
    expect(computers.map((c) => c.label)).toEqual(["Vibey"]);
    expect(computerById("vibey", {})?.hubUrl).toBe(VIBEY_HUB_URL);
    expect(VIBEY_HUB_URL).toBe(DEFAULT_HUB_URL);
    expect(computerById("vibey", {})?.setupCodeEnv).toBe("COMPUTER_SETUP_CODE_VCMC");
  });

  it("prefers COMPUTER_HUB_URL_VIBEY, then COMPUTER_HUB_URL_VCMC, and ignores the generic names", () => {
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL: "https://dead-blode.example",
        NEXT_PUBLIC_HUB_URL: "https://dead-blode.example",
      })[0]?.hubUrl,
    ).toBe(VIBEY_HUB_URL);
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL_VCMC: "https://vcmc-alias.example",
      })[0]?.hubUrl,
    ).toBe("https://vcmc-alias.example");
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL_VCMC: "https://vcmc-alias.example",
        COMPUTER_HUB_URL_VIBEY: "https://vibey-named.example",
      })[0]?.hubUrl,
    ).toBe("https://vibey-named.example");
  });

  it("no longer knows blode or matt", () => {
    expect(computerById("blode", {})).toBeUndefined();
    expect(computerById("matt", {})).toBeUndefined();
  });
});

describe("computer binding", () => {
  it("parses email:id bindings and ignores junk", () => {
    const map = parseComputerBindings(
      "m@blode.co:vibey, vibey@example.com:vibey, nope, :empty, bad:",
    );
    expect(map.get("m@blode.co")).toBe("vibey");
    expect(map.get("vibey@example.com")).toBe("vibey");
    expect(map.size).toBe(2);
  });

  it("binds an email to its mapped computer, and nothing otherwise", () => {
    const bindings = env({ COMPUTER_BINDINGS: "ops@vcmc.org:vibey" });
    expect(boundComputerId("ops@vcmc.org", bindings)).toBe("vibey");
    expect(boundComputerId("OPS@vcmc.org", bindings)).toBe("vibey");
    // An account is the tenant boundary: an unbound one gets no computer
    // rather than whoever happens to be first in the catalog.
    expect(boundComputerId("m@blode.co", bindings)).toBeUndefined();
  });

  it("does not bind to an id that is not in the catalog", () => {
    expect(boundComputerId("a@b.co", env({ COMPUTER_BINDINGS: "a@b.co:ghost" }))).toBeUndefined();
  });

  it("takes DEFAULT_COMPUTER_ID as an explicit opt-in for unbound accounts", () => {
    expect(boundComputerId("a@b.co", env({ DEFAULT_COMPUTER_ID: "vibey" }))).toBe("vibey");
    expect(boundComputerId("a@b.co", env({ DEFAULT_COMPUTER_ID: "ghost" }))).toBeUndefined();
  });

  it("maps a leftover vcmc binding onto vibey, and a blode one onto nothing", () => {
    expect(boundComputerId("ops@vcmc.org", env({ COMPUTER_BINDINGS: "ops@vcmc.org:vcmc" }))).toBe(
      "vibey",
    );
    expect(boundComputerId("a@b.co", env({ COMPUTER_BINDINGS: "a@b.co:blode" }))).toBeUndefined();
    expect(computerById("vcmc", {})?.id).toBe("vibey");
  });

  it("treats an unset operator list as nobody, not everybody", () => {
    // Unset used to mean every signed-in user, which made the binding above
    // unreachable and let one account open another account's computer.
    expect(isComputerOperator("m@blode.co", env())).toBe(false);
    expect(accessibleComputers("anyone@example.com", env())).toEqual([]);
    // A bound account still reaches its own computer without being an operator.
    expect(
      accessibleComputers("ops@vcmc.org", env({ COMPUTER_BINDINGS: "ops@vcmc.org:vibey" })).map(
        (c) => c.id,
      ),
    ).toEqual(["vibey"]);
  });

  it("restricts a non-operator to their bound computer", () => {
    const locked = env({ COMPUTER_OPERATOR_EMAILS: "m@blode.co" });
    expect(isComputerOperator("m@blode.co", locked)).toBe(true);
    expect(accessibleComputers("m@blode.co", locked).map((c) => c.id)).toEqual(["vibey"]);
    expect(isComputerOperator("other@example.com", locked)).toBe(false);
    expect(accessibleComputers("other@example.com", locked)).toEqual([]);
    expect(
      accessibleComputers("ops@vcmc.org", {
        ...locked,
        COMPUTER_BINDINGS: "ops@vcmc.org:vibey",
      }).map((c) => c.id),
    ).toEqual(["vibey"]);
  });
});

describe("pairComputer", () => {
  it("pairs against the bound computer's hub and setup code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${VIBEY_HUB_URL}/computer.v1.Seat/Pair`);
      expect(JSON.parse(String(init?.body))).toEqual({ code: vibeyCode });
      return Response.json({ token: "seat_vibey" }, { status: 200 });
    });
    const vibey = computerById("vibey", env());
    expect(vibey).toBeDefined();
    await expect(pairComputer(vibey!, env(), fetchImpl)).resolves.toEqual({ token: "seat_vibey" });
    expect(setupCodeFor(vibey!, env())).toBe(vibeyCode);
  });

  it("does not read the retired COMPUTER_SETUP_CODE for the Vibey hub", async () => {
    const stale = { COMPUTER_SETUP_CODE: "blode-setup", COMPUTER_SETUP_CODE_VCMC: vibeyCode };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ code: vibeyCode });
      return Response.json({ token: "seat_vibey" }, { status: 200 });
    });
    await pairComputer(computerById("vibey", stale)!, stale, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to pair when that computer's setup code is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await pairComputer(computerById("vibey", {})!, {}, fetchImpl);
    expect(result).toEqual({
      error:
        "The web server is missing COMPUTER_SETUP_CODE_VCMC, so it cannot attach to the Vibey computer.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
