import { ComputerError, WORKSPACE, resolveWorkspacePath } from "@computer/shared";
import type { Desk, ShellResult } from "../desk/types.ts";
import type { SeatService } from "./seat.ts";

export class FileService {
  private readonly desk: Desk;
  private readonly seat: SeatService;
  private readonly shellCache = new Map<string, { hash: string; response: ShellResult }>();

  constructor(desk: Desk, seat: SeatService) {
    this.desk = desk;
    this.seat = seat;
  }

  async shell(req: {
    request_id: string;
    argv: string[];
    cwd?: string;
    timeout_sec?: number;
  }): Promise<ShellResult> {
    this.seat.requireAgent();
    if (!req.request_id) throw new ComputerError("VALIDATION", "request_id is required");
    if (!Array.isArray(req.argv) || req.argv.length < 1 || req.argv.length > 32) {
      throw new ComputerError("VALIDATION", "argv must have 1–32 items");
    }
    if (req.argv.some((a) => typeof a !== "string")) {
      throw new ComputerError("VALIDATION", "argv items must be strings");
    }
    const timeout = req.timeout_sec ?? 30;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
      throw new ComputerError("VALIDATION", "timeout_sec must be 1–120");
    }
    const cwd = req.cwd ? resolveWorkspacePath(req.cwd) : WORKSPACE;
    const hash = JSON.stringify({ argv: req.argv, cwd, timeout });
    const hit = this.shellCache.get(req.request_id);
    if (hit) {
      if (hit.hash !== hash) throw new ComputerError("CONFLICT", "request_id reused with a different body");
      return hit.response;
    }
    await this.desk.ping();
    const response = await this.desk.shell(req.argv, cwd, timeout);
    this.shellCache.set(req.request_id, { hash, response });
    return response;
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
