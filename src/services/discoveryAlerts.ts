/**
 * Discovery alerts (issue #18, Phase 2 — Decision 2).
 *
 * Selection is pure and policy-exact: a setup alerts when its
 * delta against the previous run of the same scope is NEW and its
 * discoveryScore reaches the configured floor. STRENGTHENED is
 * excluded at launch by the same rule — it is not a NEW delta —
 * not by a special case.
 *
 * Dispatch enforces the anti-spam budget against the alert log:
 * dedupe per (scope, symbol, thesis, day) and a per-scope daily
 * cap, strongest candidates first so the cap keeps the best.
 * Every alert is recorded before it is sent (the record IS the
 * in-app channel), and a failing channel never blocks the others.
 *
 * Channels are injected senders: production wiring supplies a
 * Slack webhook sender and an HMAC-signed webhook sender when the
 * environment configures them; tests supply spies.
 */

import type { EtapiDiscoveryConfig } from "../config/etapiConfig";
import type { DiscoveryAlertRecord, DiscoveryAlertStore } from "../trading";
import type { DiscoveryDelta } from "../trading";
import type { DiscoverySetupExpressedItem, StoredDiscoverySetupRun } from "../trading";

export interface DiscoveryAlertCandidate {
  item: DiscoverySetupExpressedItem;
}

/** The setups from `run` that Decision 2 selects for alerting,
 *  strongest first. */
export function selectDiscoveryAlertCandidates(
  run: Pick<StoredDiscoverySetupRun, "items">,
  deltas: readonly DiscoveryDelta[],
  config: EtapiDiscoveryConfig,
): DiscoveryAlertCandidate[] {
  const newKeys = new Set(
    deltas.filter((d) => d.kind === "NEW").map((d) => `${d.symbol}${d.thesis}`),
  );
  return run.items
    .filter(
      (item): item is DiscoverySetupExpressedItem =>
        item.kind === "setup" &&
        item.discoveryScore >= config.alertMinScore &&
        newKeys.has(`${item.symbol}${item.thesis}`),
    )
    .map((item) => ({ item }))
    .sort((a, b) => b.item.discoveryScore - a.item.discoveryScore);
}

export interface DiscoveryAlertChannelSender {
  name: string;
  send(alert: DiscoveryAlertRecord): Promise<void>;
}

export interface DiscoveryAlertDispatchResult {
  sent: DiscoveryAlertRecord[];
  skipped: Array<{ symbol: string; thesis: string; reason: "dedupe" | "daily_cap" }>;
  deliveryErrors: Array<{ channel: string; symbol: string; message: string }>;
}

export async function dispatchDiscoveryAlerts(
  deps: { store: DiscoveryAlertStore; senders: readonly DiscoveryAlertChannelSender[] },
  run: StoredDiscoverySetupRun,
  deltas: readonly DiscoveryDelta[],
  config: EtapiDiscoveryConfig,
): Promise<DiscoveryAlertDispatchResult> {
  const day = run.createdAt.slice(0, 10);
  const result: DiscoveryAlertDispatchResult = { sent: [], skipped: [], deliveryErrors: [] };
  let sentToday = await deps.store.countForDay(run.scopeKey, day);

  for (const { item } of selectDiscoveryAlertCandidates(run, deltas, config)) {
    if (await deps.store.hasAlerted(run.scopeKey, item.symbol, item.thesis, day)) {
      result.skipped.push({ symbol: item.symbol, thesis: item.thesis, reason: "dedupe" });
      continue;
    }
    if (sentToday >= config.alertDailyCap) {
      result.skipped.push({ symbol: item.symbol, thesis: item.thesis, reason: "daily_cap" });
      continue;
    }
    const record = await deps.store.record({
      runId: run.id,
      scopeKey: run.scopeKey,
      symbol: item.symbol,
      thesis: item.thesis,
      discoveryScore: item.discoveryScore,
      day,
      evidence: item.evidence,
      firedSignals: item.firedSignals,
      createdAt: run.createdAt,
    });
    sentToday++;
    result.sent.push(record);
    for (const sender of deps.senders) {
      try {
        await sender.send(record);
      } catch (err) {
        result.deliveryErrors.push({
          channel: sender.name,
          symbol: item.symbol,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

/** Plain-text alert body shared by the channel senders. */
export function formatDiscoveryAlert(alert: DiscoveryAlertRecord): string {
  return (
    `Discovery alert: ${alert.symbol} ${alert.thesis} — score ${Math.round(alert.discoveryScore)} ` +
    `(run ${alert.runId}). Evidence: ${alert.evidence}`
  );
}

/** Slack incoming-webhook sender (env SLACK_WEBHOOK_URL). */
export function slackWebhookAlertSender(webhookUrl: string): DiscoveryAlertChannelSender {
  return {
    name: "slack",
    async send(alert) {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatDiscoveryAlert(alert) }),
      });
      if (!res.ok) throw new Error(`slack webhook responded ${res.status}`);
    },
  };
}

/** HMAC-SHA256 signed webhook sender: the receiver verifies
 *  `x-discovery-signature: sha256=<hex>` over the raw body. */
export function signedWebhookAlertSender(url: string, secret: string): DiscoveryAlertChannelSender {
  return {
    name: "webhook",
    async send(alert) {
      const body = JSON.stringify(alert);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
      const hex = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-discovery-signature": `sha256=${hex}` },
        body,
      });
      if (!res.ok) throw new Error(`alert webhook responded ${res.status}`);
    },
  };
}
