import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { hubLoopbackAuth } from "../../../../lib/auth.ts";

export default eveChannel({
  auth: [hubLoopbackAuth(), localDev()],
});
