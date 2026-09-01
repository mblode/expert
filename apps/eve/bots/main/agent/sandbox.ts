import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// The guest has no Docker-in-Docker and no KVM. `defaultBackend()` already
// falls through to just-bash there; pin it so `eve start` does not try
// docker() / vercel(). This process drives the real box via hub tools
// (computer / shell / read_file / write_file). The eve sandbox exists only
// so production `eve start` can boot.
export default defineSandbox({
  backend: justbash(),
});
