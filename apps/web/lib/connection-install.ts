import { acceptedStaticKey, connectionView, planConnectionFile } from "./connection-file";
import type { ConnectionFailure, ConnectionView } from "./connection-file";

export interface InstallResult {
  installed: boolean;
  plugin: ConnectionView;
}

/**
 * Author the Eve connection file and write it onto the guest overlay.
 *
 * `write` is CreateBot + Agent.WriteFile + DeleteBot on a two-minute
 * `installer` seat (`connection-guest.ts`), because WriteFile is the model's
 * door and takes an agent token, not a seat. There is no `Pair` behind it any
 * more: the seat is issued from the control plane's own grant, so nothing on
 * this path can reach a setup code.
 */
export async function installConnection(input: {
  authKind?: string;
  credential?: string;
  name?: string;
  url?: string;
  write?: (path: string, source: string) => Promise<boolean>;
}): Promise<InstallResult | ConnectionFailure> {
  const planned = planConnectionFile(input);
  if ("error" in planned) {
    return planned;
  }
  const hasCredential = acceptedStaticKey(planned.authKind, input.credential);
  let installed = false;
  if (input.write) {
    installed = await input.write(planned.guestPath, planned.source);
    if (!installed) {
      return { error: "Could not write the plugin onto the computer.", status: 502 };
    }
  }
  return {
    installed,
    plugin: connectionView(planned, { hasCredential }),
  };
}
