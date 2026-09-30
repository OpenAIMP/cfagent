export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SESSIONS: KVNamespace;
  SEARCH_AGENT: DurableObjectNamespace;
  AI_SEARCH_ENDPOINT: string;
  APP_NAME: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_BASE_URL: string;
  SESSION_SECRET: string;
  MAS_MAX_STEPS?: string;
  AI_MODEL?: string;
  // Payment Gateway Secrets (Stripe, PayPal, Lemon Squeezy)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_ENVIRONMENT?: "sandbox" | "live";
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  // Optional / backward-compatible bindings
  KV?: KVNamespace;
  PAYMENTS_AGENT?: DurableObjectNamespace;
  TASKS_AGENT?: DurableObjectNamespace;
  MEMORY_AGENT?: DurableObjectNamespace;
}

export interface TransactionRecord {
  id: string;
  sessionId: string;
  action: "charge" | "refund" | "invoice" | "payout";
  amount: number;
  currency: string;
  customer: string;
  gateway: "stripe" | "paypal" | "lemonsqueezy" | "sandbox";
  gatewayRef?: string;
  status: "draft" | "awaiting_confirmation" | "authorized" | "completed" | "failed" | "rejected";
  checkoutUrl?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  githubLogin: string;
  githubAvatar: string;
  githubName: string;
  createdAt: number;
}

export type AgentName = "search" | "payments" | "tasks" | "memory" | "general";

export interface AuditEvent {
  id: string;
  sessionId: string;
  type: string;
  agent: AgentName | "judge" | "nlq" | "orchestrator";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent: AgentName | "orchestrator";
  createdAt: string;
}

export interface MemoryRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface RouteDecision {
  agent: AgentName;
  confidence: number;
  reason: string;
  needsConfirmation: boolean;
}

export interface QualityDecision {
  score: number;
  grounded: boolean;
  safe: boolean;
  issues: string[];
}

export interface ReferralRecord {
  id: string;
  userLogin: string;
  title: string;
  url: string;
  category: string;
  rewardText: string;
  clicks: number;
  signups: number;
  createdAt: string;
}

export interface AdRecord {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge: string;
  url: string;
  ctaText: string;
  accentColor: string;
  impressions: number;
  clicks: number;
  createdAt: string;
}

export interface CategoryRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAdRecord {
  id: string;
  name: string;
  network: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  placement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  title: string;
  tagline: string;
  ctaText: string;
  targetUrl: string;
  bannerImageUrl?: string;
  cpmRate: number;
  cpcRate: number;
  impressions: number;
  clicks: number;
  earnings: number;
  isActive: boolean;
  createdAt: string;
}

export interface RevenueSummary {
  grossRevenue: number;
  adNetworkRevenue: number;
  marketplaceRevenue: number;
  paymentPlatformFees: number;
  referralPayouts: number;
  netRevenue: number;
  totalImpressions: number;
  totalAdClicks: number;
  averageRPM: number;
}

