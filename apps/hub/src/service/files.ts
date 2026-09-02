import { ComputerError, WORKSPACE, resolveWorkspacePath } from "@computer/shared";
import type { Desk, ShellResult } from "../desk/types.ts";
import { BoundedCache } from "./cache.ts";
import { PolicyService, deniedError } from "./policy.ts";
import type { SeatService } from "./seat.ts";

const MAX_ARGV = 32;
const MAX_TIMEOUT_SEC = 120;

/** `shell`, `read_file`, `write_file`: the box without opening an editor on screen. */
export class FileService {
  private readonly desk: Desk;
  private readonly seat: SeatService;
  private readonly policy: PolicyService;
  /** request_id → first run, stored before it starts so an overlapping retry waits instead of re-running. */
  private readonly shellCache = new BoundedCache<{ hash: string; response: Promise<ShellResult> }>();

  constructor(desk: Desk, seat: SeatService, policy: PolicyService = new PolicyService()) {
    this.desk = desk;
    this.seat = seat;
    this.policy = policy;
  }

  async shell(req: {
    request_id: string;
    argv: string[];
    cwd?: string;
    timeout_sec?: number;
  }): Promise<ShellResult> {
    this.seat.requireAgent();
    if (!req.request_id) throw new ComputerError("VALIDATION", "request_id is required");
    if (!Array.isArray(req.argv) || req.argv.length < 1 || req.argv.length > MAX_ARGV) {
      throw new ComputerError("VALIDATION", `argv must have 1–${MAX_ARGV} items`);
    }
    if (req.argv.some((a) => typeof a !== "string")) {
      throw new ComputerError("VALIDATION", "argv items must be strings");
    }
    const timeout = req.timeout_sec ?? 30;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SEC) {
      throw new ComputerError("VALIDATION", `timeout_sec must be 1–${MAX_TIMEOUT_SEC}`);
    }
    const cwd = req.cwd ? resolveWorkspacePath(req.cwd) : WORKSPACE;
    const hash = JSON.stringify({ argv: req.argv, cwd, timeout });
    const hit = this.shellCache.get(req.request_id);
    if (hit) {
      if (hit.hash !== hash) throw new ComputerError("CONFLICT", "request_id reused with a different body");
      return hit.response;
    }
    // Denials are never cached: the rule, or the human's mind, may have
    // changed by the retry.
    const verdict = await this.policy.evaluate({ tool: "shell", argv: req.argv, cwd });
    if (verdict.decision !== "allow") throw deniedError(verdict);
    await this.desk.ping();
    const response = this.desk.shell(req.argv, cwd, timeout);
    this.shellCache.set(req.request_id, { hash, response });
    return response.catch((err) => {
      this.shellCache.delete(req.request_id);
      throw err;
    });
  }

  async readFile(path: string): Promise<{ content: string }> {
    this.seat.requireAgent();
    const resolved = resolveWorkspacePath(path);
    await this.desk.ping();
    return { content: await this.desk.readFile(resolved) };
  }

  async writeFile(path: string, content: string): Promise<{ bytes: number }> {
    this.seat.requireAgent();
    if (typeof content !== "string") throw new ComputerError("VALIDATION", "content must be a string");
    const resolved = resolveWorkspacePath(path);
    await this.desk.ping();
    return { bytes: await this.desk.writeFile(resolved, content) };
  }
}
