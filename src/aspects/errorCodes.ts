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
