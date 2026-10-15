/**
 * Client for the broker account endpoints surfaced by issue #67:
 * alerts, transactions, watchlists, and remote (broker-side) orders.
 * Response types are type-only imports from src/types — single-sourced.
 */

import type {
  ETradeAlert,
  ETradeAlertDetails,
  ETradeCancelOrderResult,
  ETradeRemoteOrder,
  ETradeTransaction,
  ETradeTransactionDetails,
  ETradeWatchlist,
} from "../types";

export type { ETradeAlert, ETradeAlertDetails, ETradeCancelOrderResult, ETradeRemoteOrder, ETradeTransaction, ETradeTransactionDetails, ETradeWatchlist };

async function getJson<T>(path: string, env: string): Promise<T> {
  const resp = await fetch(path, { headers: { "x-environment": env } });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

async function sendJson<T>(path: string, env: string, method: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "x-environment": env },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

// Alerts ----------------------------------------------------------------------

export function fetchAlerts(env: string): Promise<{ count: number; alerts: ETradeAlert[] }> {
  return getJson("/api/etrade/alerts?count=50", env);
}

export function fetchAlertDetails(env: string, id: string | number): Promise<ETradeAlertDetails> {
  return getJson(`/api/etrade/alerts/${encodeURIComponent(String(id))}`, env);
}

export function deleteAlert(env: string, id: string | number): Promise<{ success: boolean }> {
  return sendJson(`/api/etrade/alerts/${encodeURIComponent(String(id))}`, env, "DELETE");
}

// Transactions ----------------------------------------------------------------

export function fetchTransactions(env: string): Promise<{ count: number; transactions: ETradeTransaction[] }> {
  return getJson("/api/etrade/transactions?count=50&sortOrder=DESC", env);
}

export function fetchTransactionDetails(env: string, id: string): Promise<ETradeTransactionDetails> {
  return getJson(`/api/etrade/transactions/${encodeURIComponent(id)}`, env);
}

// Watchlists ------------------------------------------------------------------

export function fetchWatchlists(env: string): Promise<{ count: number; watchlists: ETradeWatchlist[] }> {
  return getJson("/api/etrade/watchlists", env);
}

export function fetchWatchlistDetails(env: string, id: string | number): Promise<ETradeWatchlist> {
  return getJson(`/api/etrade/watchlist/details?id=${encodeURIComponent(String(id))}`, env);
}

export function createWatchlist(env: string, name: string, symbols: string[]): Promise<unknown> {
  return sendJson("/api/etrade/watchlist/create", env, "POST", { name, symbols });
}

export function saveScreenAsWatchlist(env: string, name: string, symbols: string[]): Promise<unknown> {
  return sendJson("/api/etrade/watchlist/save-screen", env, "POST", { name, symbols });
}

export function deleteWatchlist(env: string, id: string | number): Promise<{ success: boolean }> {
  return sendJson(`/api/etrade/watchlist/delete?id=${encodeURIComponent(String(id))}`, env, "DELETE");
}

// Remote (broker-side) orders ---------------------------------------------------

export function fetchRemoteOrders(env: string): Promise<{ count: number; orders: ETradeRemoteOrder[] }> {
  return getJson("/api/etrade/orders/remote?count=50", env);
}

export function cancelRemoteOrder(env: string, orderId: string | number): Promise<ETradeCancelOrderResult> {
  return sendJson("/api/etrade/orders/cancel", env, "POST", { orderId });
}

// Helpers (unit-tested) ---------------------------------------------------------

/** Parses a free-form symbol list ("aapl, msft  SPY") into unique uppercase symbols. */
export function parseSymbolList(text: string): string[] {
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/)) {
    const symbol = token.trim().toUpperCase();
    if (symbol) seen.add(symbol);
  }
  return [...seen];
}
