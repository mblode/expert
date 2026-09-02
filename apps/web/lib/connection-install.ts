import { acceptedStaticKey, connectionView, planConnectionFile } from "./connection-file";
import type { ConnectionFailure, ConnectionView } from "./connection-file";

export interface InstallResult {
  installed: boolean;
  plugin: ConnectionView;
}

/**
 * Author the Eve connection file and write it onto the guest overlay.
 * The write is Pair + CreateBot + Agent.WriteFile + DeleteBot: hello.expert
 * holds a seat token, and WriteFile is the model's door.
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
