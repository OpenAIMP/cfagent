/**
 * #1727 (parent #1717, slice (g)): SEVEN runtime config switches for
 * the FOSS MCP-vs-REST pairs (scan appendix (g) findings F01–F05) —
 * the PAYMENTS_FLOW_MODE (#1711) / QUOTE_* (#1725) / ETRADE_* (#1726)
 * pattern applied to this domain. Pure module: no Cloudflare
 * imports, no I/O, no network — the port is the resolver, and both
 * surfaces consume it (port-first, cfagent blueprint #1795/#1798
 * restated wording: cloud-native but cloud-agnostic).
 *
 * Switches (Worker env vars, non-secret, owner-set; this slice sets
 * NO production value — production values are an owner action):
 *   FOSS_QUOTE_MODE         "mcp" | "rest"            (F01 quote)
 *   FOSS_FUNDAMENTALS_MODE  "mcp" | "rest"            (F01 fundamentals)
 *   FOSS_RESEARCH_MODE      "mcp" | "rest"            (F01 research)
 *   FOSS_BARS_MODE          "mcp" | "rest"            (F02 bars)
 *   FOSS_SNAPSHOT_MODE      "mcp" | "rest"            (F03 snapshot)
 *   FOSS_ALPACA_READS_MODE  "mcp" | "rest" | "none"    (F04 reads)
 *   FOSS_ALPACA_ORDER_MODE  "mcp" | "foss" | "trading" (F05 place order)
 * Values are case-insensitive, surrounding whitespace ignored.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (per-surface
 *   legacy — the #1726 accepted interpretation of the identical
 *   standing-rule text "built-in default (current PUBLIC ROUTE
 *   behavior)": each surface keeps its own current contract when
 *   nothing is configured, so this slice changes NO unattended
 *   behavior; the owner can overturn any default with one env var).
 * Carriers: run = the per-request / per-call `mode` field (MCP
 * input `mode`, REST query `?mode=` or POST body `mode`); session
 * / user = the optional `scopedFossModes` carrier on the execution
 * context (McpToolContext.scopedFossModes / route ctx
 * scopedFossModes, populated by the execution-context owner);
 * global env = the Worker env var. A blank/unset level falls
 * through to the next level. The FIRST non-blank level wins; if
 * that value is unrecognized, the resolution FAILS CLOSED to the
 * surface legacy (invalid=true, level = the winning level) and
 * does NOT fall through to a lower level. Callers must log +
 * audit `foss.config_error` on invalid.
 *
 * Built-in defaults per surface = that surface's CURRENT behavior
 * (recorded explicitly so the owner can overturn it later):
 *   MCP surface: quote=mcp, fundamentals=mcp, research=mcp,
 *     bars=mcp, snapshot=mcp, reads=mcp, order=mcp.
 *   /foss REST surface: quote=rest, fundamentals=rest,
 *     research=rest, bars=rest, snapshot=rest, reads=rest,
 *     order=foss.
 *   /trading REST surface: reads=none (its current silence),
 *     order=trading (its current normalization + minimal audit).
 *   (/trading has no quote/fundamentals/research/bars/snapshot
 *   routes, so those switches do not apply there.)
 *
 * Per-mode behavior matrix (both/all paths preserved as branches,
 * never deleted; no endpoint removed):
 * | pair            | mcp branch                            | rest/foss/trading branch              |
 * | quote           | symbol required (throw / 400), audit   | symbol defaults NVDA, no quote audit    |
 * |                 | foss.quote.fetched                    |                                         |
 * | fundamentals    | symbol required, audit                | symbol defaults NVDA, no audit          |
 * |                 | foss.fundamentals.fetched             |                                         |
 * | research        | symbol required, audit                | symbol defaults NVDA, audit             |
 * |                 | foss.research.generated               | foss.research_generated                 |
 * | bars            | no provider input (service default),  | provider input (default yfinance)       |
 * |                 | {symbol,count,provenance,bars}, audit  | passed explicitly; fuller envelope      |
 * |                 | foss.bars.fetched                     | {symbol,provider,timeframe,count,     |
 * |                 |                                       | bars,provenance,source,timestamp};     |
 * |                 |                                       | no bars audit                           |
 * | snapshot        | symbol required, audit                | symbol defaults NVDA, audit             |
 * |                 | foss.alpaca.snapshot {symbol,         | alpaca.snapshot_queried {symbol,price,  |
 * |                 | assetClass,tradePrice,provenance}     | bid,ask,assetClass}                     |
 * | alpaca reads    | audits alpaca.account.query /         | rest: audits alpaca.account_queried /   |
 * | (account /      | positions.query / orders.query with   | positions_queried / orders_queried      |
 * | positions /     | the /foss-identical payloads;         | with the same payloads; none: no read   |
 * | orders)         | orders status default open            | audit; orders status default open in    |
 * |                 |                                       | every mode                              |
 * | alpaca place    | verbatim input (no qty default, no     | foss: /foss normalization (uppercase   |
 * | order           | uppercasing, no aliases, limit_price  | + trim, qty = qty\|\|quantity\|\|1, side  |
 * |                 | only), audit alpaca.order.place       | = side\|\|orderAction\|\|buy lowercased,  |
 * |                 | with the full field set               | type = type\|\|orderType\|\|market        |
 * |                 |                                       | lowercased, limit_price\|\|limitPrice,   |
 * |                 |                                       | tif day) + alpaca.order_placed full     |
 * |                 |                                       | set; trading: /trading normalization    |
 * |                 |                                       | (trim, no uppercase, qty\|\|1, side      |
 * |                 |                                       | lower default buy, type raw, tif day)   |
 * |                 |                                       | + alpaca.order_placed minimal           |
 * |                 |                                       | {symbol,qty,side,status}                |
 *
 * AUDIT-NAME DECISION (F01, recorded explicitly per the issue):
 * the REST spelling `foss.research_generated` is the canonical
 * spelling for NEW consumers — it matches the past-tense
 * underscore convention of the whole /foss *_queried family
 * (account_queried, positions_queried, orders_queried,
 * snapshot_queried). The MCP spelling `foss.research.generated`
 * is NOT deleted: it stays available under mode=mcp on both
 * surfaces. The unification is that the name is now governed by
 * one configured mode instead of by which surface answered —
 * the split is explicit configuration, not an accident. The
 * owner can make the MCP spelling the global default with one
 * env var (FOSS_RESEARCH_MODE=mcp).
 *
 * THREE-WAY NOTE (F04/F05, domain (m) #1733 R01 interaction):
 * the reads and order switches are three-valued because the
 * divergence is three-way (MCP vs /foss vs /trading), not two-
 * way. This slice WIRES all three surfaces through the switch
 * but does NOT pre-decide the /trading↔/foss twin question:
 * /trading keeps its own legacy as its built-in default
 * (reads=none, order=trading), and #1733 retains full freedom
 * to change the /trading default or the twin semantics later —
 * that is a one-line default change once the switch exists.
 * No route is moved, merged, or renamed here.
 *
 * Scan-vs-code corrections (appendix (g) was written against an
 * older tree; current main governs, and the pins in
 * tests/foss_modes_1727.test.ts lock the true behavior):
 * - MCP quote/fundamentals DO audit today (foss.quote.fetched /
 *   foss.fundamentals.fetched); the appendix claim that MCP
 *   audits "snapshot/bars/research but not quote/fundamentals"
 *   is stale — the divergence is REST-silence vs MCP-audit.
 * - MCP orders status DOES default to open today (zod default +
 *   execute `|| "open"` + service default); the scan's "no
 *   default" claim is stale — status default is pinned, not
 *   switched, open in every mode on every surface.
 * - MCP account/positions/orders audit payloads are IDENTICAL to
 *   the /foss *_queried payloads; F04's divergence is the event
 *   NAME (+ /trading silence), not the payload.
 * - FossResearchService.getHistoricalBars defaults provider to
 *   yfinance; MCP's 3-arg call and REST's explicit default agree
 *   on the VALUE — F02's divergence is the provider OVERRIDE +
 *   envelope + audit, not the default value.
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - Alpaca order placement carries NO HITL gate on either surface
 *   today (unlike E*TRADE E04); this slice neither adds nor
 *   weakens one. The order switch changes input normalization +
 *   audit only — the service placement call is the same in every
 *   mode, and no switch value can disable an enforcement.
 * - REST auth shapes stand in every mode (the foss/alpaca routes
 *   keep their current auth posture; no switch value widens
 *   access, disables an audit outside its own mode branch, or
 *   changes a symbol-length bound (Foss 1–20, zod).
 * - Live-only provenance stands in every mode (#923): no switch
 *   serves a static/generated substitute.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in
 * resolution order and unit-pinned, but in production today only
 * run (per-request `mode`) and global env are settable — the same
 * boundary as #1721/#1722/#1723/#1724/#1725/#1726. The route ctx
 * carrier is populated by no production caller yet.
 */

export type FossQuoteMode = "mcp" | "rest";
export type FossFundamentalsMode = "mcp" | "rest";
export type FossResearchMode = "mcp" | "rest";
export type FossBarsMode = "mcp" | "rest";
export type FossSnapshotMode = "mcp" | "rest";
export type FossAlpacaReadsMode = "mcp" | "rest" | "none";
export type FossAlpacaOrderMode = "mcp" | "foss" | "trading";

/** One switch's value per pair key, as carried at session/user level. */
export interface FossModeValues {
  quote?: unknown;
  fundamentals?: unknown;
  research?: unknown;
  bars?: unknown;
  snapshot?: unknown;
  reads?: unknown;
  order?: unknown;
}

/** Session/user carriers for the FOSS switches. */
export interface FossScopedModes {
  session?: FossModeValues;
  user?: FossModeValues;
}

/** One level set of the resolution order. Blank/unset falls through. */
export interface FossModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedFossSwitch<T extends string> {
  mode: T;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const FOSS_QUOTE_MODE_SWITCH = "FOSS_QUOTE_MODE" as const;
export const FOSS_FUNDAMENTALS_MODE_SWITCH = "FOSS_FUNDAMENTALS_MODE" as const;
export const FOSS_RESEARCH_MODE_SWITCH = "FOSS_RESEARCH_MODE" as const;
export const FOSS_BARS_MODE_SWITCH = "FOSS_BARS_MODE" as const;
export const FOSS_SNAPSHOT_MODE_SWITCH = "FOSS_SNAPSHOT_MODE" as const;
export const FOSS_ALPACA_READS_MODE_SWITCH = "FOSS_ALPACA_READS_MODE" as const;
export const FOSS_ALPACA_ORDER_MODE_SWITCH = "FOSS_ALPACA_ORDER_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function fossConfigErrorEvent(): string {
  return "foss.config_error";
}

function normalizeSwitchValue(raw: unknown, valid: string[]): string | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (valid.includes(normalized)) return normalized;
  return "invalid";
}

function resolveSwitch<T extends string>(
  levels: FossModeScopeLevels,
  legacy: T,
  valid: string[],
  switchName: string
): ResolvedFossSwitch<T> {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value, valid);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      console.warn(
        `[${fossConfigErrorEvent()}] ${switchName} unrecognized value at ${level}; failing closed to surface legacy`
      );
      return {
        mode: legacy,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized as T, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set for one switch from the scoped carrier + run + env. */
export function levelsForFossSwitch(
  scoped: FossScopedModes | undefined,
  key: keyof FossModeValues,
  run: unknown,
  envValue: unknown
): FossModeScopeLevels {
  return { run, session: scoped?.session?.[key], user: scoped?.user?.[key], env: envValue };
}

export function resolveFossQuoteMode(levels: FossModeScopeLevels, legacy: FossQuoteMode): ResolvedFossSwitch<FossQuoteMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], FOSS_QUOTE_MODE_SWITCH);
}

export function resolveFossFundamentalsMode(
  levels: FossModeScopeLevels,
  legacy: FossFundamentalsMode
): ResolvedFossSwitch<FossFundamentalsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], FOSS_FUNDAMENTALS_MODE_SWITCH);
}

export function resolveFossResearchMode(
  levels: FossModeScopeLevels,
  legacy: FossResearchMode
): ResolvedFossSwitch<FossResearchMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], FOSS_RESEARCH_MODE_SWITCH);
}

export function resolveFossBarsMode(levels: FossModeScopeLevels, legacy: FossBarsMode): ResolvedFossSwitch<FossBarsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], FOSS_BARS_MODE_SWITCH);
}

export function resolveFossSnapshotMode(
  levels: FossModeScopeLevels,
  legacy: FossSnapshotMode
): ResolvedFossSwitch<FossSnapshotMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], FOSS_SNAPSHOT_MODE_SWITCH);
}

export function resolveFossAlpacaReadsMode(
  levels: FossModeScopeLevels,
  legacy: FossAlpacaReadsMode
): ResolvedFossSwitch<FossAlpacaReadsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest", "none"], FOSS_ALPACA_READS_MODE_SWITCH);
}

export function resolveFossAlpacaOrderMode(
  levels: FossModeScopeLevels,
  legacy: FossAlpacaOrderMode
): ResolvedFossSwitch<FossAlpacaOrderMode> {
  return resolveSwitch(levels, legacy, ["mcp", "foss", "trading"], FOSS_ALPACA_ORDER_MODE_SWITCH);
}

/**
 * #1727 REST-surface convenience: resolve one switch for a route
 * host (run > session > user > global env > surface legacy) and
 * audit foss.config_error on an invalid winning value
 * (fail-closed). The host is structural ({ scopedFossModes, env,
 * audit }) so the dispatcher stays thin: one import, one call per
 * route. The audit category follows the route family: the
 * quote/fundamentals/research/bars/snapshot routes audit as
 * "research", the alpaca routes as "trading" (matching each
 * family's existing audit calls).
 */
export interface FossRestSwitchHost {
  scopedFossModes?: FossScopedModes;
  env: unknown;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
}

export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "quote", run: unknown, legacy: FossQuoteMode): FossQuoteMode;
export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "fundamentals", run: unknown, legacy: FossFundamentalsMode): FossFundamentalsMode;
export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "research", run: unknown, legacy: FossResearchMode): FossResearchMode;
export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "bars", run: unknown, legacy: FossBarsMode): FossBarsMode;
export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "snapshot", run: unknown, legacy: FossSnapshotMode): FossSnapshotMode;
export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "reads", run: unknown, legacy: FossAlpacaReadsMode): FossAlpacaReadsMode;
export function resolveFossRestSwitch(host: FossRestSwitchHost, key: "order", run: unknown, legacy: FossAlpacaOrderMode): FossAlpacaOrderMode;
export function resolveFossRestSwitch(
  host: FossRestSwitchHost,
  key: keyof FossModeValues,
  run: unknown,
  legacy: string
): string {
  const table: Record<
    keyof FossModeValues,
    {
      envVar: string;
      auditAgent: "research" | "trading";
      resolve: (levels: FossModeScopeLevels, legacy: string) => ResolvedFossSwitch<string>;
    }
  > = {
    quote: { envVar: FOSS_QUOTE_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveFossQuoteMode(l, g as FossQuoteMode) as unknown as ResolvedFossSwitch<string> },
    fundamentals: { envVar: FOSS_FUNDAMENTALS_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveFossFundamentalsMode(l, g as FossFundamentalsMode) as unknown as ResolvedFossSwitch<string> },
    research: { envVar: FOSS_RESEARCH_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveFossResearchMode(l, g as FossResearchMode) as unknown as ResolvedFossSwitch<string> },
    bars: { envVar: FOSS_BARS_MODE_SWITCH, auditAgent: "research", resolve: (l, g) => resolveFossBarsMode(l, g as FossBarsMode) as unknown as ResolvedFossSwitch<string> },
    snapshot: { envVar: FOSS_SNAPSHOT_MODE_SWITCH, auditAgent: "trading", resolve: (l, g) => resolveFossSnapshotMode(l, g as FossSnapshotMode) as unknown as ResolvedFossSwitch<string> },
    reads: { envVar: FOSS_ALPACA_READS_MODE_SWITCH, auditAgent: "trading", resolve: (l, g) => resolveFossAlpacaReadsMode(l, g as FossAlpacaReadsMode) as unknown as ResolvedFossSwitch<string> },
    order: { envVar: FOSS_ALPACA_ORDER_MODE_SWITCH, auditAgent: "trading", resolve: (l, g) => resolveFossAlpacaOrderMode(l, g as FossAlpacaOrderMode) as unknown as ResolvedFossSwitch<string> },
  };
  const entry = table[key];
  const resolved = entry.resolve(
    levelsForFossSwitch(host.scopedFossModes, key, run, (host.env as Record<string, unknown> | null)?.[entry.envVar]),
    legacy
  );
  if (resolved.invalid) {
    host.audit(fossConfigErrorEvent(), entry.auditAgent, {
      switch: entry.envVar,
      raw: resolved.raw,
      level: resolved.level,
      failedClosedTo: resolved.mode,
    });
  }
  return resolved.mode;
}

/* ================= Mode meanings (pure, shared) =================
 * What each mode VALUE means, as pure functions consumed identically
 * by the MCP commands, the /foss routes, and the /trading routes —
 * one definition per behavior, so the three surfaces cannot drift
 * apart again. These functions never touch the network, env, or
 * Cloudflare APIs; they only shape inputs, envelopes, and audit
 * payloads. The service calls themselves are unchanged.
 */

/** Audit event for a quote/fundamentals/research call, or null when the mode is silent. */
export function fossQuoteAuditEvent(mode: FossQuoteMode): string | null {
  return mode === "mcp" ? "foss.quote.fetched" : null;
}

export function fossFundamentalsAuditEvent(mode: FossFundamentalsMode): string | null {
  return mode === "mcp" ? "foss.fundamentals.fetched" : null;
}

export function fossResearchAuditEvent(mode: FossResearchMode): string {
  return mode === "mcp" ? "foss.research.generated" : "foss.research_generated";
}

/** Audit event for a bars call, or null when the mode is silent. */
export function fossBarsAuditEvent(mode: FossBarsMode): string | null {
  return mode === "mcp" ? "foss.bars.fetched" : null;
}

/** Snapshot audit: [event, payload] per mode (payload shapes are the surfaces' own legacy shapes). */
export function fossSnapshotAudit(
  mode: FossSnapshotMode,
  symbol: string,
  snapshot: { assetClass?: unknown; latestTrade?: { price?: unknown }; latestQuote?: { bidPrice?: unknown; askPrice?: unknown }; provenance?: unknown }
): [string, Record<string, unknown>] {
  if (mode === "mcp") {
    return [
      "foss.alpaca.snapshot",
      { symbol, assetClass: snapshot.assetClass, tradePrice: snapshot.latestTrade?.price, provenance: snapshot.provenance },
    ];
  }
  return [
    "alpaca.snapshot_queried",
    {
      symbol,
      price: snapshot.latestTrade?.price,
      bid: snapshot.latestQuote?.bidPrice,
      ask: snapshot.latestQuote?.askPrice,
      assetClass: snapshot.assetClass,
    },
  ];
}

export type FossAlpacaReadKind = "account" | "positions" | "orders";

/** Reads audit event per mode, or null for the silent ("none") mode. */
export function fossReadsAuditEvent(mode: FossAlpacaReadsMode, kind: FossAlpacaReadKind): string | null {
  if (mode === "mcp") return `alpaca.${kind}.query`;
  if (mode === "rest") return `alpaca.${kind}_queried`;
  return null;
}

/** Raw order input as received from any surface (MCP input, REST body). */
export interface FossOrderRawInput {
  symbol?: unknown;
  qty?: unknown;
  quantity?: unknown;
  side?: unknown;
  orderAction?: unknown;
  type?: unknown;
  orderType?: unknown;
  limit_price?: unknown;
  limitPrice?: unknown;
  time_in_force?: unknown;
}

/** Normalized order params as passed to FossResearchService.placeAlpacaOrder. */
export interface FossOrderNormalized {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  limit_price?: number;
  time_in_force: "day" | "gtc" | "ioc" | "fok";
}

/**
 * Input normalization per order mode, byte-faithful to the legacy
 * route code it generalizes:
 * - mcp: verbatim (no qty default, no uppercasing, no aliases,
 *   limit_price only) — the MCP command's legacy.
 * - foss: the /foss/alpaca/order legacy (uppercase + trim, qty =
 *   qty||quantity||1, side = side||orderAction||buy lowercased,
 *   type = type||orderType||market lowercased,
 *   limit_price||limitPrice, tif day).
 * - trading: the /trading/alpaca/order legacy (trim, no uppercase,
 *   qty||1, side lower default buy, type raw default market,
 *   limit_price only when present, tif day).
 */
export function normalizeFossOrderInput(input: FossOrderRawInput, mode: FossAlpacaOrderMode): FossOrderNormalized {
  if (mode === "mcp") {
    // Strictly verbatim: the framework-level zod defaults (type
    // market, tif day) apply before execute in MCP transport; a
    // direct execute call passes its fields through untouched.
    return {
      symbol: input.symbol as string,
      qty: input.qty as number,
      side: input.side as "buy" | "sell",
      // Narrow cast at the single construction site (the legacy
      // routes passed type/tif through `as any` at each call site).
      type: input.type as FossOrderNormalized["type"],
      limit_price: input.limit_price as number | undefined,
      time_in_force: input.time_in_force as FossOrderNormalized["time_in_force"],
    };
  }
  if (mode === "foss") {
    const symbol = String(input.symbol || "").toUpperCase().trim();
    const qty = Number((input.qty as unknown) || (input.quantity as unknown) || 1);
    const side = String(input.side || input.orderAction || "buy").toLowerCase() as "buy" | "sell";
    const type = String(input.type || input.orderType || "market").toLowerCase();
    const limitRaw = (input.limit_price as unknown) || (input.limitPrice as unknown);
    return {
      symbol,
      qty,
      side,
      type: type as FossOrderNormalized["type"],
      limit_price: limitRaw ? Number(limitRaw) : undefined,
      time_in_force: ((input.time_in_force as string) || "day") as FossOrderNormalized["time_in_force"],
    };
  }
  const symbol = String(input.symbol || "").trim();
  const qty = Number(input.qty) || 1;
  const side = String(input.side || "buy").toLowerCase() as "buy" | "sell";
  const type = (input.type as string) || "market";
  return {
    symbol,
    qty,
    side,
    type: type as FossOrderNormalized["type"],
    limit_price: input.limit_price !== undefined ? Number(input.limit_price) : undefined,
    time_in_force: ((input.time_in_force as string) || "day") as FossOrderNormalized["time_in_force"],
  };
}

/** Order audit event per mode. */
export function fossOrderAuditEvent(mode: FossAlpacaOrderMode): string {
  return mode === "mcp" ? "alpaca.order.place" : "alpaca.order_placed";
}

/**
 * Order audit payload per mode. mcp and foss carry the full field
 * set (identical shapes — only the event name differs); trading
 * carries the minimal legacy set {symbol, qty, side, status}.
 */
export function fossOrderAuditPayload(
  mode: FossAlpacaOrderMode,
  normalized: FossOrderNormalized,
  result: { orderId?: unknown; status?: unknown; success?: unknown }
): Record<string, unknown> {
  if (mode === "trading") {
    return { symbol: normalized.symbol, qty: normalized.qty, side: normalized.side, status: result.status };
  }
  return {
    symbol: normalized.symbol,
    qty: normalized.qty,
    side: normalized.side,
    // Legacy MCP audit defaulted a missing type to market; the foss
    // / trading branches always carry a normalized type already.
    type: normalized.type || "market",
    limitPrice: normalized.limit_price,
    orderId: result.orderId,
    status: result.status,
    success: result.success,
  };
}
