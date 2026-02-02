/**
 * VSDA Stub for code-server browser mode
 *
 * VS Code's signService loads this module via AMD loader (not ES modules).
 * This stub satisfies the module interface without providing real cryptographic signing.
 *
 * Expected by: src/vs/platform/sign/browser/signService.ts
 * Loading mechanism: <script type="text/javascript"> (NOT type="module")
 *
 * Compatibility:
 * - AMD define() calls (VS Code's primary mechanism)
 * - Global vsda_web (VS Code's fallback mechanism)
 * - CommonJS require() / ES module import() for Node.js testing
 */

// Stub signature value - unique per load
var STUB_SIGNATURE = 'stub-signature-' + Date.now().toString(36);

/**
 * Sign a message (stub implementation)
 * @param {string} salted_message - The message to sign
 * @returns {string} A stub signature
 */
function sign(salted_message) {
  return STUB_SIGNATURE;
}

/**
 * Verify a signature (stub implementation - always returns true)
 * @returns {boolean} Always true
 */
function verify() {
  return true;
}

/**
 * Create a signer object (stub implementation)
 * @returns {object} Signer with sign() and free() methods
 */
function create_signer() {
  return {
    sign: function() { return STUB_SIGNATURE; },
    free: function() { /* no-op */ }
  };
}

/**
 * Create a validator object (stub implementation)
 * @returns {object} Validator with validate() and free() methods
 */
function create_validator() {
  return {
    validate: function() { return true; },
    free: function() { /* no-op */ }
  };
}

/**
 * Validator class (expected by VS Code's signService)
 * @constructor
 */
function Validator() {
  // Constructor - no initialization needed for stub
}

Validator.prototype.free = function() {
  // No-op for stub
};

Validator.prototype.createNewMessage = function(original) {
  // Return the original message with a stub prefix
  return 'stub:' + (original || '');
};

Validator.prototype.validate = function(signed_message) {
  // Always return 'ok' for stub
  return 'ok';
};

/**
 * Initialize the WASM module (stub implementation)
 * @param {ArrayBuffer|WebAssembly.Module} module_or_path - WASM bytes (ignored)
 * @returns {Promise} Resolves immediately
 */
function init(module_or_path) {
  return Promise.resolve();
}

// WASM glue stubs (expected by wasm-bindgen generated code)
function __wbg_set_wasm() { /* no-op */ }
function initSync() { /* no-op */ }

// Create exports object
var _exports = {
  sign: sign,
  verify: verify,
  create_signer: create_signer,
  create_validator: create_validator,
  validator: Validator,
  __wbg_set_wasm: __wbg_set_wasm,
  initSync: initSync,
  default: init
};

// For compatibility with different import styles
init.sign = sign;
init.verify = verify;
init.validator = Validator;

// Environment detection and export
(function(root, exports) {
  // AMD: VS Code's primary loading mechanism
  if (typeof define === 'function' && define.amd) {
    define(['exports'], function(amdExports) {
      Object.keys(exports).forEach(function(key) {
        amdExports[key] = exports[key];
      });
    });
  }

  // CommonJS / Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  // Global: VS Code's fallback mechanism (checks for vsda_web)
  if (typeof root !== 'undefined') {
    root.vsda_web = exports;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : {}, _exports);

// For ES module compatibility (when imported via import())
if (typeof module !== 'undefined' && module.exports) {
  module.exports.sign = sign;
  module.exports.verify = verify;
  module.exports.create_signer = create_signer;
  module.exports.create_validator = create_validator;
  module.exports.validator = Validator;
  module.exports.default = init;
  module.exports.__wbg_set_wasm = __wbg_set_wasm;
  module.exports.initSync = initSync;
}
