/**
 * Shared tab contract for the Search hub (#2120 slice 1). Tabs own their
 * query box and backend call; the hub only drives them via pendingQuery
 * (shared-query / recent-search runs) and collects health + recent
 * searches via the callbacks. No tab fetches on mount — only on submit
 * or on a pendingQuery run.
 */
export interface PendingQuery {
  query: string;
  nonce: number;
}

export interface TabHealth {
  status: "ok" | "empty" | "error";
  hits: number;
  latencyMs: number;
  message?: string;
}

export interface SearchTabProps {
  pendingQuery?: PendingQuery | null;
  onHealth?: (health: TabHealth) => void;
  onSearch?: (query: string) => void;
}
