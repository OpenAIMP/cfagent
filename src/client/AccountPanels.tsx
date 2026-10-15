/**
 * Account panels (issue #67) — surfaces the broker account endpoints that
 * previously had no UI: alerts, transactions, watchlists, and remote
 * (broker-side) orders with cancel. Mounted in the E*TRADE hub's Portfolio
 * view next to the Portfolio Risk panel. Display/input only: order cancels
 * go through the broker endpoint the user explicitly clicks; nothing here
 * places orders.
 */

import { useCallback, useEffect, useState } from "react";
import {
  cancelRemoteOrder,
  createWatchlist,
  deleteAlert,
  deleteWatchlist,
  fetchAlertDetails,
  fetchAlerts,
  fetchRemoteOrders,
  fetchTransactionDetails,
  fetchTransactions,
  fetchWatchlistDetails,
  fetchWatchlists,
  parseSymbolList,
  saveScreenAsWatchlist,
  type ETradeAlert,
  type ETradeAlertDetails,
  type ETradeRemoteOrder,
  type ETradeTransaction,
  type ETradeTransactionDetails,
  type ETradeWatchlist,
} from "./accountApi";
import { fmtUsd } from "./portfolioRiskApi";
import "./accountPanels.css";

const fmtTime = (epochMs: number | undefined) => (epochMs ? new Date(epochMs).toLocaleString() : "—");

export function AccountPanels({ activeEnv }: { activeEnv: string }) {
  // Alerts
  const [alerts, setAlerts] = useState<ETradeAlert[]>([]);
  const [alertDetail, setAlertDetail] = useState<ETradeAlertDetails | null>(null);
  const [alertsError, setAlertsError] = useState("");
  // Transactions
  const [transactions, setTransactions] = useState<ETradeTransaction[]>([]);
  const [txnDetail, setTxnDetail] = useState<ETradeTransactionDetails | null>(null);
  const [txnError, setTxnError] = useState("");
  // Watchlists
  const [watchlists, setWatchlists] = useState<ETradeWatchlist[]>([]);
  const [watchlistDetail, setWatchlistDetail] = useState<ETradeWatchlist | null>(null);
  const [watchError, setWatchError] = useState("");
  const [newListName, setNewListName] = useState("");
  const [newListSymbols, setNewListSymbols] = useState("");
  // Remote orders
  const [orders, setOrders] = useState<ETradeRemoteOrder[]>([]);
  const [ordersError, setOrdersError] = useState("");
  const [ordersMsg, setOrdersMsg] = useState("");

  const loadAlerts = useCallback(async () => {
    try {
      const data = await fetchAlerts(activeEnv);
      setAlerts(data.alerts);
      setAlertsError("");
    } catch (err: any) {
      setAlertsError(err?.message || "Failed to load alerts");
    }
  }, [activeEnv]);

  const loadTransactions = useCallback(async () => {
    try {
      const data = await fetchTransactions(activeEnv);
      setTransactions(data.transactions);
      setTxnError("");
    } catch (err: any) {
      setTxnError(err?.message || "Failed to load transactions");
    }
  }, [activeEnv]);

  const loadWatchlists = useCallback(async () => {
    try {
      const data = await fetchWatchlists(activeEnv);
      setWatchlists(data.watchlists);
      setWatchError("");
    } catch (err: any) {
      setWatchError(err?.message || "Failed to load watchlists");
    }
  }, [activeEnv]);

  const loadOrders = useCallback(async () => {
    try {
      const data = await fetchRemoteOrders(activeEnv);
      setOrders(data.orders);
      setOrdersError("");
    } catch (err: any) {
      setOrdersError(err?.message || "Failed to load broker orders");
    }
  }, [activeEnv]);

  useEffect(() => {
    void loadAlerts();
    void loadTransactions();
    void loadWatchlists();
    void loadOrders();
  }, [loadAlerts, loadTransactions, loadWatchlists, loadOrders]);

  const openOrders = orders.filter((o) => o.status === "OPEN");

  return (
    <>
      {/* Broker alerts */}
      <section className="ap-panel">
        <div className="ap-header"><h3>Broker Alerts</h3><button type="button" onClick={() => void loadAlerts()}>↻</button></div>
        {alertsError && <div className="ap-error">{alertsError}</div>}
        {!alertsError && alerts.length === 0 && <div className="ap-muted">No alerts.</div>}
        {alerts.map((alert) => (
          <div className="ap-row" key={String(alert.id)}>
            <button type="button" className="ap-row-main" onClick={() => void fetchAlertDetails(activeEnv, alert.id).then(setAlertDetail).catch(() => setAlertDetail(null))}>
              <strong className={alert.status === "UNREAD" ? "ap-unread" : undefined}>{alert.subject}</strong>
              <span>{alert.status} · {fmtTime(alert.createTime)}</span>
            </button>
            <button type="button" className="ap-danger" onClick={() => void deleteAlert(activeEnv, alert.id).then(() => { setAlertDetail(null); void loadAlerts(); }).catch(() => undefined)}>Delete</button>
          </div>
        ))}
        {alertDetail && (
          <div className="ap-detail">
            <strong>{alertDetail.subject}</strong>
            {alertDetail.symbol && <span> · {alertDetail.symbol}</span>}
            <p>{alertDetail.msgText}</p>
          </div>
        )}
      </section>

      {/* Account transactions */}
      <section className="ap-panel">
        <div className="ap-header"><h3>Account Transactions</h3><button type="button" onClick={() => void loadTransactions()}>↻</button></div>
        {txnError && <div className="ap-error">{txnError}</div>}
        {!txnError && transactions.length === 0 && <div className="ap-muted">No transactions.</div>}
        {transactions.slice(0, 25).map((txn) => (
          <div className="ap-row" key={txn.transactionId}>
            <button type="button" className="ap-row-main" onClick={() => void fetchTransactionDetails(activeEnv, txn.transactionId).then(setTxnDetail).catch(() => setTxnDetail(null))}>
              <strong>{txn.description}</strong>
              <span>{txn.transactionType} · {fmtTime(txn.transactionDate)} · {fmtUsd(txn.amount, 2)}</span>
            </button>
          </div>
        ))}
        {txnDetail && (
          <div className="ap-detail">
            <strong>{txnDetail.description}</strong>
            <p>
              {fmtUsd(txnDetail.amount, 2)}
              {txnDetail.category ? ` · ${txnDetail.category.parentName ? `${txnDetail.category.parentName} / ` : ""}${txnDetail.category.categoryName}` : ""}
              {txnDetail.brokerage?.product ? ` · ${txnDetail.brokerage.product.symbol} × ${txnDetail.brokerage.quantity ?? "—"} @ ${txnDetail.brokerage.price !== undefined ? fmtUsd(txnDetail.brokerage.price, 2) : "—"}` : ""}
              {txnDetail.brokerage?.fee !== undefined ? ` · fee ${fmtUsd(txnDetail.brokerage.fee, 2)}` : ""}
            </p>
          </div>
        )}
      </section>

      {/* Watchlists */}
      <section className="ap-panel">
        <div className="ap-header"><h3>Watchlists</h3><button type="button" onClick={() => void loadWatchlists()}>↻</button></div>
        {watchError && <div className="ap-error">{watchError}</div>}
        {watchlists.map((list) => (
          <div className="ap-row" key={String(list.watchlistId)}>
            <button type="button" className="ap-row-main" onClick={() => void fetchWatchlistDetails(activeEnv, list.watchlistId).then(setWatchlistDetail).catch(() => setWatchlistDetail(null))}>
              <strong>{list.name}</strong>
              <span>{list.symbols.length} symbols{list.source ? ` · ${list.source === "etrade_api" ? "E*TRADE" : "local"}` : ""}</span>
            </button>
            <button type="button" className="ap-danger" onClick={() => void deleteWatchlist(activeEnv, list.watchlistId).then(() => { setWatchlistDetail(null); void loadWatchlists(); }).catch(() => undefined)}>Delete</button>
          </div>
        ))}
        {watchlistDetail && (
          <div className="ap-detail">
            <strong>{watchlistDetail.name}</strong>
            <p>{(watchlistDetail.items?.map((i) => i.symbol) ?? watchlistDetail.symbols).join(", ") || "No symbols."}</p>
          </div>
        )}
        <div className="ap-form">
          <input value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="New watchlist name" />
          <input value={newListSymbols} onChange={(e) => setNewListSymbols(e.target.value)} placeholder="Symbols (AAPL, MSFT …)" />
          <button type="button" disabled={!newListName.trim()} onClick={() => void createWatchlist(activeEnv, newListName.trim(), parseSymbolList(newListSymbols)).then(() => { setNewListName(""); setNewListSymbols(""); void loadWatchlists(); }).catch((err: any) => setWatchError(err?.message || "Create failed"))}>Create</button>
          <button type="button" disabled={!newListName.trim()} onClick={() => void saveScreenAsWatchlist(activeEnv, newListName.trim(), parseSymbolList(newListSymbols)).then(() => { setNewListName(""); setNewListSymbols(""); void loadWatchlists(); }).catch((err: any) => setWatchError(err?.message || "Save-screen failed"))}>Save as screen</button>
        </div>
      </section>

      {/* Broker (remote) orders */}
      <section className="ap-panel">
        <div className="ap-header"><h3>Broker Orders</h3><button type="button" onClick={() => void loadOrders()}>↻</button></div>
        {ordersError && <div className="ap-error">{ordersError}</div>}
        {ordersMsg && <div className="ap-note">{ordersMsg}</div>}
        {!ordersError && orders.length === 0 && <div className="ap-muted">No broker orders.</div>}
        {orders.slice(0, 25).map((order) => (
          <div className="ap-row" key={String(order.orderId)}>
            <div className="ap-row-main static">
              <strong>{order.symbol ?? "—"} {order.orderAction ?? ""} {order.quantity ?? ""}</strong>
              <span>{order.status} · {order.orderType}{order.limitPrice !== undefined ? ` @ ${fmtUsd(order.limitPrice, 2)}` : ""} · {fmtTime(order.placedTime)} · #{String(order.orderId)}</span>
            </div>
            {order.status === "OPEN" && (
              <button type="button" className="ap-danger" onClick={() => void cancelRemoteOrder(activeEnv, order.orderId).then((res) => { setOrdersMsg(res.message); void loadOrders(); }).catch((err: any) => setOrdersError(err?.message || "Cancel failed"))}>Cancel</button>
            )}
          </div>
        ))}
        {openOrders.length > 0 && <div className="ap-note">{openOrders.length} open order(s) at the broker.</div>}
      </section>
    </>
  );
}
