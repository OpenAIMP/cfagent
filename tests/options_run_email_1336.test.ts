/**
 * Issue #1336 (job-truth program #1332): manual options runs send an
 * email with the PDF attached — the one delivery cell the manual
 * route lacked (Slack already sent inline; scheduled runs already
 * emailed via the direct path). The helper mirrors the scheduled
 * path exactly: cfpay first with attachments, local fallback, and
 * never throws — a failed email warns in the route, never fails
 * the run.
 */
import { describe, expect, it } from "vitest";
import {
  resolveOptionsRunEmailRecipient,
  sendOptionsRunEmail,
} from "../src/services/optionsRunEmail";
import { parseOptionsScreenRequest } from "../src/trading";

const pdf = { bytes: new Uint8Array([1, 2, 3]), fileName: "options.pdf" };
const xlsx = { bytes: new Uint8Array([4, 5]), fileName: "options.xlsx" };

describe("resolveOptionsRunEmailRecipient", () => {
  it("prefers the per-request address, then OPTIONS_EMAIL_TO, then SCREENER_EMAIL_TO", () => {
    expect(resolveOptionsRunEmailRecipient("req@x.com", { OPTIONS_EMAIL_TO: "opt@x.com", SCREENER_EMAIL_TO: "scr@x.com" })).toBe("req@x.com");
    expect(resolveOptionsRunEmailRecipient(undefined, { OPTIONS_EMAIL_TO: "opt@x.com", SCREENER_EMAIL_TO: "scr@x.com" })).toBe("opt@x.com");
    expect(resolveOptionsRunEmailRecipient(undefined, { SCREENER_EMAIL_TO: "scr@x.com" })).toBe("scr@x.com");
    expect(resolveOptionsRunEmailRecipient(undefined, {})).toBeUndefined();
  });
});

describe("sendOptionsRunEmail", () => {
  const base = {
    to: "ops@x.com",
    subject: "Options Contract Screen",
    textBody: "2 underlyings scanned",
    htmlBody: "2 underlyings scanned",
    pdf,
    xlsx,
  };

  it("uses cfpay with PDF + XLSX attachments and never calls local on success", async () => {
    const cfpayCalls: unknown[] = [];
    let localCalls = 0;
    const out = await sendOptionsRunEmail(
      {
        cfpay: { baseUrl: "https://pay.example", token: "tok" },
        sendCfpay: async (_c, a) => {
          cfpayCalls.push(a);
          return { ok: true };
        },
        sendCfpayWithAttachments: async (_c, a) => {
          cfpayCalls.push(a);
          return { ok: true };
        },
        sendLocal: async () => {
          localCalls++;
          return true;
        },
      },
      base,
    );
    expect(out).toEqual({ sent: true, via: "cfpay" });
    expect(cfpayCalls).toHaveLength(1);
    const call = cfpayCalls[0] as { attachments: Array<{ filename: string; contentType: string; contentB64: string }> };
    expect(call.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ["options.pdf", "application/pdf"],
      ["options.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]);
    expect(localCalls).toBe(0);
  });

  it("falls back to local when cfpay fails, and reports local on success", async () => {
    const localCalls: unknown[] = [];
    const out = await sendOptionsRunEmail(
      {
        cfpay: { baseUrl: "https://pay.example", token: "tok" },
        sendCfpay: async () => ({ ok: false, error: "boom" }),
        sendCfpayWithAttachments: async () => ({ ok: false, error: "boom" }),
        sendLocal: async (...a) => {
          localCalls.push(a);
          return true;
        },
      },
      base,
    );
    expect(out).toEqual({ sent: true, via: "local" });
    expect(localCalls).toHaveLength(1);
    const attachments = (localCalls[0] as unknown[])[4] as Array<{ fileName: string; contentType: string }>;
    expect(attachments.map((a) => a.fileName)).toEqual(["options.pdf", "options.xlsx"]);
  });

  it("uses the local sender directly without cfpay, and never throws when local fails", async () => {
    const out = await sendOptionsRunEmail(
      {
        cfpay: null,
        sendCfpay: async () => ({ ok: true }),
        sendCfpayWithAttachments: async () => ({ ok: true }),
        sendLocal: async () => false,
      },
      base,
    );
    expect(out.sent).toBe(false);
    expect(out.via).toBe("none");
  });
});

describe("parseOptionsScreenRequest emailTo", () => {
  it("passes an optional emailTo through and still rejects unknown fields", () => {
    const ok = parseOptionsScreenRequest({ underlyingSymbols: ["NVDA"], emailTo: "ops@x.com" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.emailTo).toBe("ops@x.com");
    const bad = parseOptionsScreenRequest({ underlyingSymbols: ["NVDA"], bogus: 1 });
    expect(bad.ok).toBe(false);
  });
});
