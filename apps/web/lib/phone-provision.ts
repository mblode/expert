import { machineConfig, COMPUTER_REGION, COMPUTER_VOLUME_GB } from "@computer/shared/fly-computer";
import type { PhoneAccount } from "./phone-account";
import {
  advancePhone,
  leasePhone,
  releasePhone,
  pendingPhoneMessages,
  markPhoneDelivered,
} from "./phone-account";
import { activatePhoneConnection, connectionForSender } from "./whatsapp-connection";

export function automaticSignupEnabled() {
  return process.env.EXPERT_AUTOMATIC_SIGNUP === "on";
}
/** Provider errors never include response bodies, request payloads or credentials. */
export class PhoneProvisioner {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async request(url: string, method: string, body?: unknown, token?: string) {
    const response = await this.fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response;
  }
  private async fly(path: string, method = "GET", body?: unknown) {
    const token = this.env.EXPERT_FLY_TOKEN;
    if (!token) throw new Error("Provisioning is not configured");
    return this.request(`https://api.machines.dev/v1${path}`, method, body, token);
  }
  private async gql(query: string, variables: unknown) {
    const response = await this.request(
      "https://api.fly.io/graphql",
      "POST",
      { query, variables },
      this.env.EXPERT_FLY_TOKEN,
    );
    if (!response.ok) throw new Error(`Fly control request failed (${response.status})`);
    const data = await response.json();
    if (data.errors) throw new Error("Fly control request refused");
    return data.data;
  }
  private async checked(response: Response) {
    if (!response.ok) throw new Error(`Provisioning request failed (${response.status})`);
    return response.json();
  }
  async step(row: PhoneAccount): Promise<string> {
    const base = `/apps/${row.app}`;
    switch (row.stage) {
      case "app": {
        const existing = await this.fly(base);
        if (existing.status === 404) {
          await this.checked(
            await this.fly("/apps", "POST", {
              app_name: row.app,
              org_slug: this.env.EXPERT_FLY_ORG ?? "personal",
            }),
          );
        } else {
          const app = await this.checked(existing);
          if (
            app.name !== row.app ||
            app.organization?.slug !== (this.env.EXPERT_FLY_ORG ?? "personal")
          )
            throw new Error("Computer identity mismatch");
        }
        return "secrets";
      }
      case "secrets": {
        const modelKey = row.model_key;
        if (!modelKey) throw new Error("Assistant model is not configured");
        const values = {
          COMPUTER_SETUP_CODE: row.setup_code,
          AI_GATEWAY_API_KEY: modelKey,
          COMPUTER_SHARED_WHATSAPP: "on",
          COMPUTER_PA_ACCOUNT: row.id,
          COMPUTER_PA_OWNER_JID: row.jid,
          WHATSAPP_BRIDGE_SECRET: row.delivery_secret,
          COMPUTER_BRIDGE_URL:
            this.env.EXPERT_BRIDGE_URL ?? "https://vcmc-bridge-production.up.railway.app",
          COMPUTER_PUBLIC_URL: `https://${row.app}.fly.dev`,
          COMPUTER_WEB_URL: "https://hello.expert",
          COMPUTER_CLOCK_URL: "http://expert-clock.internal:8080",
          COMPUTER_CLOCK_TENANT: row.app,
          COMPUTER_CLOCK_SECRET: row.clock_secret,
        };
        await this.gql(
          "mutation($input: SetSecretsInput!) { setSecrets(input: $input) { release { id } } }",
          {
            input: {
              appId: row.app,
              secrets: Object.entries(values).map(([key, value]) => ({ key, value })),
            },
          },
        );
        return "address";
      }
      case "address": {
        const data = await this.gql(
          "query($name: String!) { app(name: $name) { sharedIpAddress } }",
          { name: row.app },
        );
        if (!data.app?.sharedIpAddress)
          await this.gql(
            "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }",
            { input: { appId: row.app, type: "shared_v4" } },
          );
        return "volume";
      }
      case "volume": {
        const volumes = await this.checked(await this.fly(`${base}/volumes`));
        if (!Array.isArray(volumes) || volumes.length > 1)
          throw new Error("Ambiguous computer volume");
        if (!volumes.length)
          await this.checked(
            await this.fly(`${base}/volumes`, "POST", {
              name: "computer_workspace",
              region: COMPUTER_REGION,
              size_gb: COMPUTER_VOLUME_GB,
            }),
          );
        return "machine";
      }
      case "machine": {
        const machines = await this.checked(await this.fly(`${base}/machines`));
        if (!Array.isArray(machines) || machines.length > 1)
          throw new Error("Ambiguous computer Machine");
        if (!machines.length) {
          const volumes = await this.checked(await this.fly(`${base}/volumes`));
          if (volumes.length !== 1 || typeof volumes[0].id !== "string")
            throw new Error("Missing computer volume");
          const image = this.env.EXPERT_COMPUTER_IMAGE;
          if (!image) throw new Error("Computer image is not configured");
          await this.checked(
            await this.fly(`${base}/machines`, "POST", {
              name: "computer",
              region: COMPUTER_REGION,
              config: machineConfig(
                { app: row.app, org: this.env.EXPERT_FLY_ORG ?? "personal", image },
                volumes[0].id,
              ),
            }),
          );
        }
        return "health";
      }
      case "health": {
        const response = await this.request(`https://${row.app}.fly.dev/healthz`, "GET");
        const body = await this.checked(response);
        if (body.ok !== true || body.hub !== true) throw new Error("Computer is starting");
        return "bind";
      }
      case "bind": {
        const url = `https://${row.app}.fly.dev/computer.v1.Seat/`;
        const pair = await this.checked(
          await this.request(`${url}Pair`, "POST", { code: row.setup_code }),
        );
        if (typeof pair.token !== "string") throw new Error("Pairing did not return a credential");
        try {
          const credentials = await this.checked(
            await this.request(
              `${url}WhatsAppConnect`,
              "POST",
              { action: "bind", jid: row.jid },
              pair.token,
            ),
          );
          await activatePhoneConnection(row.id, `https://${row.app}.fly.dev`, row.jid, credentials);
        } finally {
          await this.request(`${url}Revoke`, "POST", {}, pair.token);
        }
        return "ready";
      }
      default: {
        throw new Error("Unknown provisioning stage");
      }
    }
  }
  async deliver(row: PhoneAccount) {
    const route = await connectionForSender(row.jid);
    if (!route || route.hub_url !== `https://${row.app}.fly.dev`)
      throw new Error("Private route is not ready");
    for (const message of await pendingPhoneMessages(row.id)) {
      const body = JSON.parse(message.body);
      const response = await this.fetchImpl(
        `${route.hub_url}/connectors/${encodeURIComponent(route.connector_id)}/message`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
          headers: {
            "content-type": "application/json",
            "x-connector-secret": route.connector_secret,
          },
          body: JSON.stringify({
            ...body,
            acct: route.acct,
            token: row.jid,
            sender: row.jid,
            senderPhone: row.jid.split("@")[0],
            surface: "dm",
          }),
        },
      );
      if (!response.ok) throw new Error("First message delivery deferred");
      await markPhoneDelivered(row.id, message.message_id);
    }
  }
}
/** Both ingress and the independent clock drive this lease, so a killed request is recoverable. */
export async function provisionNextPhone() {
  const row = await leasePhone();
  if (!row) return;
  const provider = new PhoneProvisioner();
  const deadline = Date.now() + 85_000;
  try {
    while (row.stage !== "ready" && Date.now() < deadline)
      await advancePhone(row, await provider.step(row));
    if (row.stage === "ready") await provider.deliver(row);
  } catch {
    console.warn("phone provisioning deferred", { account: row.id, stage: row.stage });
  } finally {
    await releasePhone(row);
  }
}
