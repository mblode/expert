import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// Same guest constraints as bots/main: no Docker-in-Docker, no KVM.
// Pin just-bash so `eve start` can init the sandbox on the Fly box.
export default defineSandbox({
  backend: justbash(),
});
