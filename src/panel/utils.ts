// ── Fetch bridge ──────────────────────────────────────────────

/**
 * Fetch through the dashboard's postMessage bridge. Relative paths (no leading '/')
 * resolve against the cartridge proxy (→ /state/...); absolute parent-origin URLs
 * (`${__PARENT_ORIGIN__}/api/...`) hit the supervisor. Falls back to plain fetch in
 * standalone dev (where __panelFetch__ is absent).
 */
export async function panelFetch(path: string, init?: RequestInit): Promise<Response> {
  const fetcher = (globalThis as any).__panelFetch__ || fetch;
  return fetcher(path, init);
}
