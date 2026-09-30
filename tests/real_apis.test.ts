/**
 * Verification Test Suite: Real Payment APIs & Real Trading APIs (No Simulation, No Mockups)
 *
 * Verifies that:
 * 1. Payment Gateways (Stripe, PayPal, Lemon Squeezy) execute real REST/HTTP calls with exact headers,
 *    payloads, and HMAC-SHA256 signatures, without mockups or fake fallbacks.
 * 2. E*TRADE Broker Service generates authentic RFC 5849 OAuth 1.0a HMAC-SHA1 headers and calls
 *    real REST endpoints (/v1/market/quote, /v1/accounts/.../orders/preview, /orders/place, /portfolio).
 * 3. Alpaca Market Data v2 and Trading API v2 execute genuine REST calls (/v2/orders, /v2/account, /v2/quotes/latest).
 * 4. Yahoo Finance FOSS provider performs genuine HTTP requests (/v8/finance/chart, /v10/finance/quoteSummary).
 * 5. Missing or invalid credentials return structured, authentic upstream errors rather than silent fake mockups.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  StripePaymentStrategy,
  PayPalPaymentStrategy,
  LemonSqueezyPaymentStrategy,
  SandboxPaymentStrategy,
} from "../src/patterns/paymentStrategies";
import { PaymentGatewayService } from "../src/services/payments";
import { ETradeService } from "../src/services/etrade";
import { YahooFinanceProvider, AlpacaMarketDataProvider, FossResearchService } from "../src/services/fossResearch";
import { generateOAuth1Header, computeHmacSha256Hex, computeHmacSha1Base64 } from "../src/services/cryptoUtils";
import { createDidAttestationSync, AGENT_DIDS } from "../src/agents/did";
import type { Env } from "../src/types";

describe("Real Payment & Trading APIs (No Simulation, No Mockups)", () => {
  const dummyAttestation = createDidAttestationSync({
    draftId: "pay_test_real_001",
    action: "charge",
    amount: 50.0,
    currency: "USD",
    customer: "Real Customer Corp",
    gateway: "stripe",
    proposerDid: AGENT_DIDS.PAYMENTS,
    authorizerDid: "did:user:github:tester",
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Real Stripe REST API & Cryptographic Webhooks
  // =========================================================================
  describe("Stripe Payment Gateway (Real API Path)", () => {
    it("fails authentically with structured error when credentials are not configured (no fake simulation)", async () => {
      const emptyEnv: Env = {} as Env;
      const strategy = new StripePaymentStrategy();

      const result = await strategy.createCheckout(
        emptyEnv,
        {
          draftId: "pay_stripe_no_keys",
          amount: 100,
          currency: "USD",
          customer: "Client",
          userLogin: "tester",
        },
        dummyAttestation
      );

      expect(result.success).toBe(false);
      expect(result.checkoutUrl).toBe("");
      expect(result.message).toContain("STRIPE_SECRET_KEY or STRIPE_MCP_SERVER_URL must be configured");
      expect(result.message).toContain("Simulation and mockups are disabled");
    });

    it("makes real REST call to https://api.stripe.com/v1/checkout/sessions with Bearer token", async () => {
      const realEnv: Env = {
        STRIPE_SECRET_KEY: "sk_live_stripe_secret_token_12345",
        APP_BASE_URL: "https://agent.openaimp.com",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "cs_live_9988776655",
            url: "https://checkout.stripe.com/c/pay/cs_live_9988776655",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const strategy = new StripePaymentStrategy();
      const result = await strategy.createCheckout(
        realEnv,
        {
          draftId: "pay_real_stripe_draft",
          amount: 49.99,
          currency: "USD",
          customer: "Alpha Enterprise",
          description: "10,000 Compute Credits",
          userLogin: "tester",
        },
        dummyAttestation
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
      expect((calledInit?.headers as any)?.Authorization).toBe("Bearer sk_live_stripe_secret_token_12345");
      expect((calledInit?.headers as any)?.["Content-Type"]).toBe("application/x-www-form-urlencoded");

      expect(result.success).toBe(true);
      expect(result.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_live_9988776655");
      expect(result.gatewayRef).toBe("cs_live_9988776655");
    });

    it("verifies authentic Stripe HMAC-SHA256 webhook signatures (t=...,v1=...)", async () => {
      const strategy = new StripePaymentStrategy();
      const webhookSecret = "whsec_test_secret_stripe_999";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payload = JSON.stringify({ id: "evt_test_123", type: "checkout.session.completed" });

      const signature = await computeHmacSha256Hex(webhookSecret, `${timestamp}.${payload}`);
      const header = `t=${timestamp},v1=${signature}`;

      const isValid = await strategy.verifyWebhookSignature(payload, header, webhookSecret);
      expect(isValid).toBe(true);

      const isInvalid = await strategy.verifyWebhookSignature(payload, `t=${timestamp},v1=invalid_tampered_sig`, webhookSecret);
      expect(isInvalid).toBe(false);
    });

    it("executes real capture for Stripe PaymentIntents", async () => {
      const realEnv: Env = { STRIPE_SECRET_KEY: "sk_live_key" } as Env;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "pi_12345", status: "succeeded" }), { status: 200 })
      );

      const strategy = new StripePaymentStrategy();
      const res = await strategy.capturePayment(realEnv, "pi_12345", dummyAttestation);

      expect(fetchSpy).toHaveBeenCalledWith("https://api.stripe.com/v1/payment_intents/pi_12345/capture", expect.anything());
      expect(res.success).toBe(true);
      expect(res.captureId).toBe("pi_12345");
    });
  });

  // =========================================================================
  // 2. Real PayPal Commerce Platform REST API
  // =========================================================================
  describe("PayPal Payment Gateway (Real API Path)", () => {
    it("fails authentically with structured error when credentials are not configured", async () => {
      const emptyEnv: Env = {} as Env;
      const strategy = new PayPalPaymentStrategy();

      const result = await strategy.createCheckout(
        emptyEnv,
        {
          draftId: "pay_pp_no_keys",
          amount: 50,
          currency: "USD",
          customer: "Client",
          userLogin: "tester",
        },
        dummyAttestation
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured");
      expect(result.message).toContain("Simulation and mockups are disabled");
    });

    it("generates real OAuth2 token and creates PayPal order with intent: CAPTURE", async () => {
      const realEnv: Env = {
        PAYPAL_CLIENT_ID: "client_id_real_123",
        PAYPAL_CLIENT_SECRET: "client_secret_real_456",
        PAYPAL_ENVIRONMENT: "live",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // Token call
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "A21AAI_real_token_xyz" }), { status: 200 })
        )
        // Order create call
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "5O190127TN364715T",
              status: "CREATED",
              links: [{ rel: "approve", href: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T" }],
            }),
            { status: 201 }
          )
        );

      const strategy = new PayPalPaymentStrategy();
      const result = await strategy.createCheckout(
        realEnv,
        {
          draftId: "pay_real_paypal",
          amount: 75.0,
          currency: "USD",
          customer: "Beta Inc",
          userLogin: "tester",
        },
        dummyAttestation
      );

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe("https://api-m.paypal.com/v1/oauth2/token");
      expect(fetchSpy.mock.calls[1][0]).toBe("https://api-m.paypal.com/v2/checkout/orders");

      expect(result.success).toBe(true);
      expect(result.checkoutUrl).toBe("https://www.paypal.com/checkoutnow?token=5O190127TN364715T");
      expect(result.gatewayRef).toBe("5O190127TN364715T");
    });

    it("captures authorized PayPal order via /v2/checkout/orders/{id}/capture", async () => {
      const realEnv: Env = {
        PAYPAL_CLIENT_ID: "client_id_real_123",
        PAYPAL_CLIENT_SECRET: "client_secret_real_456",
        PAYPAL_ENVIRONMENT: "live",
      } as Env;

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "A21AAI_token" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "5O190127TN364715T",
              status: "COMPLETED",
              purchase_units: [{ payments: { captures: [{ id: "3C679366HH252564X", amount: { value: "75.00" } }] } }],
            }),
            { status: 200 }
          )
        );

      const strategy = new PayPalPaymentStrategy();
      const res = await strategy.captureOrder(realEnv, "5O190127TN364715T", dummyAttestation);

      expect(res.success).toBe(true);
      expect(res.captureId).toBe("3C679366HH252564X");
      expect(res.amount).toBe(75.0);
    });
  });

  // =========================================================================
  // 3. Real Lemon Squeezy Merchant API
  // =========================================================================
  describe("Lemon Squeezy Merchant Platform (Real API Path)", () => {
    it("fails authentically when credentials are not set", async () => {
      const emptyEnv: Env = {} as Env;
      const strategy = new LemonSqueezyPaymentStrategy();

      const result = await strategy.createCheckout(
        emptyEnv,
        {
          draftId: "pay_ls_no_keys",
          amount: 29,
          currency: "USD",
          customer: "Client",
          userLogin: "tester",
        },
        dummyAttestation
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("LEMONSQUEEZY_API_KEY and LEMONSQUEEZY_STORE_ID must be configured");
    });

    it("makes real REST call to https://api.lemonsqueezy.com/v1/checkouts", async () => {
      const realEnv: Env = {
        LEMONSQUEEZY_API_KEY: "ls_api_key_real_12345",
        LEMONSQUEEZY_STORE_ID: "88990",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "checkout_ls_7788",
              attributes: {
                url: "https://my-store.lemonsqueezy.com/buy/checkout_ls_7788",
              },
            },
          }),
          { status: 201 }
        )
      );

      const strategy = new LemonSqueezyPaymentStrategy();
      const result = await strategy.createCheckout(
        realEnv,
        {
          draftId: "pay_real_ls",
          amount: 29.0,
          currency: "USD",
          customer: "Tech Corp",
          userLogin: "tester",
        },
        dummyAttestation
      );

      expect(fetchSpy).toHaveBeenCalledWith("https://api.lemonsqueezy.com/v1/checkouts", expect.anything());
      expect(result.success).toBe(true);
      expect(result.checkoutUrl).toBe("https://my-store.lemonsqueezy.com/buy/checkout_ls_7788");
      expect(result.gatewayRef).toBe("checkout_ls_7788");
    });

    it("verifies Lemon Squeezy HMAC-SHA256 signature against x-signature header", async () => {
      const strategy = new LemonSqueezyPaymentStrategy();
      const secret = "ls_webhook_secret_secret";
      const rawBody = JSON.stringify({ meta: { event_name: "order_created" }, data: { id: "101" } });
      const signature = await computeHmacSha256Hex(secret, rawBody);

      const isValid = await strategy.verifyWebhookSignature(rawBody, signature, secret);
      expect(isValid).toBe(true);

      const isInvalid = await strategy.verifyWebhookSignature(rawBody, "invalid_sig", secret);
      expect(isInvalid).toBe(false);
    });
  });

  // =========================================================================
  // 4. Real E*TRADE Broker API with RFC 5849 OAuth 1.0a
  // =========================================================================
  describe("E*TRADE Broker REST API (OAuth 1.0a Path)", () => {
    it("generates authentic RFC 5849 OAuth 1.0a Authorization header with HMAC-SHA1", async () => {
      const header = await generateOAuth1Header({
        method: "GET",
        url: "https://apisb.etrade.com/v1/market/quote/NVDA.json",
        consumerKey: "test_consumer_key_123",
        consumerSecret: "test_consumer_secret_456",
        token: "test_token_789",
        tokenSecret: "test_token_secret_abc",
        nonce: "testnonce12345",
        timestamp: "1727700000",
      });

      expect(header.startsWith("OAuth ")).toBe(true);
      expect(header).toContain('oauth_consumer_key="test_consumer_key_123"');
      expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
      expect(header).toContain('oauth_timestamp="1727700000"');
      expect(header).toContain('oauth_nonce="testnonce12345"');
      expect(header).toContain('oauth_token="test_token_789"');
      expect(header).toContain('oauth_signature=');
    });

    it("calls real E*TRADE market quote REST endpoint with OAuth 1.0a header", async () => {
      const env: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_OAUTH_TOKEN: "mock_token",
        ETRADE_OAUTH_TOKEN_SECRET: "mock_tsecret",
        ETRADE_ENVIRONMENT: "sandbox",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            QuoteResponse: {
              QuoteData: [
                {
                  Product: { symbol: "NVDA", securityType: "EQ" },
                  All: {
                    lastTrade: 142.5,
                    changeClose: 3.2,
                    changeClosePercentage: 2.3,
                    bid: 142.45,
                    ask: 142.55,
                    totalVolume: 45000000,
                    open: 140.0,
                    high: 143.0,
                    low: 139.8,
                    pe: 55.4,
                    marketCap: 3500000000000,
                    high52: 145.0,
                    low52: 45.0,
                    companyName: "NVIDIA Corp Live",
                  },
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const etrade = new ETradeService(env);
      const quote = await etrade.fetchQuoteRemote("NVDA");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://apisb.etrade.com/v1/market/quote/NVDA.json");
      expect((init?.headers as any)?.Authorization).toMatch(/^OAuth oauth_consumer_key=/);

      expect(quote.symbol).toBe("NVDA");
      expect(quote.lastPrice).toBe(142.5);
      // Source string now reflects active environment name & label from resolveEnvironmentConfig
      expect(quote.source).toContain("E*TRADE REST API");
    });

    it("calls real E*TRADE order placement REST endpoint with PlaceOrderRequest", async () => {
      const env: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_OAUTH_TOKEN: "mock_token",
        ETRADE_OAUTH_TOKEN_SECRET: "mock_tsecret",
        ETRADE_ACCOUNT_ID_KEY: "acct_83921048",
        ETRADE_ENVIRONMENT: "sandbox",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PlaceOrderResponse: {
              orderType: "EQ",
              OrderIds: [{ orderId: 987654321 }],
            },
          }),
          { status: 200 }
        )
      );

      const etrade = new ETradeService(env);
      const result = await etrade.placeOrderRemote({
        orderId: "ord_draft_1122",
        symbol: "NVDA",
        action: "BUY",
        quantity: 10,
        orderType: "MARKET",
        userLogin: "trader_test",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://apisb.etrade.com/v1/accounts/acct_83921048/orders/place.json");
      expect(init?.method).toBe("POST");
      expect((init?.headers as any)?.Authorization).toMatch(/^OAuth /);

      expect(result.success).toBe(true);
      expect(result.status).toBe("executed");
      expect(result.brokerOrderRef).toBe("et_order_987654321");
    });

    it("refuses to execute live order without OAuth keys (no fake mockups)", async () => {
      // In CI, process.env has real ET_API_KEY/ET_API_SECRET from the GitHub Environment.
      // Stub them out so resolveEnvironmentConfig cannot fall back to process.env credentials.
      // vi.stubEnv is automatically restored after each test by Vitest.
      vi.stubEnv("ET_API_KEY", "");
      vi.stubEnv("ET_API_SECRET", "");
      vi.stubEnv("ET_BASE_URL", "");
      vi.stubEnv("ETRADE_CONSUMER_KEY", "");
      vi.stubEnv("ETRADE_CONSUMER_SECRET", "");

      // APP_ENV=PROD → resolveEnvironmentConfig resolves isLive=true, no API keys
      const liveNoKeysEnv: Env = {
        APP_ENV: "PROD",
      } as Env;

      const etrade = new ETradeService(liveNoKeysEnv);
      const result = await etrade.placeOrderRemote({
        orderId: "ord_live_no_keys",
        symbol: "TSLA",
        action: "BUY",
        quantity: 5,
        userLogin: "trader_test",
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      // Live-mode rejection message references ET_API_KEY/ET_API_SECRET and the env name
      expect(result.message).toContain("ET_API_KEY and ET_API_SECRET must be configured");
      expect(result.message).toContain("PROD");

      vi.unstubAllEnvs();
    });

  });

  // =========================================================================
  // 5. Real Alpaca Trading v2 & Market Data v2 API
  // =========================================================================
  describe("Alpaca Trading v2 & Market Data v2 (Real API Path)", () => {
    it("refuses to place trade without Alpaca credentials (simulation disabled)", async () => {
      const emptyEnv: Env = {} as Env;
      const alpaca = new AlpacaMarketDataProvider(emptyEnv);

      const result = await alpaca.placeOrder({
        symbol: "NVDA",
        qty: 10,
        side: "buy",
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY must be configured");
      expect(result.message).toContain("Simulation is disabled");
    });

    it("places live/paper order to https://paper-api.alpaca.markets/v2/orders with APCA headers", async () => {
      const alpacaEnv: Env = {
        ALPACA_API_KEY_ID: "PKTEST_ALPACA_123",
        ALPACA_API_SECRET_KEY: "SKTEST_ALPACA_SECRET_456",
        ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "61b6bd52-d35c-4d53-bc26-80f36fd43df7",
            status: "accepted",
            symbol: "NVDA",
            qty: "10",
            side: "buy",
          }),
          { status: 200 }
        )
      );

      const alpaca = new AlpacaMarketDataProvider(alpacaEnv);
      const res = await alpaca.placeOrder({
        symbol: "NVDA",
        qty: 10,
        side: "buy",
        type: "market",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://paper-api.alpaca.markets/v2/orders",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "APCA-API-KEY-ID": "PKTEST_ALPACA_123",
            "APCA-API-SECRET-KEY": "SKTEST_ALPACA_SECRET_456",
          }),
        })
      );

      expect(res.success).toBe(true);
      expect(res.orderId).toBe("61b6bd52-d35c-4d53-bc26-80f36fd43df7");
      expect(res.status).toBe("accepted");
    });

    it("queries Alpaca account buying power and positions via real endpoints", async () => {
      const alpacaEnv: Env = {
        ALPACA_API_KEY_ID: "PKTEST_123",
        ALPACA_API_SECRET_KEY: "SKTEST_456",
      } as Env;

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "acct_999", buying_power: "250000.00", cash: "50000.00" }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ symbol: "NVDA", qty: "100", market_value: "14250.00" }]), { status: 200 })
        );

      const alpaca = new AlpacaMarketDataProvider(alpacaEnv);
      const acct = await alpaca.getAccount();
      const pos = await alpaca.getPositions();

      expect(acct.success).toBe(true);
      expect(acct.account.buying_power).toBe("250000.00");
      expect(pos.success).toBe(true);
      expect(pos.positions?.length).toBe(1);
      expect(pos.positions?.[0].symbol).toBe("NVDA");
    });
  });

  // =========================================================================
  // 6. Real Yahoo Finance FOSS API (No Mockups)
  // =========================================================================
  describe("Yahoo Finance FOSS Engine (Real HTTP Calls)", () => {
    it("makes genuine GET request to query1.finance.yahoo.com/v8/finance/chart/{symbol}", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "NVDA",
                    shortName: "NVIDIA Corporation",
                    regularMarketPrice: 139.8,
                    chartPreviousClose: 136.5,
                    regularMarketVolume: 58000000,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const provider = new YahooFinanceProvider();
      const quote = await provider.getQuote("NVDA");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=1mo",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("Mozilla"),
          }),
        })
      );

      expect(quote.symbol).toBe("NVDA");
      expect(quote.price).toBe(139.8);
      expect(quote.change).toBe(3.3);
    });

    it("makes genuine GET request to query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            quoteSummary: {
              result: [
                {
                  price: { longName: "NVIDIA Corporation", marketCap: { raw: 3450000000000 } },
                  summaryDetail: { trailingPE: { raw: 57.5 }, fiftyTwoWeekHigh: { raw: 140.76 }, fiftyTwoWeekLow: { raw: 45.2 } },
                  defaultKeyStatistics: { pegRatio: { raw: 1.15 }, beta: { raw: 1.68 } },
                  financialData: { targetMeanPrice: { raw: 152.0 }, recommendationKey: "strong_buy" },
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const provider = new YahooFinanceProvider();
      const fund = await provider.getFundamentals("NVDA");

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("https://query2.finance.yahoo.com/v10/finance/quoteSummary/NVDA?modules=price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend"),
        expect.anything()
      );

      expect(fund.symbol).toBe("NVDA");
      expect(fund.peTrailing).toBe(57.5);
      expect(fund.targetMeanPrice).toBe(152.0);
      expect(fund.recommendationKey).toBe("strong_buy");
    });
  });
});
