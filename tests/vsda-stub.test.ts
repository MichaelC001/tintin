import { describe, it, before } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Navigate from dist/tests to project root, then to image/vsda-stub
const stubDir = resolve(__dirname, "..", "..", "image", "vsda-stub");

describe("vsda stub files", () => {
  describe("vsda.js", () => {
    let vsdaModule: Record<string, unknown>;

    before(async () => {
      const vsdaPath = join(stubDir, "vsda.js");
      vsdaModule = await import(vsdaPath);
    });

    it("exports sign function", () => {
      assert.strictEqual(typeof vsdaModule.sign, "function");
    });

    it("exports verify function", () => {
      assert.strictEqual(typeof vsdaModule.verify, "function");
    });

    it("exports create_signer function", () => {
      assert.strictEqual(typeof vsdaModule.create_signer, "function");
    });

    it("exports create_validator function", () => {
      assert.strictEqual(typeof vsdaModule.create_validator, "function");
    });

    it("sign() returns valid signature string", () => {
      const sign = vsdaModule.sign as () => string;
      const result = sign();
      assert.strictEqual(typeof result, "string");
      assert.ok(result.length > 0, "signature should be non-empty");
    });

    it("verify() returns true", () => {
      const verify = vsdaModule.verify as () => boolean;
      const result = verify();
      assert.strictEqual(result, true);
    });

    it("create_signer() returns object with sign method", () => {
      const createSigner = vsdaModule.create_signer as () => {
        sign: () => string;
        free: () => void;
      };
      const signer = createSigner();
      assert.strictEqual(typeof signer.sign, "function");
      assert.strictEqual(typeof signer.free, "function");
      assert.strictEqual(typeof signer.sign(), "string");
    });

    it("create_validator() returns object with validate method", () => {
      const createValidator = vsdaModule.create_validator as () => {
        validate: () => boolean;
        free: () => void;
      };
      const validator = createValidator();
      assert.strictEqual(typeof validator.validate, "function");
      assert.strictEqual(typeof validator.free, "function");
      assert.strictEqual(validator.validate(), true);
    });

    it("has default export with expected methods", () => {
      assert.ok(vsdaModule.default);
      const defaultExport = vsdaModule.default as Record<string, unknown>;
      assert.strictEqual(typeof defaultExport.sign, "function");
      assert.strictEqual(typeof defaultExport.verify, "function");
    });
  });

  describe("vsda_bg.wasm", () => {
    it("file exists", () => {
      const wasmPath = join(stubDir, "vsda_bg.wasm");
      assert.ok(existsSync(wasmPath), "vsda_bg.wasm should exist");
    });

    it("is valid WebAssembly binary (magic number)", () => {
      const wasmPath = join(stubDir, "vsda_bg.wasm");
      const buffer = readFileSync(wasmPath);

      // WASM magic number: 0x00 0x61 0x73 0x6d ('\0asm')
      assert.ok(buffer.length >= 4, "WASM file should be at least 4 bytes");
      assert.strictEqual(buffer[0], 0x00, "byte 0 should be 0x00");
      assert.strictEqual(buffer[1], 0x61, "byte 1 should be 0x61 ('a')");
      assert.strictEqual(buffer[2], 0x73, "byte 2 should be 0x73 ('s')");
      assert.strictEqual(buffer[3], 0x6d, "byte 3 should be 0x6d ('m')");
    });

    it("has valid version number", () => {
      const wasmPath = join(stubDir, "vsda_bg.wasm");
      const buffer = readFileSync(wasmPath);

      // WASM version 1: 0x01 0x00 0x00 0x00
      assert.ok(buffer.length >= 8, "WASM file should be at least 8 bytes");
      assert.strictEqual(buffer[4], 0x01, "version byte 0 should be 0x01");
      assert.strictEqual(buffer[5], 0x00, "version byte 1 should be 0x00");
      assert.strictEqual(buffer[6], 0x00, "version byte 2 should be 0x00");
      assert.strictEqual(buffer[7], 0x00, "version byte 3 should be 0x00");
    });

    it("can be instantiated as WebAssembly module", async () => {
      const wasmPath = join(stubDir, "vsda_bg.wasm");
      const buffer = readFileSync(wasmPath);
      // Use dynamic import to compile WASM (available in Node.js)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WasmGlobal = (globalThis as any).WebAssembly;
      const compiled = await WasmGlobal.compile(buffer);
      assert.ok(compiled instanceof WasmGlobal.Module);
    });
  });
});
