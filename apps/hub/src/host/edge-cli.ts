/**
 * Always-on Fly edge process. See edge-server.ts for the HTTP + Upgrade proxy.
 */
import { maybeIdleSuspend } from "./edge.ts";
import { createEdgeServer } from "./edge-server.ts";

const port = Number(process.env.COMPUTER_PORT ?? 8080);
const bind = process.env.COMPUTER_BIND ?? "0.0.0.0";
const { server, lastUse, guestId, idleSuspendMs } = createEdgeServer();

server.listen(port, bind, () => {
  console.log(`computer edge on http://${bind}:${port} (idle suspend ${idleSuspendMs / 1000}s)`);
});

setInterval(() => {
  const id = guestId();
  if (!id) return;
  void maybeIdleSuspend(lastUse, { guestId: id, idleSuspendMs }).catch((err) => {
    console.error("idle suspend", err);
  });
}, 60_000);
