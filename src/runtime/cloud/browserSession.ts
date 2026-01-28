/**
 * Unified browser session abstraction.
 * Provides consistent interface for Browserbase and Hyperbrowser providers.
 */

import type { BrowserProvider } from "./types.js";

/**
 * Base browser session interface.
 * Common fields across all browser providers.
 */
export interface BrowserSession {
  readonly id: string;
  readonly provider: BrowserProvider;
  readonly cdpEndpoint: string;
}

/**
 * Hyperbrowser-specific session state.
 */
export interface HyperbrowserSession extends BrowserSession {
  readonly provider: "hyperbrowser";
}

/**
 * Browserbase-specific session state.
 */
export interface BrowserbaseSession extends BrowserSession {
  readonly provider: "browserbase";
  readonly projectId?: string;
}

/**
 * Extracts CDP WebSocket URL from a browser session.
 * Returns null if session is undefined.
 */
export function getCdpUrl(session: BrowserSession | undefined): string | null {
  return session?.cdpEndpoint ?? null;
}

/**
 * Creates a unified BrowserSession from a Hyperbrowser response.
 */
export function createHyperbrowserSession(id: string, wsEndpoint: string): HyperbrowserSession {
  return {
    id,
    provider: "hyperbrowser",
    cdpEndpoint: wsEndpoint,
  };
}

/**
 * Creates a unified BrowserSession from a Browserbase response.
 */
export function createBrowserbaseSession(id: string, connectUrl: string, projectId?: string): BrowserbaseSession {
  return {
    id,
    provider: "browserbase",
    cdpEndpoint: connectUrl,
    projectId,
  };
}
