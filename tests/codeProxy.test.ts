import test from "node:test";
import assert from "node:assert/strict";
import { CodeProxyHandler } from "../src/runtime/codeProxy.js";
import type { Logger } from "../src/runtime/log.js";
import type { CloudManager } from "../src/runtime/cloud/manager.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { EventEmitter } from "node:events";

// Create mock logger
function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// Create mock CloudManager
function createMockCloudManager(vscodeUrl: string | null): Partial<CloudManager> {
  return {
    getVscodeUrl: async () => vscodeUrl,
  };
}

// Create mock IncomingMessage
function createMockRequest(
  url: string,
  headers: Record<string, string | string[]> = {},
  method = "GET",
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = {
    host: "localhost",
    ...headers,
  };
  return req;
}

// Create mock ServerResponse
function createMockResponse(): ServerResponse & {
  _statusCode: number;
  _headers: Map<string, string>;
  _body: string;
  _ended: boolean;
  _headersSent: boolean;
} {
  const res = new EventEmitter() as ServerResponse & {
    _statusCode: number;
    _headers: Map<string, string>;
    _body: string;
    _ended: boolean;
    _headersSent: boolean;
  };
  res._statusCode = 200;
  res._headers = new Map();
  res._body = "";
  res._ended = false;
  res._headersSent = false;

  Object.defineProperty(res, "statusCode", {
    get: () => res._statusCode,
    set: (v: number) => {
      res._statusCode = v;
    },
  });

  Object.defineProperty(res, "headersSent", {
    get: () => res._headersSent,
  });

  res.setHeader = (name: string, value: string | number | readonly string[]) => {
    res._headers.set(name.toLowerCase(), String(value));
    return res;
  };

  res.end = (data?: unknown) => {
    if (data) res._body += String(data);
    res._ended = true;
    return res;
  };

  res.write = (data: unknown) => {
    res._body += String(data);
    return true;
  };

  return res;
}

// Create mock Duplex socket
function createMockSocket(): Duplex & {
  _written: string;
  _destroyed: boolean;
} {
  const socket = new EventEmitter() as Duplex & {
    _written: string;
    _destroyed: boolean;
  };
  socket._written = "";
  socket._destroyed = false;

  socket.write = (data: unknown) => {
    socket._written += String(data);
    return true;
  };

  socket.destroy = () => {
    socket._destroyed = true;
    return socket;
  };

  return socket;
}

test("CodeProxyHandler.handleRequest returns 503 when tunnel URL unavailable", async () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager(null);
  const handler = new CodeProxyHandler(cloudManager as CloudManager, logger);

  const req = createMockRequest("/test");
  const res = createMockResponse();

  await handler.handleRequest("session-123", req, res, "/test");

  assert.equal(res._statusCode, 503);
  assert.equal(res._headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(res._body.includes("Code server not available"));
});

test("CodeProxyHandler.handleUpgrade sends error when no tunnel URL", async () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager(null);
  const handler = new CodeProxyHandler(cloudManager as CloudManager, logger);

  const req = createMockRequest("/ws", {
    upgrade: "websocket",
    "sec-websocket-key": "test-key",
    "sec-websocket-version": "13",
  });
  const socket = createMockSocket();
  const head = Buffer.alloc(0);

  await handler.handleUpgrade("session-123", req, socket, head, "/ws");

  assert.ok(socket._written.includes("HTTP/1.1 503"));
  assert.ok(socket._written.includes("Code server not available"));
  assert.ok(socket._destroyed);
});

test("CodeProxyHandler.handleUpgrade sends 500 on internal error", async () => {
  const logger = createMockLogger();
  const cloudManager = {
    getVscodeUrl: async () => {
      throw new Error("Internal error");
    },
  } as unknown as CloudManager;
  const handler = new CodeProxyHandler(cloudManager, logger);

  const req = createMockRequest("/ws", {
    upgrade: "websocket",
    "sec-websocket-key": "test-key",
    "sec-websocket-version": "13",
  });
  const socket = createMockSocket();
  const head = Buffer.alloc(0);

  await handler.handleUpgrade("session-123", req, socket, head, "/ws");

  assert.ok(socket._written.includes("HTTP/1.1 500"));
  assert.ok(socket._written.includes("Internal server error"));
  assert.ok(socket._destroyed);
});

// Test private methods by creating a subclass that exposes them
class TestableCodeProxyHandler extends CodeProxyHandler {
  public testBuildUpstreamHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string> {
    // Access private method via prototype - use explicit type assertion
    type PrivateMethods = {
      buildUpstreamHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string>;
      buildWebSocketHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string>;
      rewriteLocationHeader(location: string, tunnelUrl: string, sessionId: string): string;
      sendUpgradeError(socket: Duplex, status: number, message: string): void;
    };
    return (this as unknown as PrivateMethods).buildUpstreamHeaders(req, tunnelUrl);
  }

  public testBuildWebSocketHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string> {
    type PrivateMethods = {
      buildWebSocketHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string>;
    };
    return (this as unknown as PrivateMethods).buildWebSocketHeaders(req, tunnelUrl);
  }

  public testRewriteLocationHeader(location: string, tunnelUrl: string, sessionId: string): string {
    type PrivateMethods = {
      rewriteLocationHeader(location: string, tunnelUrl: string, sessionId: string): string;
    };
    return (this as unknown as PrivateMethods).rewriteLocationHeader(location, tunnelUrl, sessionId);
  }

  public testSendUpgradeError(socket: Duplex, status: number, message: string): void {
    type PrivateMethods = {
      sendUpgradeError(socket: Duplex, status: number, message: string): void;
    };
    return (this as unknown as PrivateMethods).sendUpgradeError(socket, status, message);
  }
}

test("buildUpstreamHeaders sets correct host header", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const req = createMockRequest("/test", {
    host: "localhost:3000",
    "user-agent": "test-agent",
    "x-custom": "value",
  });

  const headers = handler.testBuildUpstreamHeaders(req, "https://tunnel.example.com");

  assert.equal(headers["host"], "tunnel.example.com");
  assert.equal(headers["user-agent"], "test-agent");
  assert.equal(headers["x-custom"], "value");
});

test("buildUpstreamHeaders skips connection headers", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const req = createMockRequest("/test", {
    host: "localhost:3000",
    connection: "upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "test-key",
  });

  const headers = handler.testBuildUpstreamHeaders(req, "https://tunnel.example.com");

  assert.equal(headers["connection"], undefined);
  assert.equal(headers["upgrade"], undefined);
  assert.equal(headers["sec-websocket-key"], undefined);
});

test("buildWebSocketHeaders includes origin header", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const req = createMockRequest("/ws", {
    host: "localhost:3000",
    "user-agent": "test-agent",
  });

  const headers = handler.testBuildWebSocketHeaders(req, "https://tunnel.example.com");

  assert.equal(headers["host"], "tunnel.example.com");
  assert.equal(headers["origin"], "https://tunnel.example.com");
  assert.equal(headers["user-agent"], "test-agent");
});

test("rewriteLocationHeader rewrites same-host URLs", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const rewritten = handler.testRewriteLocationHeader(
    "https://tunnel.example.com/new/path?query=1",
    "https://tunnel.example.com",
    "session-123",
  );

  assert.equal(rewritten, "/api/code-proxy/session-123/new/path?query=1");
});

test("rewriteLocationHeader preserves external URLs", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const rewritten = handler.testRewriteLocationHeader(
    "https://external.example.com/path",
    "https://tunnel.example.com",
    "session-123",
  );

  assert.equal(rewritten, "https://external.example.com/path");
});

test("rewriteLocationHeader handles relative URLs", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const rewritten = handler.testRewriteLocationHeader(
    "/relative/path",
    "https://tunnel.example.com",
    "session-123",
  );

  assert.equal(rewritten, "/api/code-proxy/session-123/relative/path");
});

test("rewriteLocationHeader handles invalid URLs gracefully", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  // Invalid URL that can't be parsed
  const rewritten = handler.testRewriteLocationHeader(
    "not:a:valid:url::::",
    "https://tunnel.example.com",
    "session-123",
  );

  // Should return original on parse error
  assert.equal(rewritten, "not:a:valid:url::::");
});

test("sendUpgradeError formats HTTP response correctly", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const socket = createMockSocket();

  handler.testSendUpgradeError(socket, 503, "Service Unavailable");

  assert.ok(socket._written.includes("HTTP/1.1 503 Service Unavailable\r\n"));
  assert.ok(socket._written.includes("Content-Type: text/plain\r\n"));
  assert.ok(socket._written.includes("Connection: close\r\n"));
  assert.ok(socket._written.includes("Service Unavailable"));
  assert.ok(socket._destroyed);
});

test("buildUpstreamHeaders handles array header values", () => {
  const logger = createMockLogger();
  const cloudManager = createMockCloudManager("https://tunnel.example.com");
  const handler = new TestableCodeProxyHandler(cloudManager as CloudManager, logger);

  const req = createMockRequest("/test", {
    "accept-language": ["en-US", "en;q=0.9"],
  });

  const headers = handler.testBuildUpstreamHeaders(req, "https://tunnel.example.com");

  assert.equal(headers["accept-language"], "en-US, en;q=0.9");
});
