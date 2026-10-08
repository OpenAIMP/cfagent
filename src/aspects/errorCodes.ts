/**
 * Externalized Error Codes & Aspect-Oriented Error Definitions
 *
 * Implements:
 * - Single Source of Truth for domain and broker error codes.
 * - Standardized HTTP status mappings.
 * - Consistent structured error responses for REST & MCP callers.
 */

export enum ETradeErrorCode {
  AUTH_REQUIRED = "ETRADE_AUTH_REQUIRED",
  TOKEN_EXPIRED = "ETRADE_TOKEN_EXPIRED",
  CREDENTIALS_MISSING = "ETRADE_CREDENTIALS_MISSING",
  SANDBOX_GUARD_VIOLATION = "ETRADE_SANDBOX_GUARD_VIOLATION",
  UPSTREAM_ERROR = "ETRADE_UPSTREAM_ERROR",
  RATE_LIMITED = "ETRADE_RATE_LIMITED",
  INVALID_SYMBOL = "ETRADE_INVALID_SYMBOL",
  ORDER_RISK_LIMIT = "ETRADE_ORDER_RISK_LIMIT",
  ORDER_REJECTED = "ETRADE_ORDER_REJECTED",
  ORDER_NOT_FOUND = "ETRADE_ORDER_NOT_FOUND",
  INSUFFICIENT_FUNDS = "ETRADE_INSUFFICIENT_FUNDS",
  UNAUTHORIZED_ACTION = "ETRADE_UNAUTHORIZED_ACTION",
  INTERNAL_ERROR = "ETRADE_INTERNAL_ERROR",
}

export interface ErrorMetadata {
  code: ETradeErrorCode;
  httpStatus: number;
  defaultMessage: string;
  remediation: string;
}

export const ERROR_CATALOG: Record<ETradeErrorCode, ErrorMetadata> = {
  [ETradeErrorCode.AUTH_REQUIRED]: {
    code: ETradeErrorCode.AUTH_REQUIRED,
    httpStatus: 401,
    defaultMessage: "Authentication Required for E*TRADE Broker API. 3-legged OAuth 1.0a connection required.",
    remediation: "Initiate OAuth handshake via /api/etrade/oauth/start and enter your verification PIN.",
  },
  [ETradeErrorCode.TOKEN_EXPIRED]: {
    code: ETradeErrorCode.TOKEN_EXPIRED,
    httpStatus: 401,
    defaultMessage: "Your E*TRADE session expired at midnight US Eastern Time.",
    remediation: "Renew token before midnight ET via /api/etrade/oauth/renew or re-authenticate.",
  },
  [ETradeErrorCode.CREDENTIALS_MISSING]: {
    code: ETradeErrorCode.CREDENTIALS_MISSING,
    httpStatus: 400,
    defaultMessage: "E*TRADE API Key or Secret is not configured in the active environment.",
    remediation: "Set ET_API_KEY and ET_API_SECRET in the active GitHub Environment secrets.",
  },
  [ETradeErrorCode.SANDBOX_GUARD_VIOLATION]: {
    code: ETradeErrorCode.SANDBOX_GUARD_VIOLATION,
    httpStatus: 403,
    defaultMessage: "SECURITY ENFORCEMENT: Outgoing call to live production URL was blocked while running in TEST/Sandbox mode.",
    remediation: "Ensure all endpoints in TEST environment target apisb.etrade.com.",
  },
  [ETradeErrorCode.UPSTREAM_ERROR]: {
    code: ETradeErrorCode.UPSTREAM_ERROR,
    httpStatus: 502,
    defaultMessage: "E*TRADE upstream broker service returned an error.",
    remediation: "Verify parameters, check E*TRADE API status, and inspect request headers.",
  },
  [ETradeErrorCode.RATE_LIMITED]: {
    code: ETradeErrorCode.RATE_LIMITED,
    httpStatus: 429,
    defaultMessage: "E*TRADE API rate limit exceeded.",
    remediation: "Wait for the rate limit window to reset before retrying.",
  },
  [ETradeErrorCode.INVALID_SYMBOL]: {
    code: ETradeErrorCode.INVALID_SYMBOL,
    httpStatus: 400,
    defaultMessage: "Invalid ticker symbol provided.",
    remediation: "Provide a valid equity ticker symbol (e.g. NVDA, AAPL, MSFT).",
  },
  [ETradeErrorCode.ORDER_RISK_LIMIT]: {
    code: ETradeErrorCode.ORDER_RISK_LIMIT,
    httpStatus: 400,
    defaultMessage: "Order exceeds automated risk management thresholds.",
    remediation: "Reduce quantity or limit price to comply with single-order exposure limits.",
  },
  [ETradeErrorCode.ORDER_REJECTED]: {
    code: ETradeErrorCode.ORDER_REJECTED,
    httpStatus: 400,
    defaultMessage: "Order draft was rejected by reviewer or risk engine.",
    remediation: "Review notes and formulate a new proposal.",
  },
  [ETradeErrorCode.ORDER_NOT_FOUND]: {
    code: ETradeErrorCode.ORDER_NOT_FOUND,
    httpStatus: 404,
    defaultMessage: "Order preview ID not found.",
    remediation: "Generate a new order preview draft first.",
  },
  [ETradeErrorCode.INSUFFICIENT_FUNDS]: {
    code: ETradeErrorCode.INSUFFICIENT_FUNDS,
    httpStatus: 400,
    defaultMessage: "Purchasing power insufficient to cover estimated order total.",
    remediation: "Deposit funds or reduce order quantity.",
  },
  [ETradeErrorCode.UNAUTHORIZED_ACTION]: {
    code: ETradeErrorCode.UNAUTHORIZED_ACTION,
    httpStatus: 403,
    defaultMessage: "User is not authorized to execute orders for this session.",
    remediation: "Verify DID attestation and authorizer identity.",
  },
  [ETradeErrorCode.INTERNAL_ERROR]: {
    code: ETradeErrorCode.INTERNAL_ERROR,
    httpStatus: 500,
    defaultMessage: "An unexpected error occurred during E*TRADE operation.",
    remediation: "Check application audit logs for details.",
  },
};

export class ETradeError extends Error {
  public readonly code: ETradeErrorCode;
  public readonly httpStatus: number;
  public readonly remediation: string;
  public readonly details?: unknown;

  constructor(code: ETradeErrorCode, customMessage?: string, details?: unknown) {
    const meta = ERROR_CATALOG[code] || ERROR_CATALOG[ETradeErrorCode.INTERNAL_ERROR];
    super(customMessage || meta.defaultMessage);
    this.name = "ETradeError";
    this.code = code;
    this.httpStatus = meta.httpStatus;
    this.remediation = meta.remediation;
    this.details = details;
  }

  toJSON() {
    return {
      success: false,
      error: this.message,
      code: this.code,
      httpStatus: this.httpStatus,
      remediation: this.remediation,
      details: this.details,
    };
  }
}

/**
 * Externalized Agent, AI Inference, and Streaming Error Codes
 */
export enum AgentErrorCode {
  AI_NEURON_QUOTA_EXCEEDED = "ERR_AI_NEURON_QUOTA_EXCEEDED",
  AI_RATE_LIMITED = "ERR_AI_RATE_LIMITED",
  AI_STREAM_FAILURE = "ERR_AI_STREAM_FAILURE",
  AI_MODEL_UNAVAILABLE = "ERR_AI_MODEL_UNAVAILABLE",
  AGENT_CONNECTION_DROPPED = "ERR_AGENT_CONNECTION_DROPPED",
  AGENT_TURN_TIMEOUT = "ERR_AGENT_TURN_TIMEOUT",
  SESSION_STORAGE_ERROR = "ERR_SESSION_STORAGE_ERROR",
  TOOL_EXECUTION_FAILED = "ERR_TOOL_EXECUTION_FAILED",
  MARKET_DATA_UNAVAILABLE = "ERR_MARKET_DATA_UNAVAILABLE",
  UNKNOWN_AGENT_ERROR = "ERR_UNKNOWN_AGENT_ERROR",
}

export interface AgentErrorMetadata {
  code: AgentErrorCode;
  httpStatus: number;
  title: string;
  defaultMessage: string;
  remediation: string;
  resolutionSteps: string[];
  suggestedTab?: "trading" | "research" | "audit" | "nlq" | "workflows";
  suggestedTabLabel?: string;
}

export const AGENT_ERROR_CATALOG: Record<AgentErrorCode, AgentErrorMetadata> = {
  [AgentErrorCode.AI_NEURON_QUOTA_EXCEEDED]: {
    code: AgentErrorCode.AI_NEURON_QUOTA_EXCEEDED,
    httpStatus: 429,
    title: "Workers AI Daily Allocation Reached (Error 4006)",
    defaultMessage: "You have used up your daily free allocation of 10,000 neurons on Cloudflare Workers AI.",
    remediation: "Run deterministic screening without AI tokens, or upgrade to Cloudflare Workers Paid.",
    resolutionSteps: [
      "Use the E*TRADE · Multi-Asset Screeners tab directly: Stock & option screening runs deterministically via Nasdaq/Yahoo market feeds and consumes 0 AI neurons.",
      "Upgrade your Cloudflare account to Workers Paid ($5/mo) in the Cloudflare dashboard to unlock unlimited pay-as-you-go neurons.",
      "The free daily quota resets automatically every 24 hours at 00:00 UTC.",
    ],
    suggestedTab: "trading",
    suggestedTabLabel: "Open Stock Screener Tab",
  },
  [AgentErrorCode.AI_RATE_LIMITED]: {
    code: AgentErrorCode.AI_RATE_LIMITED,
    httpStatus: 429,
    title: "AI Inference Rate Limit Exceeded",
    defaultMessage: "Too many concurrent requests were sent to the Workers AI model gateway.",
    remediation: "Wait a few seconds for the rate-limiting window to clear, then resend your message.",
    resolutionSteps: [
      "Wait 5-10 seconds for the burst rate limit window to expire.",
      "Click Reconnect or resubmit your prompt.",
      "Use the dedicated Screeners or Research tabs for direct zero-AI queries.",
    ],
    suggestedTab: "trading",
    suggestedTabLabel: "Open Screeners Tab",
  },
  [AgentErrorCode.AI_STREAM_FAILURE]: {
    code: AgentErrorCode.AI_STREAM_FAILURE,
    httpStatus: 502,
    title: "AI Response Stream Interrupted",
    defaultMessage: "The streaming connection from Workers AI terminated prematurely or timed out.",
    remediation: "Reconnect the agent or resend your prompt.",
    resolutionSteps: [
      "Click the 🔄 Reconnect button to re-establish the WebSocket stream.",
      "If the conversation state is corrupted, click Reset & Clear History.",
      "Verify your internet connection and check Cloudflare service status.",
    ],
    suggestedTab: "audit",
    suggestedTabLabel: "Inspect Audit Telemetry",
  },
  [AgentErrorCode.AI_MODEL_UNAVAILABLE]: {
    code: AgentErrorCode.AI_MODEL_UNAVAILABLE,
    httpStatus: 503,
    title: "Workers AI Model Temporarily Unavailable",
    defaultMessage: "The active Cloudflare Workers AI model endpoint is experiencing elevated latency or downtime.",
    remediation: "Try again later or execute operations via the direct API tabs.",
    resolutionSteps: [
      "Verify Cloudflare Workers AI status at https://www.cloudflarestatus.com.",
      "Use the dedicated Screeners and Research tabs which operate independently of the AI model.",
      "Retry your query in a few minutes.",
    ],
    suggestedTab: "trading",
    suggestedTabLabel: "Open Screeners Tab",
  },
  [AgentErrorCode.AGENT_CONNECTION_DROPPED]: {
    code: AgentErrorCode.AGENT_CONNECTION_DROPPED,
    httpStatus: 504,
    title: "Agent Connection / WebSocket Dropped",
    defaultMessage: "The real-time WebSocket connection to the Cloudflare Agent Durable Object was closed unexpectedly.",
    remediation: "Reconnect the session or reset history.",
    resolutionSteps: [
      "Click 🔄 Reconnect to reconnect to the session Durable Object.",
      "Click Reset & Clear History to purge any corrupted session state.",
      "Refresh the browser tab if network connectivity was temporarily lost.",
    ],
  },
  [AgentErrorCode.AGENT_TURN_TIMEOUT]: {
    code: AgentErrorCode.AGENT_TURN_TIMEOUT,
    httpStatus: 504,
    title: "Agent Execution Turn Timed Out",
    defaultMessage: "The multi-step tool execution took longer than the configured timeout threshold.",
    remediation: "Simplify your prompt or query specific tools directly.",
    resolutionSteps: [
      "Break complex compound queries into single-step questions.",
      "Target specific tickers or actions (e.g. 'Screen NVDA options' rather than scanning all 8,000 stocks).",
      "Inspect the Audit tab to see which tool call exceeded the deadline.",
    ],
    suggestedTab: "audit",
    suggestedTabLabel: "View Audit Logs",
  },
  [AgentErrorCode.SESSION_STORAGE_ERROR]: {
    code: AgentErrorCode.SESSION_STORAGE_ERROR,
    httpStatus: 500,
    title: "Durable Object SQLite Storage Error",
    defaultMessage: "Failed to read or write session state in the SQLite Durable Object database.",
    remediation: "Reset conversation history to initialize a clean database instance.",
    resolutionSteps: [
      "Click Reset & Clear History to recreate SQLite tables.",
      "Check storage quota in Cloudflare dashboard.",
    ],
  },
  [AgentErrorCode.TOOL_EXECUTION_FAILED]: {
    code: AgentErrorCode.TOOL_EXECUTION_FAILED,
    httpStatus: 500,
    title: "Agent Tool Execution Error",
    defaultMessage: "An internal MCP tool or external broker integration failed during multi-step execution.",
    remediation: "Review parameter inputs or check broker connection status.",
    resolutionSteps: [
      "Check if your broker (E*TRADE) session requires OAuth re-authentication.",
      "Review the Audit tab for exact tool arguments and stack traces.",
      "Try executing the operation via the dedicated UI hub.",
    ],
    suggestedTab: "trading",
    suggestedTabLabel: "Open Trading Hub",
  },
  [AgentErrorCode.MARKET_DATA_UNAVAILABLE]: {
    code: AgentErrorCode.MARKET_DATA_UNAVAILABLE,
    httpStatus: 502,
    title: "Market Data Upstream Error",
    defaultMessage: "Failed to retrieve real-time quotes or screener results from exchange data feeds.",
    remediation: "Verify market status and symbol ticker spelling.",
    resolutionSteps: [
      "Check ticker spelling (e.g. AAPL, NVDA, SPY).",
      "Note whether markets are closed or in pre/post-market sessions.",
      "Use the Research tab for Yahoo Finance / Alpaca fallback data.",
    ],
    suggestedTab: "research",
    suggestedTabLabel: "Open FOSS Research Tab",
  },
  [AgentErrorCode.UNKNOWN_AGENT_ERROR]: {
    code: AgentErrorCode.UNKNOWN_AGENT_ERROR,
    httpStatus: 500,
    title: "Unexpected Agent Error",
    defaultMessage: "An unexpected error occurred during agent conversation or stream processing.",
    remediation: "Reconnect or reset the chat session.",
    resolutionSteps: [
      "Click 🔄 Reconnect to refresh the connection.",
      "Click Reset & Clear History if the conversation is stuck.",
      "Review the Audit tab for diagnostic logs.",
    ],
  },
};

export interface ErrorResolutionAspect {
  code: string;
  title: string;
  message: string;
  remediation: string;
  resolutionSteps: string[];
  suggestedTab?: "trading" | "research" | "audit" | "nlq" | "workflows";
  suggestedTabLabel?: string;
  rawError?: string;
  isAiQuota?: boolean;
}

/**
 * Universal Aspect: Translates any raw error or exception into a standardized, externalized error aspect.
 */
export function resolveErrorAspect(err: unknown): ErrorResolutionAspect {
  const rawMsg = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err || "");
  const lower = rawMsg.toLowerCase();

  // 1. Cloudflare Workers AI Quota / Free allocation error 4006
  if (lower.includes("4006") || lower.includes("10,000 neurons") || lower.includes("neuron") || (lower.includes("free allocation") && lower.includes("daily"))) {
    const meta = AGENT_ERROR_CATALOG[AgentErrorCode.AI_NEURON_QUOTA_EXCEEDED];
    return {
      code: meta.code,
      title: meta.title,
      message: meta.defaultMessage,
      remediation: meta.remediation,
      resolutionSteps: meta.resolutionSteps,
      suggestedTab: meta.suggestedTab,
      suggestedTabLabel: meta.suggestedTabLabel,
      rawError: rawMsg,
      isAiQuota: true,
    };
  }

  // 2. Rate limiting
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
    const meta = AGENT_ERROR_CATALOG[AgentErrorCode.AI_RATE_LIMITED];
    return {
      code: meta.code,
      title: meta.title,
      message: meta.defaultMessage,
      remediation: meta.remediation,
      resolutionSteps: meta.resolutionSteps,
      suggestedTab: meta.suggestedTab,
      suggestedTabLabel: meta.suggestedTabLabel,
      rawError: rawMsg,
    };
  }

  // 3. Stream failure
  if (lower.includes("stream error") || lower.includes("stream terminated") || lower.includes("ui stream error") || lower.includes("chat stream error") || lower.includes("stream")) {
    const meta = AGENT_ERROR_CATALOG[AgentErrorCode.AI_STREAM_FAILURE];
    return {
      code: meta.code,
      title: meta.title,
      message: meta.defaultMessage,
      remediation: meta.remediation,
      resolutionSteps: meta.resolutionSteps,
      suggestedTab: meta.suggestedTab,
      suggestedTabLabel: meta.suggestedTabLabel,
      rawError: rawMsg,
    };
  }

  // 4. WebSocket / Connection dropped
  if (lower.includes("websocket") || lower.includes("connection") || lower.includes("readystate") || lower.includes("disconnected") || lower.includes("offline")) {
    const meta = AGENT_ERROR_CATALOG[AgentErrorCode.AGENT_CONNECTION_DROPPED];
    return {
      code: meta.code,
      title: meta.title,
      message: meta.defaultMessage,
      remediation: meta.remediation,
      resolutionSteps: meta.resolutionSteps,
      rawError: rawMsg,
    };
  }


  // 5. E*TRADE token expired
  if (lower.includes("token_expired") || lower.includes("session expired") || lower.includes("oauth token")) {
    const meta = ERROR_CATALOG[ETradeErrorCode.TOKEN_EXPIRED];
    return {
      code: meta.code,
      title: "E*TRADE Session Expired",
      message: meta.defaultMessage,
      remediation: meta.remediation,
      resolutionSteps: [
        "Your E*TRADE access token has reached its daily expiration (midnight ET).",
        "Navigate to the Trading tab and click Authenticate / Renew E*TRADE Session.",
        "Enter your verification PIN to resume trading capabilities.",
      ],
      suggestedTab: "trading",
      suggestedTabLabel: "Authenticate E*TRADE",
      rawError: rawMsg,
    };
  }

  // 6. E*TRADE Auth required
  if (lower.includes("auth_required") || lower.includes("authentication required")) {
    const meta = ERROR_CATALOG[ETradeErrorCode.AUTH_REQUIRED];
    return {
      code: meta.code,
      title: "E*TRADE Authentication Required",
      message: meta.defaultMessage,
      remediation: meta.remediation,
      resolutionSteps: [
        "E*TRADE OAuth connection is required for live portfolio and order execution.",
        "Navigate to the Trading tab and start OAuth authorization.",
        "Read-only market screening and FOSS research remain accessible without broker login.",
      ],
      suggestedTab: "trading",
      suggestedTabLabel: "Connect E*TRADE",
      rawError: rawMsg,
    };
  }

  // 7. General fallback
  const fallback = AGENT_ERROR_CATALOG[AgentErrorCode.UNKNOWN_AGENT_ERROR];
  return {
    code: fallback.code,
    title: fallback.title,
    message: rawMsg && rawMsg !== "Agent stream error." ? rawMsg : fallback.defaultMessage,
    remediation: fallback.remediation,
    resolutionSteps: fallback.resolutionSteps,
    rawError: rawMsg,
  };
}

export class AgentError extends Error {
  public readonly code: AgentErrorCode;
  public readonly httpStatus: number;
  public readonly title: string;
  public readonly remediation: string;
  public readonly resolutionSteps: string[];
  public readonly suggestedTab?: string;
  public readonly suggestedTabLabel?: string;
  public readonly details?: unknown;

  constructor(code: AgentErrorCode, customMessage?: string, details?: unknown) {
    const meta = AGENT_ERROR_CATALOG[code] || AGENT_ERROR_CATALOG[AgentErrorCode.UNKNOWN_AGENT_ERROR];
    super(customMessage || meta.defaultMessage);
    this.name = "AgentError";
    this.code = code;
    this.httpStatus = meta.httpStatus;
    this.title = meta.title;
    this.remediation = meta.remediation;
    this.resolutionSteps = meta.resolutionSteps;
    this.suggestedTab = meta.suggestedTab;
    this.suggestedTabLabel = meta.suggestedTabLabel;
    this.details = details;
  }

  toJSON() {
    return {
      success: false,
      error: this.message,
      code: this.code,
      title: this.title,
      httpStatus: this.httpStatus,
      remediation: this.remediation,
      resolutionSteps: this.resolutionSteps,
      suggestedTab: this.suggestedTab,
      details: this.details,
    };
  }
}

