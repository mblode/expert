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

const blodeCode = "blode-setup";
const vibeyCode = "vibey-setup";

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    COMPUTER_SETUP_CODE: blodeCode,
    COMPUTER_SETUP_CODE_VCMC: vibeyCode,
    ...extra,
  };
}

describe("computer catalog", () => {
  it("seeds blode and vibey as distinct hubs", () => {
    const computers = computersFromEnv({});
    expect(computers.map((c) => c.id)).toEqual(["blode", "vibey"]);
    expect(computers.map((c) => c.label)).toEqual(["Blode", "Vibey"]);
    expect(computerById("blode", {})?.hubUrl).toBe(DEFAULT_HUB_URL);
    expect(computerById("vibey", {})?.hubUrl).toBe(VIBEY_HUB_URL);
    expect(computerById("blode", {})?.hubUrl).not.toBe(computerById("vibey", {})?.hubUrl);
    expect(computerById("blode", {})?.setupCodeEnv).toBe("COMPUTER_SETUP_CODE");
    expect(computerById("vibey", {})?.setupCodeEnv).toBe("COMPUTER_SETUP_CODE_VCMC");
  });

  it("lets env override each hub without collapsing them", () => {
    const computers = computersFromEnv({
      COMPUTER_HUB_URL: "https://blode-override.example",
      COMPUTER_HUB_URL_VCMC: "https://vibey-override.example",
      NEXT_PUBLIC_HUB_URL: "https://should-not-win.example",
    });
    expect(computers[0]?.hubUrl).toBe("https://blode-override.example");
    expect(computers[1]?.hubUrl).toBe("https://vibey-override.example");
  });

  it("prefers COMPUTER_HUB_URL_BLODE, then COMPUTER_HUB_URL_MATT, over the generic fallback", () => {
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL: "https://generic.example",
        COMPUTER_HUB_URL_MATT: "https://matt-alias.example",
        NEXT_PUBLIC_HUB_URL: "https://public.example",
      })[0]?.hubUrl,
    ).toBe("https://matt-alias.example");
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL: "https://generic.example",
        COMPUTER_HUB_URL_BLODE: "https://blode-named.example",
        COMPUTER_HUB_URL_MATT: "https://matt-alias.example",
        NEXT_PUBLIC_HUB_URL: "https://public.example",
      })[0]?.hubUrl,
    ).toBe("https://blode-named.example");
  });

  it("prefers COMPUTER_HUB_URL_VIBEY, then COMPUTER_HUB_URL_VCMC", () => {
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL_VCMC: "https://vcmc-alias.example",
      })[1]?.hubUrl,
    ).toBe("https://vcmc-alias.example");
    expect(
      computersFromEnv({
        COMPUTER_HUB_URL_VCMC: "https://vcmc-alias.example",
        COMPUTER_HUB_URL_VIBEY: "https://vibey-named.example",
      })[1]?.hubUrl,
    ).toBe("https://vibey-named.example");
  });

  it("COMPUTER_CATALOG replaces the seeded pair entirely", () => {
    const computers = computersFromEnv({
      COMPUTER_CATALOG:
        "acme|https://acme-computer.fly.dev, blode|https://blode.example|Blode|COMPUTER_SETUP_CODE",
    });
    expect(computers.map((c) => c.id)).toEqual(["acme", "blode"]);
    // Vibey is gone: opting in means listing every tenant, so a half-filled
    // variable cannot leave a computer reachable that the operator meant to
    // remove.
    expect(computers.find((c) => c.id === "vibey")).toBeUndefined();
  });

  it("fills the label and the setup-code env var from the id", () => {
    const [acme] = computersFromEnv({ COMPUTER_CATALOG: "acme-two|https://acme.fly.dev" });
    expect(acme?.label).toBe("Acme-two");
    expect(acme?.setupCodeEnv).toBe("COMPUTER_SETUP_CODE_ACME_TWO");
    expect(acme?.hubUrl).toBe("https://acme.fly.dev");
  });

  it("trims a trailing slash and takes the first entry for a repeated id", () => {
    const computers = computersFromEnv({
      COMPUTER_CATALOG: "acme|https://first.example/,acme|https://second.example",
    });
    expect(computers).toHaveLength(1);
    expect(computers[0]?.hubUrl).toBe("https://first.example");
  });

  it("skips a malformed entry instead of failing the whole catalog", () => {
    // Read on every request that resolves a computer, sign-in included: one
    // tenant's typo must not lock the rest out of their box.
    const computers = computersFromEnv({
      COMPUTER_CATALOG: "|https://no-id.example,missing-url,acme|https://acme.fly.dev",
    });
    expect(computers.map((c) => c.id)).toEqual(["acme"]);
  });

  it("falls back to the seeded pair when the variable is unset or unusable", () => {
    // An empty catalog would give every account no computer at all, which is
    // what an unbound address should mean and not what a blank env var should.
    expect(computersFromEnv({ COMPUTER_CATALOG: "" }).map((c) => c.id)).toEqual(["blode", "vibey"]);
    expect(computersFromEnv({ COMPUTER_CATALOG: " , " }).map((c) => c.id)).toEqual([
      "blode",
      "vibey",
    ]);
  });

  it("resolves a catalog tenant by id, aliases included", () => {
    const catalogEnv = { COMPUTER_CATALOG: "acme|https://acme.fly.dev" };
    expect(computerById("acme", catalogEnv)?.hubUrl).toBe("https://acme.fly.dev");
    expect(computerById("blode", catalogEnv)).toBeUndefined();
  });
});

describe("computer binding", () => {
  it("parses email:id bindings and ignores junk", () => {
    const map = parseComputerBindings(
      "m@blode.co:blode, vibey@example.com:vibey, nope, :empty, bad:",
    );
    expect(map.get("m@blode.co")).toBe("blode");
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

  it("maps leftover matt/vcmc bindings onto blode/vibey", () => {
    expect(boundComputerId("a@b.co", env({ COMPUTER_BINDINGS: "a@b.co:matt" }))).toBe("blode");
    expect(boundComputerId("ops@vcmc.org", env({ COMPUTER_BINDINGS: "ops@vcmc.org:vcmc" }))).toBe(
      "vibey",
    );
    expect(computerById("matt", {})?.id).toBe("blode");
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
    expect(accessibleComputers("m@blode.co", locked).map((c) => c.id)).toEqual(["blode", "vibey"]);
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
    expect(setupCodeFor(computerById("blode", env())!, env())).toBe(blodeCode);
    expect(setupCodeFor(vibey!, env())).toBe(vibeyCode);
    expect(setupCodeFor(vibey!, env())).not.toBe(
      setupCodeFor(computerById("blode", env())!, env()),
    );
  });

  it("does not send Blode's setup code to the Vibey hub", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ code: vibeyCode });
      expect(JSON.parse(String(init?.body)).code).not.toBe(blodeCode);
      return Response.json({ token: "seat_vibey" }, { status: 200 });
    });
    await pairComputer(computerById("vibey", env())!, env(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to pair when that computer's setup code is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await pairComputer(
      computerById("vibey", { COMPUTER_SETUP_CODE: blodeCode })!,
      { COMPUTER_SETUP_CODE: blodeCode },
      fetchImpl,
    );
    expect(result).toEqual({
      error:
        "The web server is missing COMPUTER_SETUP_CODE_VCMC, so it cannot attach to the Vibey computer.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
