/**
 * Issue #2230 — market quotes ticker as a PortThink agent.
 *
 * The ticker WebSocket (`/api/market/quotes/ws`, plus the
 * `/api/market-data/` and `/api/foss/` aliases) was a hand-rolled raw
 * WebSocket in the Worker: `server.ts` created a `WebSocketPair` and
 * handed the server side to `handleMarketQuotesWebSocket`. That handler
 * is retained (its pin tests in `market_stream.test.ts`,
 * `marketstream_baseline_929.test.ts`, and `quote_modes_1725.test.ts`
 * pin the wire protocol), but production traffic now goes through
 * this agent instead.
 *
 * Architecture (no deviation from the ports/adapter architecture):
 * `TickerAgent extends PortThink`, the same base as
 * `OrchestratorAgent` (`PortThink extends Think extends Agent`).
 * PortThink's turn facet is inert here — `portHooks` is never set and
 * no turn ever runs — so the agent uses only the Agent WebSocket
 * surface: `onConnect` / `onMessage` / `onClose` (inherited),
 * `getConnections`, and the SDK scheduler. Think's `onStart` (chat
 * session bootstrap) is deliberately NOT invoked: the ticker runs no
 * turns, and `onStart` here only installs the tick schedule.
 *
 * Protocol parity with the old handler (both clients — app
 * `quotesService.ts` and landing `landing.ts` — are unchanged):
 * - `subscribe` → `snapshot` frame (`quotes` + `unavailable`).
 * - `unsubscribe` → symbols dropped from that connection's set.
 * - `ping` → `pong` frame. Malformed frames → `error` frame.
 * - `ticks` frames every 5s per connection, filtered to that
 *   connection's symbols, cached-first then refreshed — the same
 *   send-cached / refresh / send-again shape as the old handler.
 * - Header carriers: `x-quote-expiry-mode` /
 *   `x-quote-stream-provenance` are read from the upgrade request in
 *   `onConnect` and stored per connection, exactly as the old Worker
 *   branch passed them as options.
 *
 * Auth surface preserved: the ticker endpoint has no auth and no
 * audit (M10). It is therefore NOT routed through `routeAgentRequest`
 * `onBeforeConnect` (which 401s unauthenticated callers — that would
 * break the public landing page tape). `server.ts` addresses the
 * single shared instance directly (`idFromName("ticker")`) and
 * forwards the upgrade request to the stub; the SDK's stub fetch
 * performs the upgrade and drives `onConnect`.
 *
 * Single shared instance: the current surface is global, so
 * per-user instances would fragment the quote-cache refresh for no
 * benefit. Subscriptions live in per-connection state, which the SDK
 * re-establishes across hibernation; the tick schedule is durable
 * (`scheduleEvery` is idempotent, so `onStart` re-installing it on
 * every wake creates no duplicates).
 *
 * Protocol messages are disabled (`shouldSendProtocolMessages` →
 * false): ticker clients are plain WebSockets, not `useAgent`
 * clients, and must see only snapshot/ticks/pong/error frames.
 */
import type { Connection, ConnectionContext, WSMessage } from "agents";
import {
  levelsForQuoteSwitch,
  resolveQuoteExpiryMode,
  resolveQuoteStreamProvenance,
  type QuoteExpiryMode,
  type QuoteStreamProvenance,
} from "../config/quoteModes";
import {
  annotateStreamTicks,
  getBatchMarketQuotes,
  refreshQuotesInBackground,
  type MarketStreamClientMessage,
} from "../services/marketStream";
import type { Env } from "../types";
import { PortThink } from "../actors/thinkAdapter";

/** Per-connection ticker state, restored by the SDK across hibernation. */
export interface TickerConnectionState {
  symbols: string[];
  expiryMode: QuoteExpiryMode;
  streamProvenance: QuoteStreamProvenance;
}

/** Tick push cadence, matching the old handler's 5s interval. */
export const TICKER_PUSH_INTERVAL_SECONDS = 5;

/** Name of the single shared ticker instance. */
export const TICKER_INSTANCE_NAME = "ticker";

export class TickerAgent extends PortThink {
  override async onStart(): Promise<void> {
    // Idempotent per the SDK: re-installing on every wake returns the
    // existing schedule instead of creating a duplicate.
    await this.scheduleEvery(TICKER_PUSH_INTERVAL_SECONDS, "pushTicks");
  }

  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  override async onConnect(
    connection: Connection<TickerConnectionState>,
    ctx: ConnectionContext,
  ): Promise<void> {
    const env = this.env as Env | undefined;
    connection.setState({
      symbols: [],
      expiryMode: resolveQuoteExpiryMode(
        levelsForQuoteSwitch(
          undefined,
          ctx.request.headers.get("x-quote-expiry-mode") ?? undefined,
          env?.QUOTE_EXPIRY_MODE,
        ),
        "continuity",
      ).mode,
      streamProvenance: resolveQuoteStreamProvenance(
        levelsForQuoteSwitch(
          undefined,
          ctx.request.headers.get("x-quote-stream-provenance") ?? undefined,
          env?.QUOTE_STREAM_PROVENANCE,
        ),
        "bare",
      ).mode,
    });
  }

  override async onMessage(
    connection: Connection<TickerConnectionState>,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const msg = JSON.parse(message) as MarketStreamClientMessage;
      const state = connection.state;
      if (!state) return;
      if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
        const quotes: ReturnType<typeof getBatchMarketQuotes> = [];
        const unavailable: string[] = [];
        const symbols = [...state.symbols];
        for (const sym of msg.symbols) {
          const upper = sym.toUpperCase().trim();
          if (!upper) continue;
          if (!symbols.includes(upper)) symbols.push(upper);
          const found = getBatchMarketQuotes([upper], state.expiryMode)[0];
          if (found) quotes.push(found);
          else unavailable.push(upper);
        }
        // Connection state is immutable: replace, never mutate.
        connection.setState({ ...state, symbols });
        connection.send(
          JSON.stringify({
            type: "snapshot",
            quotes: annotateStreamTicks(quotes, state.streamProvenance),
            unavailable,
          }),
        );
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.symbols)) {
        const dropped = new Set(msg.symbols.map((s) => s.toUpperCase().trim()));
        // Connection state is immutable: replace, never mutate.
        connection.setState({
          ...state,
          symbols: state.symbols.filter((s) => !dropped.has(s)),
        });
      } else if (msg.type === "ping") {
        connection.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch (err: unknown) {
      connection.send(
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : "Invalid market stream message",
        }),
      );
    }
  }

  /** Scheduled tick push: one filtered frame per subscribed connection. */
  async pushTicks(): Promise<void> {
    const env = this.env as Env | undefined;
    for (const connection of this.getConnections<TickerConnectionState>()) {
      const state = connection.state;
      if (!state || state.symbols.length === 0) continue;
      // Copy out of the immutable connection state before passing on.
      const symbols = [...state.symbols];
      try {
        // Keep the stream responsive even when an upstream quote
        // provider is slow or unavailable: publish the latest cached
        // quote before waiting on I/O.
        connection.send(
          JSON.stringify({
            type: "ticks",
            ticks: annotateStreamTicks(
              getBatchMarketQuotes(symbols, state.expiryMode),
              state.streamProvenance,
            ),
          }),
        );
        await refreshQuotesInBackground(symbols, env);
        connection.send(
          JSON.stringify({
            type: "ticks",
            ticks: annotateStreamTicks(
              getBatchMarketQuotes(symbols, state.expiryMode),
              state.streamProvenance,
            ),
          }),
        );
      } catch {
        // A failed provider refresh leaves the last known quote visible.
      }
    }
  }
}
