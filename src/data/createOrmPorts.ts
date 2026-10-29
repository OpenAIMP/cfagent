/**
 * src/data/createOrmPorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A): the per-DO composition root for the ORM core's
 * DO-resident ports. One composition per storage handle: the
 * nine DO-resident aggregates, the canonical report port, and
 * the read-only settings port (G-7). The marketplace tables
 * compose separately (createMarketplacePorts /
 * buildMarketplacePorts) because their residency is decided
 * by the AGENT_DB binding, not by the instance handle.
 *
 * DatabaseORM (ormFacade.ts) composes the same adapters for
 * the legacy accessor shape; consumers that need only ports
 * (e.g. the MAS tool factory) compose here.
 *
 * #CDO-mha7
 */
import type { CanonicalReportPort } from "./canonicalReportPorts";
import {
  createDoAdRepository,
  createDoCategoryRepository,
  createDoExternalAdRepository,
  createDoOptionsChainCacheRepository,
  createDoReferralRepository,
  createDoTradeRepository,
  createDoWatchlistRepository,
  createDoWebhookReplayRepository,
  DoSqliteCanonicalReportAdapter,
  DoSqliteEventLogAdapter,
  DoSqliteMemoryAdapter,
  DoSqliteMessageAdapter,
  DoSqliteSettingsReadAdapter,
  DoSqliteTransactionLedgerAdapter,
} from "./doSqliteOrmAdapters";
import type { EventLogPort } from "./eventLogPorts";
import type { MemoryPort } from "./memoryPorts";
import type { MessagePort } from "./messagePorts";
import type { RepositoryPort, SqlStorage } from "./repositoryPorts";
import type { SettingsReadPort } from "./settingsReadPorts";
import type { TransactionLedgerPort } from "./transactionLedgerPorts";
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  OptionsChainCacheRecord,
  ReferralRecord,
  TradeRecord,
  WatchlistRecord,
  WebhookReplayNonce,
} from "../types";

/** The DO-resident port set for one storage handle. */
export interface OrmPorts {
  categories: RepositoryPort<CategoryRecord>;
  referrals: RepositoryPort<ReferralRecord>;
  ads: RepositoryPort<AdRecord>;
  externalAds: RepositoryPort<ExternalAdRecord>;
  transactions: TransactionLedgerPort;
  messages: MessagePort;
  memory: MemoryPort;
  events: EventLogPort;
  webhookReplay: RepositoryPort<WebhookReplayNonce>;
  trades: RepositoryPort<TradeRecord>;
  watchlists: RepositoryPort<WatchlistRecord>;
  optionsChainCache: RepositoryPort<OptionsChainCacheRecord>;
  reports: CanonicalReportPort;
  settingsRead: SettingsReadPort;
}

/** Compose the DO-resident ports over one instance's storage. */
export function createOrmPorts(sql: SqlStorage): OrmPorts {
  const storage = sql;
  return {
    categories: createDoCategoryRepository(storage),
    referrals: createDoReferralRepository(storage),
    ads: createDoAdRepository(storage),
    externalAds: createDoExternalAdRepository(storage),
    transactions: new DoSqliteTransactionLedgerAdapter(storage),
    messages: new DoSqliteMessageAdapter(storage),
    memory: new DoSqliteMemoryAdapter(storage),
    events: new DoSqliteEventLogAdapter(storage),
    webhookReplay: createDoWebhookReplayRepository(storage),
    trades: createDoTradeRepository(storage),
    watchlists: createDoWatchlistRepository(storage),
    optionsChainCache: createDoOptionsChainCacheRepository(storage),
    reports: new DoSqliteCanonicalReportAdapter(storage),
    settingsRead: new DoSqliteSettingsReadAdapter(storage),
  };
}
