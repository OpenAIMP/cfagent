/**
 * Issue #1327: the approvals queue for TradingAgent order proposals.
 * Order placement is approval-gated by design (preview -> proposal ->
 * wait -> executeApprovedOrder) but the door had no UI, so the trading
 * capability was API-only. This queue lists proposed orders with
 * proposer, expiry, and approve/reject actions wired to the EXISTING
 * approval path — POST /etrade/order/execute — with no new backend
 * route.
 *
 * Data source: GET /etrade/orders (existing, last 50 trades), filtered
 * client-side to status 'previewed'. Expiry is the preview flow's own
 * 15-minute HITL timer: the draft row is created at preview time and
 * the schedule fires 900s later (expireStaleOrderDraft marks it
 * 'expired'), so expiresAt = createdAt + 900s. That countdown is a
 * display derived from the preview flow's documented timer; the server
 * stays authoritative — executing a non-previewed draft 400s, and the
 * list refresh drops decided/expired rows. The 24h durable-workflow
 * wait (startTradeApproval/decideTradeApproval) has no listable store
 * (workflow instances are not enumerable through the app API), so the
 * queue covers the draft-backed proposals, which are the ones the
 * execute door acts on.
 *
 * Compliance (docs/agents/ux-architecture.md): built only from
 * src/client/components/ui/ primitives; approval dialogs show the exact
 * action/target/content/cost before anything moves; server state is
 * authoritative (every decision refreshes the list); failures render a
 * business error notice, never a technical message.
 */

import { useCallback, useEffect, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Badge, Button, Card, EmptyState, Modal, Notice, Spinner } from "./components/ui";
import { formatCountdown } from "./PendingReviewQueue";

/** The preview flow's HITL window: draft created at preview, schedule fires 900s later. */
export const PREVIEW_WINDOW_MS = 900 * 1000;

export interface TradeProposal {
  id: string;
  symbol: string;
  action: string;
  orderType: string;
  quantity: number;
  price: number;
  totalValue: number;
  status: string;
  proposerDid: string | null;
  authorizerDid: string | null;
  previewNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Expiry of a previewed draft, from the preview flow's own 900s timer. */
export function proposalExpiresAt(trade: Pick<TradeProposal, "createdAt">): string | null {
  const created = new Date(trade.createdAt).getTime();
  if (!Number.isFinite(created)) return null;
  return new Date(created + PREVIEW_WINDOW_MS).toISOString();
}

type Decision = "approved" | "rejected";

export function TradingApprovalsQueue() {
  const [trades, setTrades] = useState<TradeProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirm, setConfirm] = useState<{ trade: TradeProposal; decision: Decision } | null>(null);
  const [acting, setActing] = useState(false);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/etrade/orders");
      const data = (await res.json().catch(() => null)) as { trades?: unknown } | null;
      if (!res.ok) {
        setError("Failed to load pending approvals.");
        return;
      }
      setTrades(Array.isArray(data?.trades) ? (data.trades as TradeProposal[]) : []);
    } catch {
      setError("Failed to load pending approvals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const pending = trades.filter((t) => t.status === "previewed");

  const decide = async () => {
    if (!confirm) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/etrade/order/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ orderId: confirm.trade.id, decision: confirm.decision }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        // Refresh first: fetchOrders clears the error slot, so the
        // refusal message must be set after the refresh lands.
        const message =
          typeof data?.error === "string" && data.error
            ? data.error
            : "The decision could not be recorded.";
        setConfirm(null);
        await fetchOrders();
        setError(message);
        return;
      }
      setNotice(
        confirm.decision === "approved"
          ? `Order ${confirm.trade.id} approved.`
          : `Proposal ${confirm.trade.id} rejected.`
      );
      setConfirm(null);
      await fetchOrders();
    } catch {
      setError("The decision could not be recorded.");
      setConfirm(null);
    } finally {
      setActing(false);
    }
  };

  return (
    <Card padding="md">
      <h3 style={{ margin: "0 0 0.75rem" }}>Pending approvals</h3>
      <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", margin: "0 0 1rem" }}>
        Proposed orders awaiting human authorization. Approving places the order through the existing
        approval door; rejecting closes the proposal without placing it. Proposals expire 15 minutes
        after preview — expired proposals cannot execute.
      </p>
      {error && (
        <Notice tone="danger" density="compact" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" density="compact" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      {loading ? (
        <Spinner label="Loading pending approvals…" />
      ) : pending.length === 0 ? (
        <EmptyState
          title="No pending approvals"
          description="No proposed orders are awaiting authorization right now."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {pending.map((trade) => {
            const expiresAt = proposalExpiresAt(trade);
            const countdown = formatCountdown(expiresAt, nowMs);
            const expired = countdown === "Expired";
            return (
              <div
                key={trade.id}
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "8px",
                  padding: "0.75rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <Badge tone={expired ? "danger" : "warning"}>
                    {expired ? "Expired" : "Awaiting approval"}
                  </Badge>
                  <span style={{ fontWeight: 700 }}>
                    {trade.action} {trade.quantity} × {trade.symbol}
                  </span>
                  <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
                    {trade.orderType} · ${trade.price} · total ${trade.totalValue}
                  </span>
                </div>
                <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
                  Proposed by {trade.proposerDid || "unknown"} ·{" "}
                  {new Date(trade.createdAt).toLocaleString()} · {countdown}
                </div>
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={expired || acting}
                    onClick={() => setConfirm({ trade, decision: "approved" })}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={acting}
                    onClick={() => setConfirm({ trade, decision: "rejected" })}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.decision === "approved" ? "Approve order" : "Reject proposal"}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirm(null)} disabled={acting}>
              Cancel
            </Button>
            <Button size="sm" loading={acting} onClick={() => void decide()}>
              {confirm?.decision === "approved" ? "Approve and place order" : "Reject proposal"}
            </Button>
          </>
        }
      >
        {confirm && (
          <div>
            {confirm.decision === "approved" ? (
              <p>
                Approve and place this order? {confirm.trade.action} {confirm.trade.quantity} ×{" "}
                {confirm.trade.symbol} ({confirm.trade.orderType}) at ${confirm.trade.price}, total $
                {confirm.trade.totalValue}. This places a real order through the approval door.
              </p>
            ) : (
              <p>
                Reject this proposal? {confirm.trade.action} {confirm.trade.quantity} ×{" "}
                {confirm.trade.symbol} will not be placed, and the proposal closes.
              </p>
            )}
            <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
              Proposed by {confirm.trade.proposerDid || "unknown"} · expires{" "}
              {formatCountdown(proposalExpiresAt(confirm.trade), nowMs)}
            </p>
          </div>
        )}
      </Modal>
    </Card>
  );
}
