import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Issue #358 — manual options scans deliver to Slack over A2A.
 * These pin the contract the route relies on: nothing posts unless a
 * channel config exists, the two deliveries (text, PDF) are reported
 * independently, and a failure in one never hides the other.
 */
vi.mock("../src/services/cfpayA2A", () => ({
  getCfpayConfig: vi.fn(),
  cfpayPostToSlack: vi.fn(),
  cfpayPostFileToSlack: vi.fn(),
}));

vi.mock("../src/trading", () => ({
  generateOptionsPdf: vi.fn(),
  optionsPdfFileName: vi.fn(),
}));

import { getCfpayConfig, cfpayPostToSlack, cfpayPostFileToSlack } from "../src/services/cfpayA2A";
import { generateOptionsPdf, optionsPdfFileName } from "../src/trading";
import { deliverOptionsScanToSlack } from "../src/services/optionsSlackDelivery";
import type { Env } from "../src/types";

const env = { SCREENER_SLACK_CHANNEL: "C-SCREENER" } as unknown as Env;
const scanData = { matchedCount: 7 };
const slackPayload = { text: "Scan summary" };

describe("deliverOptionsScanToSlack (#358)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(cfpayPostToSlack).mockResolvedValue({ ok: true } as never);
    vi.mocked(cfpayPostFileToSlack).mockResolvedValue({ ok: true } as never);
    vi.mocked(generateOptionsPdf).mockResolvedValue(new Uint8Array([1, 2, 3]) as never);
    vi.mocked(optionsPdfFileName).mockReturnValue("scan.pdf");
  });

  it("skips delivery, with a reason, when cfpay is not configured", async () => {
    vi.mocked(getCfpayConfig).mockReturnValue(null as never);

    const out = await deliverOptionsScanToSlack(env, { slackPayload, scanData });

    expect(out.text).toBe(false);
    expect(out.pdf).toBe(false);
    expect(out.error).toMatch(/not configured/i);
    expect(cfpayPostToSlack).not.toHaveBeenCalled();
    expect(cfpayPostFileToSlack).not.toHaveBeenCalled();
  });

  it("posts the summary and the PDF, and reports both as delivered", async () => {
    vi.mocked(getCfpayConfig).mockReturnValue({ baseUrl: "https://cfpay.test" } as never);

    const out = await deliverOptionsScanToSlack(env, {
      slackPayload,
      scanData,
      slackChannel: "C-EXPLICIT",
      thesis: "bullish",
    });

    expect(out).toEqual({ text: true, pdf: true });
    expect(cfpayPostToSlack).toHaveBeenCalledWith(expect.anything(), "Scan summary", "C-EXPLICIT");

    const fileArgs = vi.mocked(cfpayPostFileToSlack).mock.calls[0][1];
    expect(fileArgs.channel).toBe("C-EXPLICIT");
    expect(fileArgs.filename).toBe("scan.pdf");
    // 3 bytes -> base64 "AQID"
    expect(fileArgs.contentB64).toBe("AQID");
  });

  it("falls back to the configured screener channel", async () => {
    vi.mocked(getCfpayConfig).mockReturnValue({ baseUrl: "https://cfpay.test" } as never);

    await deliverOptionsScanToSlack(env, { slackPayload, scanData });

    expect(cfpayPostToSlack).toHaveBeenCalledWith(expect.anything(), "Scan summary", "C-SCREENER");
    expect(vi.mocked(cfpayPostFileToSlack).mock.calls[0][1].channel).toBe("C-SCREENER");
  });

  it("reports a text failure but still attempts the PDF", async () => {
    vi.mocked(getCfpayConfig).mockReturnValue({ baseUrl: "https://cfpay.test" } as never);
    vi.mocked(cfpayPostToSlack).mockResolvedValue({ ok: false, error: "channel_not_found" } as never);

    const out = await deliverOptionsScanToSlack(env, { slackPayload, scanData });

    expect(out.text).toBe(false);
    expect(out.pdf).toBe(true);
    expect(out.error).toBe("channel_not_found");
  });

  it("reports a PDF failure without losing the delivered summary", async () => {
    vi.mocked(getCfpayConfig).mockReturnValue({ baseUrl: "https://cfpay.test" } as never);
    vi.mocked(generateOptionsPdf).mockRejectedValue(new Error("pdf boom") as never);

    const out = await deliverOptionsScanToSlack(env, { slackPayload, scanData });

    expect(out.text).toBe(true);
    expect(out.pdf).toBe(false);
    expect(out.error).toBe("pdf boom");
  });
});
