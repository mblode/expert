/**
 * WhatsApp bridge: the process entry.
 *
 * Reads the env, loads accounts.json, boots one Baileys socket per account,
 * serves the HTTP API on loopback, and drains cleanly on SIGTERM so a redeploy
 * neither drops in-flight replies nor forces a re-pair. Everything per account
 * is in `account.ts`; everything per route is in `server.ts`; this file only
 * wires them and owns the registry mutations (create, delete, config, phone).
 *
 * This automates a normal WhatsApp account, which is against WhatsApp's Terms
 * of Service and can get the number banned. Use a dedicated number.
 */
import pino from "pino";

import { createAccountRuntime } from "./account.ts";
import type { AccountRuntime } from "./account.ts";
import {
  createAccountsRegistry,
  loadAccountsFile,
  parseAccountConfig,
  parseAccountRecord,
} from "./accounts.ts";
import type { AccountRecord } from "./accounts.ts";
import { readEnv } from "./env.ts";
import { HttpError, startServer } from "./server.ts";
import type { BridgeApi } from "./server.ts";
import { transcriptionModel } from "./transcribe.ts";

const env = readEnv();
const logger = pino({ level: env.logLevel });
// Gateway transcription model from the environment (null when
// AI_GATEWAY_API_KEY is unset); process-wide because the key is.
const transcribeModel = transcriptionModel();
if (transcribeModel) {
  logger.info({ model: transcribeModel }, "voice-note transcription enabled");
}

const runtimes = new Map<string, AccountRuntime>();
let shuttingDown = false;

const main = async (): Promise<void> => {
  const registry = createAccountsRegistry(env.stateDir, await loadAccountsFile(env.stateDir));

  const spawn = (record: AccountRecord): AccountRuntime => {
    const runtime = createAccountRuntime({
      env,
      logger,
      // The socket reports the number it linked as; persist it so the page
      // and GET /accounts show it after a QR link, where nobody typed it.
      onPhone: async (phone) => {
        const next = await registry.setPhone(record.acct, phone);
        await runtime.applyRecord(next);
      },
      record,
      transcribeModel,
    });
    runtimes.set(record.acct, runtime);
    return runtime;
  };

  /** Boot a runtime; a failure is logged, not fatal, so one bad account cannot take the rest down. */
  const boot = async (runtime: AccountRuntime): Promise<void> => {
    try {
      await runtime.start();
    } catch (error) {
      logger.error({ acct: runtime.acct, error }, "account failed to start");
    }
  };

  const require = (acct: string): AccountRuntime => {
    const runtime = runtimes.get(acct);
    if (!runtime) {
      throw new HttpError(404, `unknown account ${acct}`);
    }
    return runtime;
  };

  const api: BridgeApi = {
    accountIds: () => [...runtimes.keys()],
    async createAccount(body) {
      let record: AccountRecord;
      try {
        record = parseAccountRecord(body);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      if (runtimes.has(record.acct)) {
        throw new HttpError(409, `account ${record.acct} already exists`);
      }
      await registry.add(record);
      const runtime = spawn(record);
      await boot(runtime);
      return runtime.summary();
    },
    async deleteAccount(acct) {
      const runtime = runtimes.get(acct);
      if (!runtime) {
        return false;
      }
      runtimes.delete(acct);
      await runtime.destroy();
      await registry.remove(acct);
      return true;
    },
    getConfig: (acct) => runtimes.get(acct)?.record().config,
    handle: (acct) => runtimes.get(acct)?.handle,
    health: () => [...runtimes.values()].map((r) => r.health()),
    joinGroup: (acct, invite) => require(acct).joinGroup(invite),
    async link(acct, phone) {
      const runtime = require(acct);
      let digits: string | null = null;
      if (phone) {
        digits = phone.replaceAll(/[\s+()-]/gu, "");
        if (!/^\d{6,20}$/u.test(digits)) {
          throw new HttpError(400, "phone must be digits in international format, no +");
        }
        const next = await registry.setPhone(acct, digits);
        await runtime.applyRecord(next);
      }
      return runtime.link(digits);
    },
    linkState: (acct) => runtimes.get(acct)?.linkState(),
    listAccounts: () => [...runtimes.values()].map((r) => r.summary()),
    listGroups: (acct) => require(acct).listGroups(),
    async setConfig(acct, raw) {
      const runtime = require(acct);
      let config;
      try {
        config = parseAccountConfig(raw);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      const next = await registry.setConfig(acct, config);
      await runtime.applyRecord(next);
      return next.config;
    },
  };

  // Every account in the file gets a socket on boot; failures are per account.
  await Promise.all(registry.list().map((record) => boot(spawn(record))));

  const server = startServer({
    api,
    host: env.host,
    logger,
    // The route body is a base64 image (4/3 inflation) plus the JSON envelope.
    maxMediaBody: Math.ceil((env.maxSendMediaBytes * 4) / 3) + 64 * 1024,
    port: env.port,
    secret: env.bridgeSecret,
  });
  logger.info(
    { accounts: registry.list().length, host: env.host, port: env.port },
    "bridge HTTP API listening",
  );

  /**
   * Drain in-flight handlers, flush state, and close cleanly. Sockets are
   * ended, never logged out: a logout would unlink the device and force a
   * re-pair on every deploy.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down: draining in-flight work");
    await Promise.all([...runtimes.values()].map((r) => r.stop()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // The hub and the Bot tools reach us through fetch, which pools
      // connections, so close() would sit on sockets that are idle but open
      // until keepAliveTimeout. In-flight requests are untouched: this drops
      // only the connections with nothing on them.
      server.closeIdleConnections();
    });
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error) => {
  logger.error({ error }, "fatal");
  process.exit(1);
});
