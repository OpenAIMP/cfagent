/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the broker diagnostics
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { resolveEnvironmentConfig } from "../../config/environment";
import { getValidTokens, etradeIdentityFromLogin } from "../../security/etradeOAuth";
import { ETradeRestClient } from "../../trading";
import type { EtradeBrokerRouteContext } from "./etradeBroker";

export async function handleEtradeDiagnostics(request: Request, sessionId: string, ctx: EtradeBrokerRouteContext, requestedEnv: "TEST" | "PROD" | undefined): Promise<Response> {
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const envConfig = resolveEnvironmentConfig(ctx.env, requestedEnv);
    // Issue #2442 S3: the diagnostics verdict resolves identity via
    // the alias record, so it agrees with the panel instead of missing
    // internal-id and alias-login keys. The client leg below is
    // untouched here; S2 (#2441) owns the client.
    const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
    const valid = await getValidTokens(ctx.env, userLogin, requestedEnv, identity);
    const client = new ETradeRestClient(ctx.env, userLogin, requestedEnv);

    let accounts: any[] = [];
    let balance: any = null;
    let lastError: string | null = null;

    if (valid) {
      accounts = await client.fetchAccounts();
      lastError = client.getLastError() || null;
      if (accounts.length > 0) {
        const key = accounts[0].accountKey || accounts[0].accountId;
        balance = await client.fetchBalance(key);
      }
    } else {
      lastError = client.getLastError() || `No active OAuth session in [${envConfig.name}] mode. Click 'Connect E*TRADE Account'.`;
    }

    return Response.json({
      status: accounts.length > 0 ? "healthy" : (valid ? "upstream_error" : "auth_required"),
      environment: envConfig.name,
      isLive: envConfig.isLive,
      apiUrl: envConfig.etrade.baseUrl,
      userLogin,
      credentials: {
        apiKeyConfigured: Boolean(envConfig.etrade.apiKey),
        apiKeyMasked: envConfig.etrade.apiKey ? `${envConfig.etrade.apiKey.slice(0, 4)}...${envConfig.etrade.apiKey.slice(-4)}` : "MISSING",
        apiSecretConfigured: Boolean(envConfig.etrade.apiSecret),
      },
      oauthToken: {
        present: Boolean(valid),
        storedAt: valid?.storedAt || null,
        environment: valid?.environment || envConfig.name,
        validUntilMidnightEt: "E*TRADE access tokens expire at midnight US Eastern Time",
      },
      upstreamAccounts: {
        count: accounts.length,
        accounts,
      },
      upstreamBalance: balance,
      lastError,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return Response.json({ error: err.message || "Failed to run diagnostics" }, { status: 500 });
  }
}
