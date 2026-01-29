/**
 * CodeProxyHandler - Proxies requests to code-server with X-Frame-Options stripping.
 *
 * This module enables embedding code-server (Web VS Code) in an iframe by:
 * 1. Proxying HTTP requests to the Modal tunnel URL
 * 2. Stripping X-Frame-Options and CSP headers from responses
 * 3. Handling WebSocket upgrade for code-server's real-time features
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { CloudManager } from "./cloud/manager.js";
import type { Logger } from "./log.js";

/** Headers to strip from proxied responses to allow iframe embedding */
const STRIP_RESPONSE_HEADERS = [
  "x-frame-options",
  "content-security-policy",
  "x-content-type-options",
  "content-encoding", // fetch() auto-decompresses, so body is already uncompressed
  "content-length", // Length changes after decompression, let Node.js handle it
  "transfer-encoding", // Avoid chunked encoding conflicts with our streaming
];

/** Headers to not forward from client to upstream */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** HTTP status codes */
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_GATEWAY = 502;
const HTTP_INTERNAL_ERROR = 500;

/**
 * Check if a WebSocket close code can be sent in a close frame.
 * RFC 6455: codes 1005, 1006, 1015 are reserved and MUST NOT be sent.
 *
 * Valid codes: 1000-1003, 1007-1011, 3000-4999
 */
export function isValidCloseCode(code: number): boolean {
  // Reserved codes that cannot be sent in a close frame
  if (code === 1005 || code === 1006 || code === 1015) {
    return false;
  }
  // Standard codes (1000-1011) and private-use codes (3000-4999)
  return (code >= 1000 && code <= 1011) || (code >= 3000 && code <= 4999);
}

/**
 * CodeProxyHandler handles HTTP and WebSocket proxying to code-server.
 *
 * Follows SRP: Only responsible for proxying requests to code-server.
 * Follows DIP: Dependencies (CloudManager, Logger) injected via constructor.
 */
export class CodeProxyHandler {
  private readonly wss: WebSocketServer;

  constructor(
    private readonly cloudManager: CloudManager,
    private readonly logger: Logger,
  ) {
    // Create noServer mode WebSocketServer for manual upgrade handling
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Handle HTTP proxy request to code-server.
   *
   * @param sessionId - The session ID to get the tunnel URL for
   * @param req - Incoming HTTP request
   * @param res - HTTP response
   * @param pathSuffix - Path to forward (e.g., "/file.html")
   */
  async handleRequest(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
    pathSuffix: string,
  ): Promise<void> {
    try {
      const tunnelUrl = await this.cloudManager.getVscodeUrl(sessionId);
      if (!tunnelUrl) {
        this.sendError(res, HTTP_SERVICE_UNAVAILABLE, "Code server not available");
        return;
      }

      // Build target URL
      const targetUrl = new URL(pathSuffix || "/", tunnelUrl);

      // Copy query params from original request
      const originalUrl = new URL(req.url || "/", `http://localhost`);
      targetUrl.search = originalUrl.search;

      // Build headers for upstream request
      const headers = this.buildUpstreamHeaders(req, tunnelUrl);

      // Prepare fetch options
      const fetchOptions: RequestInit & { duplex?: string } = {
        method: req.method,
        headers,
        redirect: "manual", // Handle redirects manually to rewrite Location headers
      };

      // Forward request body for non-GET/HEAD methods
      if (req.method !== "GET" && req.method !== "HEAD") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchOptions.body = req as any;
        fetchOptions.duplex = "half";
      }

      const proxyRes = await fetch(targetUrl.toString(), fetchOptions);

      // Handle redirects - rewrite Location header to proxy URL
      if (proxyRes.status >= 300 && proxyRes.status < 400) {
        const location = proxyRes.headers.get("location");
        if (location) {
          const rewrittenLocation = this.rewriteLocationHeader(location, tunnelUrl, sessionId);
          res.setHeader("location", rewrittenLocation);
        }
      }

      // Set response status
      res.statusCode = proxyRes.status;

      // Copy response headers, stripping iframe-blocking ones
      for (const [key, value] of proxyRes.headers) {
        if (!STRIP_RESPONSE_HEADERS.includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      // Stream response body
      if (proxyRes.body) {
        const reader = proxyRes.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
    } catch (err) {
      this.logger.warn(`[code-proxy] request failed session=${sessionId}: ${String(err)}`);
      if (!res.headersSent) {
        this.sendError(res, HTTP_BAD_GATEWAY, "Proxy request failed");
      }
    }
  }

  /**
   * Handle WebSocket upgrade for code-server.
   *
   * Uses WebSocketServer.handleUpgrade() to properly upgrade the client connection,
   * ensuring both client and upstream are proper WebSocket objects with correct
   * frame encoding/decoding.
   *
   * @param sessionId - The session ID to get the tunnel URL for
   * @param req - Incoming HTTP request
   * @param clientSocket - Client socket
   * @param head - Buffer containing first data after upgrade request
   * @param pathSuffix - Path to forward
   */
  async handleUpgrade(
    sessionId: string,
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    pathSuffix: string,
  ): Promise<void> {
    try {
      const tunnelUrl = await this.cloudManager.getVscodeUrl(sessionId);
      if (!tunnelUrl) {
        this.logger.debug(`[code-proxy] ws upgrade failed: no tunnel url session=${sessionId}`);
        this.sendUpgradeError(clientSocket, HTTP_SERVICE_UNAVAILABLE, "Code server not available");
        return;
      }

      // Use wss.handleUpgrade to properly upgrade client connection
      this.wss.handleUpgrade(req, clientSocket, head, (clientWs) => {
        this.proxyWebSocket(sessionId, clientWs, tunnelUrl, pathSuffix, req);
      });
    } catch (err) {
      this.logger.warn(`[code-proxy] ws upgrade error session=${sessionId}: ${String(err)}`);
      this.sendUpgradeError(clientSocket, HTTP_INTERNAL_ERROR, "Internal server error");
    }
  }

  /**
   * Proxy WebSocket messages between client and upstream.
   *
   * Both clientWs and upstreamWs are proper WebSocket objects, so message
   * framing is handled correctly by the ws library.
   *
   * CRITICAL: Error handlers must be registered immediately after WebSocket
   * creation to avoid race conditions where errors fire before handlers exist.
   */
  private proxyWebSocket(
    sessionId: string,
    clientWs: WebSocket,
    tunnelUrl: string,
    pathSuffix: string,
    req: IncomingMessage,
  ): void {
    // Build upstream WebSocket URL
    const wsUrl = tunnelUrl.replace(/^http/, "ws");
    const targetUrl = new URL(pathSuffix || "/", wsUrl);
    const originalUrl = new URL(req.url || "/", "http://localhost");
    targetUrl.search = originalUrl.search;

    const headers = this.buildWebSocketHeaders(req, tunnelUrl);

    let upstreamConnected = false;
    let upstreamWs: WebSocket | null = null;
    let cleanedUp = false; // Idempotent guard for cleanup

    // Cleanup function to ensure both connections are properly closed
    // Safe to call multiple times (from error, close, or catch handlers)
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;

      if (upstreamWs && upstreamWs.readyState !== WebSocket.CLOSED) {
        upstreamWs.close();
      }
      if (clientWs.readyState !== WebSocket.CLOSED) {
        clientWs.close();
      }
    };

    try {
      this.logger.debug(`[code-proxy] connecting to upstream session=${sessionId} url=${targetUrl.toString()}`);

      upstreamWs = new WebSocket(targetUrl.toString(), {
        headers,
        handshakeTimeout: 10000,
      });

      // CRITICAL: Register error handlers IMMEDIATELY after WebSocket creation
      // to prevent unhandled errors if connection fails before other handlers are set up
      upstreamWs.on("error", (err) => {
        this.logger.debug(`[code-proxy] upstream ws error session=${sessionId}: ${String(err)}`);
        if (!upstreamConnected) {
          // Upstream connection failed before it was established
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, "Upstream connection failed");
          }
        }
        cleanup();
      });

      // Client error handler also registered immediately
      clientWs.on("error", (err) => {
        this.logger.debug(`[code-proxy] client ws error session=${sessionId}: ${String(err)}`);
        cleanup();
      });

      upstreamWs.on("open", () => {
        upstreamConnected = true;
        this.logger.debug(`[code-proxy] ws connected session=${sessionId}`);
      });

      // Bidirectional message forwarding
      clientWs.on("message", (data, isBinary) => {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data, { binary: isBinary });
        }
      });

      upstreamWs.on("message", (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      // Close event handling
      clientWs.on("close", (code, _reason) => {
        this.logger.debug(`[code-proxy] client ws closed session=${sessionId} code=${code}`);
        cleanup();
      });

      upstreamWs.on("close", (code, reason) => {
        this.logger.debug(`[code-proxy] upstream ws closed session=${sessionId} code=${code}`);
        if (clientWs.readyState !== WebSocket.CLOSED) {
          // Use valid fallback code if upstream sends reserved code (e.g., 1006 = abnormal closure)
          // RFC 6455: codes 1005, 1006, 1015 cannot be sent in a close frame
          const safeCode = isValidCloseCode(code) ? code : 1011;
          clientWs.close(safeCode, reason);
        }
      });

      // Ping/Pong forwarding for connection keepalive
      clientWs.on("ping", (data) => {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.ping(data);
        }
      });

      upstreamWs.on("ping", (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.ping(data);
        }
      });

      clientWs.on("pong", (data) => {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.pong(data);
        }
      });

      upstreamWs.on("pong", (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.pong(data);
        }
      });
    } catch (err) {
      // Handle synchronous errors (e.g., URL parsing)
      this.logger.warn(`[code-proxy] ws proxy setup error session=${sessionId}: ${String(err)}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, "Internal error");
      }
      cleanup();
    }
  }

  /**
   * Build headers for upstream HTTP request.
   */
  private buildUpstreamHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const targetHost = new URL(tunnelUrl).host;

    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (SKIP_REQUEST_HEADERS.has(lowerKey)) continue;
      if (lowerKey === "host") {
        headers[key] = targetHost;
      } else {
        const normalized = this.normalizeHeaderValue(value);
        if (normalized !== undefined) {
          headers[key] = normalized;
        }
      }
    }
    // Ensure host is set
    headers["host"] = targetHost;
    return headers;
  }

  /**
   * Build headers for upstream WebSocket connection.
   */
  private buildWebSocketHeaders(req: IncomingMessage, tunnelUrl: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const targetHost = new URL(tunnelUrl).host;

    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      // Skip WebSocket-specific headers that ws will set
      if (SKIP_REQUEST_HEADERS.has(lowerKey)) continue;
      if (lowerKey === "host") continue;

      const normalized = this.normalizeHeaderValue(value);
      if (normalized !== undefined) {
        headers[key] = normalized;
      }
    }
    headers["host"] = targetHost;
    headers["origin"] = tunnelUrl;
    return headers;
  }

  /**
   * Normalize header value to string format.
   * Handles string, string[], or undefined header values.
   */
  private normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    return undefined;
  }

  /**
   * Rewrite Location header for redirects to keep requests going through proxy.
   */
  private rewriteLocationHeader(location: string, tunnelUrl: string, sessionId: string): string {
    try {
      const locUrl = new URL(location, tunnelUrl);
      const tunnelHost = new URL(tunnelUrl).host;
      // If redirect is to the same host, rewrite to proxy
      if (locUrl.host === tunnelHost) {
        return `/api/code-proxy/${sessionId}${locUrl.pathname}${locUrl.search}`;
      }
      return location;
    } catch {
      return location;
    }
  }

  /**
   * Send HTTP error response for failed WebSocket upgrade.
   */
  private sendUpgradeError(socket: Duplex, status: number, message: string): void {
    const response = [
      `HTTP/1.1 ${status} ${message}`,
      "Content-Type: text/plain",
      "Connection: close",
      "",
      message,
    ].join("\r\n");
    socket.write(response);
    socket.destroy();
  }

  /**
   * Send JSON error response.
   */
  private sendError(res: ServerResponse, status: number, message: string): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: message }));
  }
}
