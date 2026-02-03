import test from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "../src/runtime/log.js";
import type { CloudModalSection } from "../src/runtime/config.js";
import { ModalCloudProvider } from "../src/runtime/cloud/modalProvider.js";

type ExecResult = {
  stdout: { readText: () => Promise<string> };
  stderr: { readText: () => Promise<string> };
  wait: () => Promise<number>;
};

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeConfig(overrides?: Partial<CloudModalSection>): CloudModalSection {
  return {
    token_id: "",
    token_secret: "",
    environment: "",
    endpoint: "",
    app_name: "tintin-cloud",
    image: "debian:12",
    image_id: "",
    image_next: "",
    image_express: "",
    image_flask: "",
    timeout_ms: 300_000,
    idle_timeout_ms: 300_000,
    request_timeout_ms: 60_000,
    command_timeout_ms: 60_000,
    block_network: false,
    cidr_allowlist: [],
    workspace_root: "/workspace/tintin",
    codex_binary: "codex",
    claude_binary: "claude",
    ...overrides,
  };
}

function makeProc(stdout = "", stderr = "", exitCode = 0): ExecResult {
  return {
    stdout: { readText: async () => stdout },
    stderr: { readText: async () => stderr },
    wait: async () => exitCode,
  };
}

function createFakeSandbox(execHandler?: (command: string[], params: any) => ExecResult) {
  const files = new Map<string, Uint8Array>();
  const calls: Array<{ command: string[]; params: any }> = [];
  let killed = false;

  const sandbox: any = {
    sandboxId: "sb-test",
    open: async (target: string) => {
      let buffer = Buffer.alloc(0);
      return {
        write: async (data: Uint8Array) => {
          buffer = Buffer.concat([buffer, Buffer.from(data)]);
        },
        flush: async () => {},
        close: async () => {
          files.set(target, buffer);
        },
      };
    },
    exec: async (command: string[], params: any) => {
      calls.push({ command, params });
      return execHandler ? execHandler(command, params) : makeProc();
    },
    terminate: async () => {
      killed = true;
    },
    snapshotFilesystem: async () => ({ imageId: "im-snap" }),
    tunnels: async () => ({}),
    __state: {
      files,
      calls,
      get killed() {
        return killed;
      },
    },
  };

  return sandbox;
}

function createFakeClient(sandbox: any) {
  const app = { appId: "app-test" };
  const image = { imageId: "im-base" };
  return {
    apps: { fromName: async () => app },
    images: { fromId: async () => image, fromRegistry: () => image },
    sandboxes: { create: async () => sandbox },
  } as any;
}

test("ModalCloudProvider createWorkspace uses modal client and workspace root", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });

  const workspace = await provider.createWorkspace({ prefix: "test" });
  assert.equal(workspace.id, "sb-test");
  assert.equal(workspace.rootPath, "/workspace/tintin");
});

test("ModalCloudProvider uploadFiles writes files and chmods", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});
  sandbox.__state.calls.length = 0;

  await provider.uploadFiles(workspace, [
    { path: "a.txt", content: "hello", mode: "0644" },
    { path: "b.txt", content: Buffer.from("world") },
  ]);

  const commands = sandbox.__state.calls.map((c: any) => c.command[2]);
  assert.ok(commands.some((cmd: string) => cmd.includes("chmod 644")));
  assert.ok(sandbox.__state.files.has("/workspace/tintin/a.txt"));
  assert.ok(sandbox.__state.files.has("/workspace/tintin/b.txt"));
});

test("ModalCloudProvider runCommands forwards env and cwd", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});
  sandbox.__state.calls.length = 0;

  await provider.runCommands({
    workspace,
    cwd: "/workspace/tintin/repo",
    commands: ["echo 1", "echo 2"],
    env: { HELLO: "world" },
  });

  assert.equal(sandbox.__state.calls.length, 2);
  assert.equal(sandbox.__state.calls[0].params.workdir, "/workspace/tintin/repo");
  assert.equal(sandbox.__state.calls[0].params.env.HELLO, "world");
});

test("ModalCloudProvider snapshotWorkspace returns image id", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});

  const snapshotId = await provider.snapshotWorkspace(workspace, "setup");
  assert.equal(snapshotId, "im-snap");
});

test("ModalCloudProvider pullDiff uses stdout on command error", async () => {
  const sandbox = createFakeSandbox((command) => {
    if (command[2] === "git diff") return makeProc("diff-output", "", 1);
    return makeProc();
  });
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});

  const diff = await provider.pullDiff({ workspace, cwd: "/workspace/tintin/repo" });
  assert.equal(diff.diff, "diff-output");
});

test("ModalCloudProvider getPreviewPort returns 4100", () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  assert.equal(provider.getPreviewPort(), 4100);
});

test("ModalCloudProvider setupPreviewProxy stops existing and starts new socat", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  await provider.createWorkspace({});
  sandbox.__state.calls.length = 0;

  await provider.setupPreviewProxy("sb-test", 5173);

  const commands = sandbox.__state.calls.map((c: any) => c.command[2]);
  assert.equal(commands.length, 2);
  // First command should be the stop command (checking PID file)
  assert.ok(commands[0].includes("/tmp/preview-socat.pid"));
  assert.ok(commands[0].includes("kill"));
  // Second command should start socat with correct ports
  assert.ok(commands[1].includes("socat"));
  assert.ok(commands[1].includes("TCP-LISTEN:4100"));
  assert.ok(commands[1].includes("TCP:127.0.0.1:5173"));
  assert.ok(commands[1].includes("echo $! > /tmp/preview-socat.pid"));
});

test("ModalCloudProvider setupPreviewProxy throws if sandbox missing", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  // Don't create workspace, so sandbox is not registered

  await assert.rejects(
    () => provider.setupPreviewProxy("non-existent", 5173),
    /Missing sandbox/
  );
});

test("ModalCloudProvider stopPreviewProxy kills by PID file", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  await provider.createWorkspace({});
  sandbox.__state.calls.length = 0;

  await provider.stopPreviewProxy("sb-test");

  const commands = sandbox.__state.calls.map((c: any) => c.command[2]);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("/tmp/preview-socat.pid"));
  assert.ok(commands[0].includes("kill"));
});

test("ModalCloudProvider stopPreviewProxy does not throw if sandbox missing", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  // Don't create workspace

  await assert.doesNotReject(() => provider.stopPreviewProxy("non-existent"));
});

test("ModalCloudProvider createWorkspace includes preview port in encryptedPorts", async () => {
  let capturedParams: any = null;
  const sandbox = createFakeSandbox();
  const client = {
    apps: { fromName: async () => ({ appId: "app-test" }) },
    images: { fromId: async () => ({ imageId: "im-base" }), fromRegistry: () => ({ imageId: "im-base" }) },
    sandboxes: {
      create: async (_app: any, _image: any, params: any) => {
        capturedParams = params;
        return sandbox;
      },
    },
  } as any;
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client });

  await provider.createWorkspace({ prefix: "test" });

  assert.ok(capturedParams);
  assert.ok(Array.isArray(capturedParams.encryptedPorts));
  assert.ok(capturedParams.encryptedPorts.includes(4100), "should include preview port 4100");
  assert.ok(capturedParams.encryptedPorts.includes(8080), "should include code-server port 8080");
  assert.ok(capturedParams.encryptedPorts.includes(9223), "should include devtools port 9223");
});
