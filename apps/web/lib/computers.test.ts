import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HUB_URL } from "./config";
import {
  accessibleComputers,
  computerById,
  computersFromEnv,
  defaultComputerId,
  isComputerOperator,
  pairComputer,
  parseComputerBindings,
  setupCodeFor,
  VCMC_HUB_URL,
} from "./computers";

const mattCode = "matt-setup";
const vcmcCode = "vcmc-setup";

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    COMPUTER_SETUP_CODE: mattCode,
    COMPUTER_SETUP_CODE_VCMC: vcmcCode,
    ...extra,
  };
}

describe("computer catalog", () => {
  it("seeds matt and vcmc as distinct hubs", () => {
    const computers = computersFromEnv({});
    expect(computers.map((c) => c.id)).toEqual(["matt", "vcmc"]);
    expect(computerById("matt", {})?.hubUrl).toBe(DEFAULT_HUB_URL);
    expect(computerById("vcmc", {})?.hubUrl).toBe(VCMC_HUB_URL);
    expect(computerById("matt", {})?.hubUrl).not.toBe(computerById("vcmc", {})?.hubUrl);
    expect(computerById("matt", {})?.setupCodeEnv).toBe("COMPUTER_SETUP_CODE");
    expect(computerById("vcmc", {})?.setupCodeEnv).toBe("COMPUTER_SETUP_CODE_VCMC");
  });

  it("lets env override each hub without collapsing them", () => {
    const computers = computersFromEnv({
      COMPUTER_HUB_URL: "https://matt-override.example",
      COMPUTER_HUB_URL_VCMC: "https://vcmc-override.example",
      NEXT_PUBLIC_HUB_URL: "https://should-not-win.example",
    });
    expect(computers[0]?.hubUrl).toBe("https://matt-override.example");
    expect(computers[1]?.hubUrl).toBe("https://vcmc-override.example");
  });

  it("prefers COMPUTER_HUB_URL_MATT over the generic fallback", () => {
    const computers = computersFromEnv({
      COMPUTER_HUB_URL: "https://generic.example",
      COMPUTER_HUB_URL_MATT: "https://matt-named.example",
      NEXT_PUBLIC_HUB_URL: "https://public.example",
    });
    expect(computers[0]?.hubUrl).toBe("https://matt-named.example");
  });
});

describe("computer binding", () => {
  it("parses email:id bindings and ignores junk", () => {
    const map = parseComputerBindings("m@blode.co:matt, vcmc@example.com:vcmc, nope, :empty, bad:");
    expect(map.get("m@blode.co")).toBe("matt");
    expect(map.get("vcmc@example.com")).toBe("vcmc");
    expect(map.size).toBe(2);
  });

  it("binds an email to its mapped computer, else matt", () => {
    const bindings = env({ COMPUTER_BINDINGS: "ops@vcmc.org:vcmc" });
    expect(defaultComputerId("ops@vcmc.org", bindings)).toBe("vcmc");
    expect(defaultComputerId("m@blode.co", bindings)).toBe("matt");
    expect(defaultComputerId("OPS@vcmc.org", bindings)).toBe("vcmc");
  });

  it("does not bind to an id that is not in the catalog", () => {
    expect(defaultComputerId("a@b.co", env({ COMPUTER_BINDINGS: "a@b.co:ghost" }))).toBe("matt");
  });

  it("treats an unset operator list as every signed-in user", () => {
    expect(isComputerOperator("m@blode.co", env())).toBe(true);
    expect(accessibleComputers("anyone@example.com", env()).map((c) => c.id)).toEqual([
      "matt",
      "vcmc",
    ]);
  });

  it("restricts a non-operator to their bound computer", () => {
    const locked = env({ COMPUTER_OPERATOR_EMAILS: "m@blode.co" });
    expect(isComputerOperator("m@blode.co", locked)).toBe(true);
    expect(isComputerOperator("other@example.com", locked)).toBe(false);
    expect(accessibleComputers("other@example.com", locked).map((c) => c.id)).toEqual(["matt"]);
    expect(
      accessibleComputers("ops@vcmc.org", {
        ...locked,
        COMPUTER_BINDINGS: "ops@vcmc.org:vcmc",
      }).map((c) => c.id),
    ).toEqual(["vcmc"]);
  });
});

describe("pairComputer", () => {
  it("pairs against the bound computer's hub and setup code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${VCMC_HUB_URL}/computer.v1.Seat/Pair`);
      expect(JSON.parse(String(init?.body))).toEqual({ code: vcmcCode });
      return Response.json({ token: "seat_vcmc" }, { status: 200 });
    });
    const vcmc = computerById("vcmc", env());
    expect(vcmc).toBeDefined();
    await expect(pairComputer(vcmc!, env(), fetchImpl)).resolves.toEqual({ token: "seat_vcmc" });
    expect(setupCodeFor(computerById("matt", env())!, env())).toBe(mattCode);
    expect(setupCodeFor(vcmc!, env())).toBe(vcmcCode);
    expect(setupCodeFor(vcmc!, env())).not.toBe(setupCodeFor(computerById("matt", env())!, env()));
  });

  it("does not send Matt's setup code to the VCMC hub", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ code: vcmcCode });
      expect(JSON.parse(String(init?.body)).code).not.toBe(mattCode);
      return Response.json({ token: "seat_vcmc" }, { status: 200 });
    });
    await pairComputer(computerById("vcmc", env())!, env(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to pair when that computer's setup code is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await pairComputer(
      computerById("vcmc", { COMPUTER_SETUP_CODE: mattCode })!,
      { COMPUTER_SETUP_CODE: mattCode },
      fetchImpl,
    );
    expect(result).toEqual({
      error:
        "The web server is missing COMPUTER_SETUP_CODE_VCMC, so it cannot attach to the VCMC computer.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
