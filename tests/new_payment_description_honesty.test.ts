/**
 * Issue #478 (follow-up to #175): the New Payment form in Chat.tsx
 * pre-filled its Purpose / Description field with the product text of
 * the orchestrator seed transaction that #175 deleted
 * ("500,000 AI Inference Token Credits") — both as the field's initial
 * value and as its placeholder example. The seed data is gone; its
 * marketing copy must not survive as a form default a user would send
 * as a real payment description without noticing.
 *
 * The description now starts EMPTY, with a neutral placeholder that
 * makes no product claim. These pins keep the seed product text out of
 * the whole src/client tree and keep the field's initial value empty,
 * while also pinning that the field itself still exists and stays
 * bound to its state (the fix is "no fabricated default", not
 * "remove the description field").
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Source pins read via cwd-relative paths (vitest runs at the repo
// root) — the pattern used by tests/did_proof_honesty.test.ts.
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// The deleted seed transaction's product text. Written here in
// fragments (the #151 convention) so no source file — this one
// included — carries the contiguous literal as a reusable default.
const SEED_PRODUCT_TEXT = ["500,000 AI", " Inference Token", " Credits"].join("");
const SEED_PRODUCT_NAME = ["AI", " Inference Token"].join("");

describe("#478 — new-payment description carries no seed product text", () => {
  it("no file under src/client contains the seed product text or product name", () => {
    const offenders: string[] = [];
    for (const path of walk("src/client")) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes(SEED_PRODUCT_TEXT) || text.includes(SEED_PRODUCT_NAME)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the description state initialises empty (no pre-filled value)", () => {
    const chat = src("client/Chat.tsx");
    expect(chat).toMatch(/const \[newPayDesc, setNewPayDesc\] = useState\(""\);/);
    expect(chat).not.toMatch(/\[newPayDesc, setNewPayDesc\] = useState\("[^"]+"\)/);
  });

  it("the description field still exists and stays bound to its state", () => {
    const chat = src("client/Chat.tsx");
    expect(chat).toContain("Purpose / Description");
    expect(chat).toMatch(/value=\{newPayDesc\}/);
    expect(chat).toMatch(/onChange=\{\(e\) => setNewPayDesc\(e\.target\.value\)\}/);
    // The submitted payment still sends the (user-typed) description.
    expect(chat).toMatch(/description: newPayDesc\.trim\(\)/);
  });

  it("the description placeholder is neutral copy, not a product claim", () => {
    const chat = src("client/Chat.tsx");
    // #1576 (E2) converted the field from a raw <input> to the TextInput
    // primitive; the pin asserts the placeholder property (present,
    // neutral, bound to state), not the element type, so it accepts
    // either form. The freeze test separately pins zero raw inputs in
    // Chat.tsx, so the primitive form is what CI enforces.
    const inputMatch = chat.match(
      /<label>Purpose \/ Description<\/label>\s*<(?:input|TextInput)[^>]*placeholder="([^"]*)"[^>]*value=\{newPayDesc\}/,
    );
    expect(inputMatch).not.toBeNull();
    const placeholder = inputMatch![1];
    expect(placeholder.length).toBeGreaterThan(0);
    expect(placeholder).not.toContain(SEED_PRODUCT_NAME);
    expect(placeholder).not.toMatch(/\d/); // no quantities, prices, or product claims
  });
});
