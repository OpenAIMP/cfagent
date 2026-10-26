/**
 * #1726 (parent #1717, slice (f)): the REST mode-branch bodies for
 * the E*TRADE pairs. The dispatcher in etradeBroker.ts owns every
 * route condition and every ETradeService construction (the #995
 * ledger); this sibling module owns only the branch bodies, which
 * take their constructed dependencies as parameters and construct
 * no ETradeService themselves.
 *
 * - etradePositionsMcpEnvelope: the MCP reshaped positions envelope
 *   (E05 mcp branch).
 * - etradeQuoteMcp: the MCP quote semantics on the REST route (E02
 *   mcp branch: symbol required, no env override, quote_fetched
 *   audit). The caller validates the symbol first.
 * - etradePreviewLocal: the MCP local equity-only draft on the REST
 *   route (E03 local branch). The caller rejects option legs first.
 */

import { TradingPlatformRegistry, fetchQuoteLiveStrict } from "../../trading";
import { resolveEnvironmentConfig } from "../../config/environment";
import type { ETradeService } from "../../services/etrade";
import type { EtradeBrokerRouteContext } from "./etradeBroker";

export async function etradePositionsMcpEnvelope(etrade: ETradeService): Promise<Record<string, unknown>> {
  const { account, positions } = await etrade.fetchPortfolioRemote();
  const accounts = await etrade.fetchAccountsRemote();
  return {
    account,
    accounts,
    positions,
    totalPortfolioValue: account.totalAccountValue,
    totalCash: account.cashAvailableForInvestment,
    positionsCount: positions.length,
    asOf: new Date().toISOString(),
  };
}

export async function etradeQuoteMcp(args: {
  ctx: EtradeBrokerRouteContext;
  userLogin: string;
  symbol: string;
}): Promise<unknown> {
  const { ctx, userLogin, symbol } = args;
  const platform = TradingPlatformRegistry.getPlatform("etrade", ctx.env, ctx.getOrm(), userLogin, undefined);
  const quote = await fetchQuoteLiveStrict(platform, symbol, {
    isLive: resolveEnvironmentConfig(ctx.env, undefined).isLive,
  });
  ctx.audit("etrade.quote_fetched", "trading", {
    symbol: (quote as any).symbol,
    lastPrice: (quote as any).lastPrice,
    changePercent: (quote as any).changePercent,
  });
  return quote;
}

export function etradePreviewLocal(args: {
  etrade: ETradeService;
  symbol: string;
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType: string;
  limitPrice: number | undefined;
  stopPrice: number | undefined;
  sessionId: string;
}): unknown {
  const { etrade, symbol, orderAction, quantity, orderType, limitPrice, stopPrice, sessionId } = args;
  return etrade.previewOrder({
    symbol,
    action: orderAction,
    orderAction,
    quantity,
    orderType: orderType as "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT",
    limitPrice,
    stopPrice,
    sessionId,
  });
}
