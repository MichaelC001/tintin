// Minimal vsda stub for code-server browser mode
// VS Code's signService calls these but signing isn't required for browser-based code-server
// This stub satisfies the module loader without providing real cryptographic signing

export function sign() {
  return "stub-signature";
}

export function verify() {
  return true;
}

export function create_signer() {
  return {
    sign: () => "stub-signature",
    free: () => {}
  };
}

export function create_validator() {
  return {
    validate: () => true,
    free: () => {}
  };
}

// WASM initialization stubs
export function __wbg_set_wasm() {}
export function initSync() {}
export async function default_() {}

export default {
  sign,
  verify,
  create_signer,
  create_validator,
  __wbg_set_wasm,
  initSync
};
