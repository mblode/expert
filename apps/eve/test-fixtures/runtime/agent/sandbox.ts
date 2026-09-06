import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// The production Bot's sandbox (apps/eve/bots/main/agent/sandbox.ts),
// repeated rather than imported because the fixture is copied to a temp
// directory with only `lib` beside it. The runtime check has to build and
// serve with one: a tenant skill writes itself into the sandbox on the first
// turn, and that is the path that failed in production while this check
// passed without it.
export default defineSandbox({
  backend: justbash(),
});
