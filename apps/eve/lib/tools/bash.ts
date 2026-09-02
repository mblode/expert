import { disableTool } from "eve/tools";

/**
 * just-bash exists only so `eve start` can boot the sandbox. The model
 * drives the real machine through hub `shell` / `computer`. Leaving the
 * built-in `bash` tool registered would be a second shell that can still
 * park on Approve.
 */
export default disableTool();
