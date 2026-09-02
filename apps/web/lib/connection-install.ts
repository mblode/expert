import { acceptedStaticKey, connectionView, planConnectionFile } from "./connection-file";
import type { ConnectionFailure, ConnectionView } from "./connection-file";

export interface InstallResult {
  installed: boolean;
  plugin: ConnectionView;
}

/**
 * Author the Eve connection file and try to write it onto the guest
 * overlay. The guest write is still a stub: hello.expert has a seat
 * token, not an agent token, and Agent.WriteFile is the model's door.
 * The POST still returns the file-shaped view with no credential.
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
  }
  return {
    installed,
    plugin: connectionView(planned, { hasCredential }),
  };
}
