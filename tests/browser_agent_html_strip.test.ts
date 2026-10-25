import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { ETradeBrowserService, stripHtmlToText } from "../src/services/browserAgent";

/**
 * CodeQL self-heal batch (#850–#853):
 * - js/bad-tag-filter (#853): the old <script>/<style> strip regexes required
 *   a closing tag — an unterminated <script> leaked script text into the
 *   extracted page text.
 * - js/incomplete-multi-character-sanitization (#851, #852): the old chain
 *   never stripped HTML comments and cut tags at the first `>` even inside
 *   quoted attribute values.
 * - js/incomplete-multi-character-sanitization (#850): table cell cleaning
 *   used the same incomplete /<[^>]+>/ tag strip.
 *
 * stripHtmlToText is spec-aware: comments run to --> or end of input,
 * script/style elements run to their close tag or end of input, and tag
 * matching is quote-aware.
 */

function mockHtml(html: string) {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => html,
    json: async () => ({}),
  }) as any);
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("stripHtmlToText — spec-aware HTML stripping (#850-#853)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes well-formed script and style elements and their content", () => {
    const text = stripHtmlToText(
      `<html><head><script>alert("xss")</script><style>.a{color:red}</style></head>` +
        `<body><p>Hello</p></body></html>`,
    );
    expect(text).toBe("Hello");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("drops an UNTERMINATED <script> element to end of input (#853)", () => {
    // Per the HTML spec <script> content runs to </script> OR end of input —
    // the old filter required the close tag and leaked the script text.
    const text = stripHtmlToText(`<p>Before</p><script>alert("leaked")`);
    expect(text).toBe("Before");
    expect(text).not.toContain("leaked");
  });

  it("drops an UNTERMINATED <style> element to end of input", () => {
    const text = stripHtmlToText(`<p>Before</p><style>.a{color:red}`);
    expect(text).toBe("Before");
    expect(text).not.toContain("color:red");
  });

  it("removes HTML comments, including unterminated ones (#851/#852)", () => {
    const text = stripHtmlToText(`<p>Keep</p><!-- hidden note --><p>me</p>`);
    expect(text).toBe("Keep me");
    const unterminated = stripHtmlToText(`<p>Keep</p><!-- oops, unterminated`);
    expect(unterminated).toBe("Keep");
    expect(unterminated).not.toContain("oops");
  });

  it("is quote-aware: a > inside an attribute value does not end the tag (#851/#852)", () => {
    const text = stripHtmlToText(`<a href="https://example.com/?a=1>2">Link</a>`);
    expect(text).toBe("Link");
    expect(text).not.toContain("example.com");
  });

  it("handles script open tags with attributes", () => {
    const text = stripHtmlToText(
      `<script type="text/javascript" src="x.js">var a = 1;</script><p>After</p>`,
    );
    expect(text).toBe("After");
  });
});

describe("inspectPage fallback uses the spec-aware stripping (#851-#853)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("extracted text contains no script content, comments, or markup", async () => {
    mockHtml(
      `<html><head><title>T</title><script>evil()</script></head><body>` +
        `<!-- nav --><p>Price <b>131.20</b></p><script>more_evil(` +
        `</body></html>`,
    );
    const service = new ETradeBrowserService({} as any);
    const res = await service.inspectPage({ url: "https://example.com/quote/NVDA" });
    expect(res.success).toBe(true);
    expect(res.text).toContain("Price 131.20");
    expect(res.text).not.toContain("evil");
    expect(res.text).not.toContain("nav");
    expect(res.text).not.toMatch(/<[^>]+>/);
  });
});

describe("extractTablesFromHtml cell stripping (#850)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("extracts cell text with complete tag stripping", async () => {
    mockHtml(
      `<html><body><table>` +
        `<tr><td>Symbol</td><td><b>Price</b></td></tr>` +
        `<tr><td>NVDA</td><td>131.20 <!-- stale --></td></tr>` +
        `</table></body></html>`,
    );
    const service = new ETradeBrowserService({} as any);
    const res = await service.inspectPage({ url: "https://example.com/t" });
    expect(res.success).toBe(true);
    expect(res.tables).toEqual([
      ["Symbol | Price", "NVDA | 131.20"],
    ]);
  });

  it("handles an unterminated cell without leaking markup", async () => {
    mockHtml(
      `<html><body><table><tr><td>Only</tr></table></body></html>`,
    );
    const service = new ETradeBrowserService({} as any);
    const res = await service.inspectPage({ url: "https://example.com/t" });
    expect(res.success).toBe(true);
    expect(res.tables).toEqual([["Only"]]);
  });
});
