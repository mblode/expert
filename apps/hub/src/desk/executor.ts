import { spawn } from "node:child_process";
import { chownSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";

/**
 * Run a command as `box`, on behalf of a hub that is not `box`.
 *
 * Under one uid there is no boundary: whatever the hub can read, the model's
 * `shell` can read too (same user, even `/proc/<hub>/environ`). So the hub
 * runs as its own user (AUDIT P0 #2), and everything that must touch the
 * desk as `box`, xdotool, screenshots, the model's shell, file reads and
 * writes under /workspace, comes through here. The server side lives in the
 * root init process, which is the only one allowed to change uid; the hub
 * holds the client end over a unix socket only its user can open.
 *
 * The protocol is one JSON line per request and one per response, with
 * output base64-encoded. Small on purpose: it is a spawn call with a uid,
 * not a shell.
 */
export interface ExecRequest {
  argv: string[];
  cwd?: string;
  /** The child's whole environment. The server adds nothing: a login's worth is the caller's job. */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  /** Bytes kept per stream. Absent = keep everything. */
  maxOutput?: number;
}

export interface ExecResponse {
  exit: number;
  /** base64 */
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Set when the process could not be started or was killed for time. */
  error?: string;
  timedOut?: boolean;
}

export interface ExecutorServerOptions {
  socketPath: string;
  /** The user commands run as. */
  uid: number;
  gid: number;
  /** Who may open the socket: the hub's uid and gid. */
  clientUid: number;
  clientGid: number;
  /** Upper bound on any request's timeout, so a bad client cannot park a process forever. */
  maxTimeoutMs?: number;
}

const MAX_LINE = 64 * 1024 * 1024;

/** Root side. Listens, spawns as `box`, answers. */
export function startExecutorServer(opts: ExecutorServerOptions): Server {
  mkdirSync(dirname(opts.socketPath), { mode: 0o755, recursive: true });
  rmSync(opts.socketPath, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        return;
      }
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let req: ExecRequest;
      try {
        req = JSON.parse(line) as ExecRequest;
      } catch {
        reply(socket, {
          error: "bad request",
          exit: 1,
          stderr: "",
          stderrTruncated: false,
          stdout: "",
          stdoutTruncated: false,
        });
        return;
      }
      void runAs(req, opts).then((res) => reply(socket, res));
    });
    socket.on("error", () => {});
  });
  server.listen(opts.socketPath, () => {
    // Only the hub's user may connect. Root can too, which is fine: root owns the box.
    chownSync(opts.socketPath, opts.clientUid, opts.clientGid);
    chmodSync(opts.socketPath, 0o600);
  });
  return server;
}

function reply(socket: Socket, res: ExecResponse): void {
  socket.end(`${JSON.stringify(res)}\n`);
}

function runAs(req: ExecRequest, opts: ExecutorServerOptions): Promise<ExecResponse> {
  const timeoutMs = Math.min(
    Math.max(1, Number(req.timeoutMs) || 1),
    opts.maxTimeoutMs ?? 10 * 60_000,
  );
  if (
    !Array.isArray(req.argv) ||
    req.argv.length === 0 ||
    req.argv.some((a) => typeof a !== "string")
  ) {
    return Promise.resolve({
      error: "argv must be a non-empty array of strings",
      exit: 1,
      stderr: "",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
    });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(req.argv[0]!, req.argv.slice(1), {
        cwd: req.cwd,
        env: req.env ?? {},
        gid: opts.gid,
        stdio: ["pipe", "pipe", "pipe"],
        uid: opts.uid,
      });
    } catch (error) {
      resolve({
        error: (error as Error).message,
        exit: 1,
        stderr: "",
        stderrTruncated: false,
        stdout: "",
        stdoutTruncated: false,
      });
      return;
    }
    const out = new Sink(req.maxOutput);
    const err = new Sink(req.maxOutput);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdin.on("error", () => {});
    child.stdin.end(req.stdin);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        error: `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`.trim(),
        exit: 1,
        stderr: err.buffer().toString("base64"),
        stderrTruncated: err.truncated,
        stdout: out.buffer().toString("base64"),
        stdoutTruncated: out.truncated,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ...(timedOut ? { error: `timed out after ${timeoutMs}ms`, timedOut: true } : {}),
        exit: code ?? 1,
        stderr: err.buffer().toString("base64"),
        stderrTruncated: err.truncated,
        stdout: out.buffer().toString("base64"),
        stdoutTruncated: out.truncated,
      });
    });
  });
}

/** Collects a child's output up to a cap, dropping the rest instead of holding it. */
class Sink {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number | undefined) {}

  push(chunk: Buffer): void {
    if (this.max === undefined) {
      this.chunks.push(chunk);
      return;
    }
    const room = this.max - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.max;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface ExecResult {
  exit: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut?: boolean;
  /** The executor could not run it at all (ENOENT, EACCES): not an exit code. */
  error?: string;
}

/** Hub side. One connection per call; the socket is loopback-local and cheap. */
export async function execViaSocket(socketPath: string, req: ExecRequest): Promise<ExecResult> {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", (error) => reject(error));
    socket.on("close", () => {
      const line = buffer.trim();
      if (!line) {
        reject(new Error("executor closed without a response"));
        return;
      }
      let res: ExecResponse;
      try {
        res = JSON.parse(line) as ExecResponse;
      } catch {
        reject(new Error("executor sent a bad response"));
        return;
      }
      resolve({
        error: res.error,
        exit: res.exit,
        stderr: Buffer.from(res.stderr, "base64"),
        stderrTruncated: res.stderrTruncated,
        stdout: Buffer.from(res.stdout, "base64"),
        stdoutTruncated: res.stdoutTruncated,
        timedOut: res.timedOut,
      });
    });
  });
}
