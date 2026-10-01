import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMidnightEtUtcMs,
  isTokenExpiredEt,
  getETradeRequestToken,
  exchangeETradeVerifier,
  renewETradeAccessToken,
  revokeStoredTokens,
  getValidTokens,
  getETradeAuthStatus,
  storeAccessTokens,
} from "../src/services/etradeOAuth";
import { ETradeService } from "../src/services/etrade";
import type { Env } from "../src/types";

// In-memory KV mock for testing token storage
class MockKVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    return item.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe("E*TRADE OAuth 1.0a Full Token Lifecycle & Account Discovery", () => {
  let mockKv: MockKVNamespace;
  let env: Env;
  const userLogin = "trader_alice";

  beforeEach(() => {
    vi.restoreAllMocks();
    mockKv = new MockKVNamespace();
    env = {
      APP_ENV: "TEST",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_KV: mockKv as any,
      SESSIONS: mockKv as any,
    } as Env;
  });

  describe("Midnight US Eastern Time Expiry Mechanics", () => {
    it("computes midnight ET timestamp reliably", () => {
      const midnightMs = getMidnightEtUtcMs(Date.now());
      expect(midnightMs).toBeGreaterThan(0);

      // Verify that midnight in ET corresponds to hour 0 in America/New_York
      const etHour = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(new Date(midnightMs));
      expect(["0", "00", "24"]).toContain(etHour);
    });

    it("identifies tokens stored today as active and past midnight as expired", () => {
      const now = Date.now();
      const todayIso = new Date(now).toISOString();
      expect(isTokenExpiredEt(todayIso, now)).toBe(false);

      // 48 hours ago is guaranteed past midnight ET
      const twoDaysAgoIso = new Date(now - 48 * 3600 * 1000).toISOString();
      expect(isTokenExpiredEt(twoDaysAgoIso, now)).toBe(true);
    });
  });

  describe("Step 1: Request Token Handshake", () => {
    it("fetches request token signed with consumer key/secret and generates auth URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("oauth_token=req_tok_789&oauth_token_secret=req_sec_abc&oauth_callback_confirmed=true", {
          status: 200,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
      );

      const result = await getETradeRequestToken(env, userLogin);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://apisb.etrade.com/oauth/request_token");
      expect((init?.headers as any)?.Authorization).toMatch(/^OAuth /);
      expect((init?.headers as any)?.Authorization).toContain('oauth_consumer_key="sandbox_consumer_key_123"');
      expect((init?.headers as any)?.Authorization).toContain('oauth_callback="oob"');

      expect(result.requestToken).toBe("req_tok_789");
      expect(result.requestTokenSecret).toBe("req_sec_abc");
      expect(result.authorizeUrl).toContain("https://us.etrade.com/e/t/etws/authorize");
      expect(result.authorizeUrl).toContain("key=sandbox_consumer_key_123");
      expect(result.authorizeUrl).toContain("token=req_tok_789");
    });
  });

  describe("Step 3: Exchange Verifier PIN for Access Token", () => {
    it("exchanges verifier code for access token and stores in KV", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("oauth_token=access_tok_xyz&oauth_token_secret=access_sec_999", {
          status: 200,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
      );

      const tokenSet = await exchangeETradeVerifier(
        env,
        userLogin,
        "VERIFY_PIN_123",
        "req_tok_789",
        "req_sec_abc"
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://apisb.etrade.com/oauth/access_token");
      expect((init?.headers as any)?.Authorization).toContain('oauth_verifier="VERIFY_PIN_123"');

      expect(tokenSet.accessToken).toBe("access_tok_xyz");
      expect(tokenSet.accessTokenSecret).toBe("access_sec_999");
      expect(tokenSet.userLogin).toBe(userLogin);

      // Verify token persisted in KV
      const stored = await getValidTokens(env, userLogin);
      expect(stored?.accessToken).toBe("access_tok_xyz");
      expect(stored?.accessTokenSecret).toBe("access_sec_999");
    });
  });

  describe("Step 4: Renew Access Token before midnight ET", () => {
    it("calls renew_access_token and updates stored timestamp", async () => {
      await storeAccessTokens(env, userLogin, "token_to_renew", "secret_to_renew");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Access Token has been renewed", {
          status: 200,
        })
      );

      const renewed = await renewETradeAccessToken(env, userLogin);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://apisb.etrade.com/oauth/renew_access_token");
      expect((init?.headers as any)?.Authorization).toContain('oauth_token="token_to_renew"');

      expect(renewed).not.toBeNull();
      expect(renewed?.accessToken).toBe("token_to_renew");
    });
  });

  describe("Account Discovery & Portfolio Navigation (/v1/accounts/list -> /v1/accounts/{accountIdKey}/portfolio)", () => {
    it("calls accounts/list, selects returned accountIdKey, and queries portfolio without template literals", async () => {
      await storeAccessTokens(env, userLogin, "active_access_token", "active_token_secret");

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        // 1. GET /v1/accounts/list.json
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              AccountListResponse: {
                Accounts: {
                  Account: [
                    {
                      accountId: "83921048",
                      accountIdKey: "REAL_KEY_ABC777",
                      accountDesc: "Active Margin Account",
                      accountType: "MARGIN",
                      netAccountValue: 150000,
                      cashAvailableForInvestment: 60000,
                    },
                  ],
                },
              },
            }),
            { status: 200 }
          )
        )
        // 2. GET /v1/accounts/REAL_KEY_ABC777/portfolio.json
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              PortfolioResponse: {
                AccountPortfolio: [
                  {
                    Position: [
                      {
                        Product: { symbol: "NVDA", securityType: "EQ" },
                        quantity: 100,
                        pricePaid: 120.0,
                        marketValue: 14500.0,
                        totalGain: 2500.0,
                        totalGainPct: 20.83,
                      },
                    ],
                  },
                ],
              },
            }),
            { status: 200 }
          )
        );

      const etrade = new ETradeService(env, undefined, userLogin);
      // Pass literal template placeholder "{accountIdKey}" to test that it is sanitized & discovered dynamically
      const portfolio = await etrade.fetchPortfolioRemote("{accountIdKey}");

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Verify call 1: List Accounts
      const [listUrl] = fetchSpy.mock.calls[0];
      expect(listUrl).toBe("https://apisb.etrade.com/v1/accounts/list.json");

      // Verify call 2: Portfolio uses the discovered REAL_KEY_ABC777, NEVER literal "{accountIdKey}"
      const [portfolioUrl] = fetchSpy.mock.calls[1];
      expect(portfolioUrl).toBe("https://apisb.etrade.com/v1/accounts/REAL_KEY_ABC777/portfolio.json");
      expect(portfolioUrl).not.toContain("{accountIdKey}");

      expect(portfolio.positions.length).toBe(1);
      expect(portfolio.positions[0].symbol).toBe("NVDA");
      expect(portfolio.positions[0].quantity).toBe(100);
      expect(portfolio.positions[0].marketValue).toBe(14500.0);
    });
  });
});
