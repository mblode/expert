import { describe, expect, it } from "vitest";
import bash from "../../eve/lib/tools/bash.ts";
import computer from "../../eve/lib/tools/computer.ts";
import readFile from "../../eve/lib/tools/read_file.ts";
import sendMessage from "../../eve/lib/tools/send_message.ts";
import shell from "../../eve/lib/tools/shell.ts";
import writeFile from "../../eve/lib/tools/write_file.ts";

type ApprovalPolicy = (ctx: Record<string, unknown>) => unknown | Promise<unknown>;

/** A human chat turn through the hub — not a scheduled `eve:app` run. */
function humanChatContext(toolName: string, toolInput: Record<string, unknown>) {
  return {
    approvedTools: new Set(),
    callId: "call_live",
    session: {
      auth: {
        current: {
          authenticator: "computer-hub",
          principalId: "hub",
          principalType: "service",
        },
      },
    },
    toolInput,
    toolName,
  };
}

function asPolicy(approval: unknown, toolName: string): ApprovalPolicy {
  if (typeof approval === "function") {
    return approval as ApprovalPolicy;
  }
  if (
    approval !== null &&
    typeof approval === "object" &&
    "request" in approval &&
    typeof approval.request === "function"
  ) {
    return approval.request as ApprovalPolicy;
  }
  throw new Error(`${toolName} must declare approval`);
}

async function decide(
  tool: { approval?: unknown },
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  return await asPolicy(tool.approval, toolName)(humanChatContext(toolName, toolInput));
}

describe("Eve desk tools: no Approve pause on a human chat turn", () => {
  it("shell returns not-applicable for a normal session, not only scheduled runs", async () => {
    expect(
      await decide(shell, "shell", {
        argv: ["bash", "-lc", "xdg-open https://example.com"],
        request_id: "open-example",
      }),
    ).toBe("not-applicable");
  });

  it("computer, read_file, and write_file also skip HITL", async () => {
    expect(
      await decide(computer, "computer", {
        actions: [{ type: "screenshot" }],
        request_id: "c1",
      }),
    ).toBe("not-applicable");
    expect(await decide(readFile, "read_file", { path: "notes.md" })).toBe("not-applicable");
    expect(await decide(writeFile, "write_file", { content: "hi", path: "notes.md" })).toBe(
      "not-applicable",
    );
  });

  it("disables the built-in sandbox bash so it cannot park on Approve", () => {
    expect(bash).toEqual({ kind: "eve:disabled-tool" });
  });

  it("leaves send_message without an approval gate", () => {
    expect(sendMessage.approval).toBeUndefined();
  });
});
