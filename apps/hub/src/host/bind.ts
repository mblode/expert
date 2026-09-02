/**
 * Where the hub may listen.
 *
 * Local / Hetzner: loopback only: Tailscale Serve is the door.
 * Fly guest: 0.0.0.0 / :: so the Fly HTTPS proxy can reach the hub.
 * The Machine has no public IP of its own; the proxy is the TLS terminator.
 */
export function isCloudGuest(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FLY_APP_NAME || env.COMPUTER_CLOUD === "fly" || env.COMPUTER_CLOUD === "1");
}

export function allowedBind(bind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (bind === "127.0.0.1" || bind === "localhost") {
    return true;
  }
  if ((bind === "0.0.0.0" || bind === "::") && isCloudGuest(env)) {
    return true;
  }
  return false;
}

export function refuseBindMessage(bind: string): string {
  return `refusing to bind ${bind}, hub must stay on loopback locally (Tailscale Serve); 0.0.0.0 is only for the Fly guest`;
}
