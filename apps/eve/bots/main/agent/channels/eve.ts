import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { hubLoopbackAuth } from "../../../../lib/auth.ts";

export default eveChannel({
  auth: [
    // Hub → Eve on loopback (`eve start`). The hub already checked the seat token.
    hubLoopbackAuth(),
    // `eve dev` / REPL only. Ignored by `eve start`.
    localDev(),
  ],
});
