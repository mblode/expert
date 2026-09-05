import { lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Never boot an agent over ephemeral or unexpectedly redirected workflow state. */
export function ensureWorkflowState(link: string, target: string): void {
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  try {
    lstatSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    symlinkSync(target, link);
  }
  if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(target)) {
    throw new Error(
      `workflow state ${link} must point to ${target}; preserve and migrate existing state before starting the computer`,
    );
  }
}
