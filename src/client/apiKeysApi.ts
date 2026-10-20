/**
 * Client for the per-user API key endpoints (issue #180):
 * GET/POST /api/api-keys and DELETE /api/api-keys/:id.
 *
 * Keys authenticate EXTERNAL MCP clients to /mcp as the user who minted
 * them. The plaintext secret is returned exactly once, by the mint call;
 * every other response carries metadata only.
 */

import { apiFetch } from "./apiFetch";

export interface ApiKeyInfo {
  id: string;
  label: string;
  /** Non-secret display prefix, e.g. "cfk_Ab3dEf7h". */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchApiKeys(): Promise<ApiKeyInfo[]> {
  const data = await send<{ keys: ApiKeyInfo[] }>("/api/api-keys");
  // Shape guard (issue #71): never hand the renderer a non-array.
  return Array.isArray(data?.keys) ? data.keys : [];
}

export async function mintApiKey(label: string): Promise<{ key: ApiKeyInfo; secret: string }> {
  return send<{ key: ApiKeyInfo; secret: string }>("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await send<{ ok: boolean }>(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** "2026-10-20 · 14:32" style timestamp for the key list; "Never" for unused keys. */
export function fmtApiKeyTime(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
