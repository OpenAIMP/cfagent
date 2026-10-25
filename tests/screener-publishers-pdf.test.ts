import { describe, it, expect, vi } from "vitest";
import { fetchScreenerPdf } from "../src/events/screenerPublishers";

/**
 * #333: fetchScreenerPdf must return a real PDF on a healthy path —
 * never null from a swallowed error.
 */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function makeDeps(agent: unknown) {
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () => agent,
  };
  return { env: { SCREENER_AGENT: ns }, userLogin: "tester" } as any;
}

describe("#333 fetchScreenerPdf", () => {
  it("returns the run PDF by key on a healthy path", async () => {
    const agent = {
      getPdfByKey: async (key: string) =>
        key === "screener:pdf:a.pdf" ? { bytes: PDF_BYTES, fileName: "a.pdf" } : null,
      getLatestPdf: async () => null,
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent), "screener:pdf:a.pdf");
    expect(pdf).not.toBeNull();
    expect(pdf!.fileName).toBe("a.pdf");
    expect(Array.from(pdf!.bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("returns null (never stale) when no key is given (#801)", async () => {
    const agent = {
      getPdfByKey: async () => null,
      getLatestPdf: async () => ({ bytes: PDF_BYTES, fileName: "latest.pdf" }),
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent));
    // Issue #801: must NOT fall back to latest — a missing key means no attachment,
    // not someone else's report.
    expect(pdf).toBeNull();
  });

  it("logs the error and returns null when pdfStatus is failed (#822)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = {
      getPdfByKey: async () => ({ bytes: PDF_BYTES, fileName: "should-not-fetch.pdf" }),
      getLatestPdf: async () => ({ bytes: PDF_BYTES, fileName: "latest.pdf" }),
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent), undefined, "failed", "PDF lib crashed");
    expect(pdf).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PDF generation failed")
    );
    errorSpy.mockRestore();
  });

  it("returns null (not throw) when the agent errors, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = {
      getPdfByKey: async () => {
        throw new Error("DO unreachable");
      },
      getLatestPdf: async () => null,
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent), "k");
    expect(pdf).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null with a warning when the binding is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pdf = await fetchScreenerPdf({ env: {}, userLogin: "t" } as any, "k");
    expect(pdf).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
