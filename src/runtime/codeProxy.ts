/**
 * CodeProxyHandler - Proxies requests to code-server with X-Frame-Options stripping.
 *
 * This module enables embedding code-server (Web VS Code) in an iframe by:
 * 1. Proxying HTTP requests to the Modal tunnel URL
 * 2. Stripping X-Frame-Options and CSP headers from responses
 * 3. Handling WebSocket upgrade for code-server's real-time features
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import type { Logger } from './log.js';
import type { CloudManager } from './cloud/manager.js';

/** Headers to strip from proxied responses to allow iframe embedding */
const STRIP_RESPONSE_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'x-content-type-options',
  'content-encoding',    // fetch() auto-decompresses, so body is already uncompressed
  'content-length',      // Length changes after decompression, let Node.js handle it
  'transfer-encoding',   // Avoid chunked encoding conflicts with our streaming
];

/** Headers to not forward from client to upstream */
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

/** HTTP status codes */
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_GATEWAY = 502;

/**
 * CodeProxyHandler handles HTTP and WebSocket proxying to code-server.
 *
 * Follows SRP: Only responsible for proxying requests to code-server.
 * Follows DIP: Dependencies (CloudManager, Logger) injected via constructor.
 */
export class CodeProxyHandler {
  constructor(
    private readonly cloudManager: CloudManager,
    private readonly logger: Logger,
  ) {}

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
        this.sendError(res, HTTP_SERVICE_UNAVAILABLE, 'Code server not available');
        return;
      }

      // Build target URL
      const targetUrl = new URL(pathSuffix || '/', tunnelUrl);

      // Copy query params from original request
      const originalUrl = new URL(req.url || '/', `http://localhost`);
      targetUrl.search = originalUrl.search;

      // Build headers for upstream request
      const headers = this.buildUpstreamHeaders(req, tunnelUrl);

      // Prepare fetch options
      const fetchOptions: RequestInit & { duplex?: string } = {
        method: req.method,
        headers,
        redirect: 'manual', // Handle redirects manually to rewrite Location headers
      };

      // Forward request body for non-GET/HEAD methods
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOptions.body = req as unknown as ReadableStream;
        fetchOptions.duplex = 'half';
      }

      const proxyRes = await fetch(targetUrl.toString(), fetchOptions);

      // Handle redirects - rewrite Location header to proxy URL
      if (proxyRes.status >= 300 && proxyRes.status < 400) {
        const location = proxyRes.headers.get('location');
        if (location) {
          const rewrittenLocation = this.rewriteLocationHeader(location, tunnelUrl, sessionId);
          res.setHeader('location', rewrittenLocation);
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
        this.sendError(res, HTTP_BAD_GATEWAY, 'Proxy request failed');
      }
    }
  }

  /**
   * Handle WebSocket upgrade for code-server.
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
        clientSocket.destroy();
        return;
      }

      // Convert HTTP URL to WebSocket URL
      const wsUrl = tunnelUrl.replace(/^http/, 'ws');
      const targetUrl = new URL(pathSuffix || '/', wsUrl);

      // Copy query params
      const originalUrl = new URL(req.url || '/', `http://localhost`);
      targetUrl.search = originalUrl.search;

      // Build headers for upstream
      const headers = this.buildWebSocketHeaders(req, tunnelUrl);

      // Connect to upstream WebSocket
      const upstreamWs = new WebSocket(targetUrl.toString(), {
        headers,
        handshakeTimeout: 10000,
      });

      // Track if connection is established
      let connected = false;

      upstreamWs.on('open', () => {
        connected = true;
        this.logger.debug(`[code-proxy] ws connected session=${sessionId}`);

        // Send upgrade response to client
        const upgradeResponse = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${this.computeAcceptKey(req.headers['sec-websocket-key'] as string)}`,
        ];

        // Add subprotocol if present
        const protocol = req.headers['sec-websocket-protocol'];
        if (protocol) {
          upgradeResponse.push(`Sec-WebSocket-Protocol: ${Array.isArray(protocol) ? protocol[0] : protocol}`);
        }

        upgradeResponse.push('', '');
        clientSocket.write(upgradeResponse.join('\r\n'));

        // If there's buffered data, send it
        if (head.length > 0) {
          upstreamWs.send(head);
        }
      });

      // Forward data from client to upstream
      clientSocket.on('data', (data: Buffer) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data);
        }
      });

      // Forward data from upstream to client
      upstreamWs.on('message', (data: Buffer) => {
        if (!clientSocket.destroyed) {
          clientSocket.write(data);
        }
      });

      // Handle close events
      clientSocket.on('close', () => {
        if (upstreamWs.readyState !== WebSocket.CLOSED) {
          upstreamWs.close();
        }
      });

      clientSocket.on('error', (err) => {
        this.logger.debug(`[code-proxy] client socket error session=${sessionId}: ${String(err)}`);
        if (upstreamWs.readyState !== WebSocket.CLOSED) {
          upstreamWs.close();
        }
      });

      upstreamWs.on('close', () => {
        if (!clientSocket.destroyed) {
          clientSocket.destroy();
        }
      });

      upstreamWs.on('error', (err) => {
        this.logger.debug(`[code-proxy] upstream ws error session=${sessionId}: ${String(err)}`);
        if (!connected) {
          clientSocket.destroy();
        }
      });
    } catch (err) {
      this.logger.warn(`[code-proxy] ws upgrade error session=${sessionId}: ${String(err)}`);
      clientSocket.destroy();
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

      if (lowerKey === 'host') {
        headers[key] = targetHost;
      } else if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    // Ensure host is set
    headers['host'] = targetHost;

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
      if (lowerKey === 'host') continue;

      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    headers['host'] = targetHost;
    headers['origin'] = tunnelUrl;

    return headers;
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
   * Compute Sec-WebSocket-Accept key per RFC 6455.
   */
  private computeAcceptKey(clientKey: string): string {
    const crypto = require('node:crypto');
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    return crypto
      .createHash('sha1')
      .update(clientKey + GUID)
      .digest('base64');
  }

  /**
   * Send JSON error response.
   */
  private sendError(res: ServerResponse, status: number, message: string): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: message }));
  }
}
