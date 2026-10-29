/**
 * Interaction consistency (#2283, epic #2150 slice 5, stream 1):
 * no native confirm dialogs in client code. Destructive actions
 * confirm through the Modal primitive (or an inline two-step arm),
 * never through `window.confirm` / bare `confirm`, which cannot be
 * styled, cannot name what is at stake, and cannot be tested.
 *
 * The scan strips block and line comments AND string-literal contents
 * before matching, so prose mentioning confirm() does not trip it
 * (the alert pin needed the same treatment for "broker alert(s)").
 * Template-literal ${} interpolations are kept, since they are code.
 * It matches only the call form `confirm(` at a word boundary (so
 * `confirmOrder(` and `onConfirm(` do not match).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = join(__dirname, "..", "src", "client");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stripStringContents(text: string): string {
  // Replace each string literal with "" — but keep ${...} interpolation
  // code, which may itself contain calls. Handles ', ", and ` quotes.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote + quote;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
          // Keep interpolation code verbatim (it is executable code).
          let depth = 1;
          out += "${";
          i += 2;
          while (i < text.length && depth > 0) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") depth--;
            out += text[i];
            i++;
          }
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

describe("no native confirm dialogs in client code (#2283)", () => {
  it("has zero confirm( calls in src/client", () => {
    const offenders: string[] = [];
    for (const file of walk(CLIENT_DIR)) {
      const clean = stripStringContents(stripComments(readFileSync(file, "utf8")));
      const matches = clean.match(/(?<![A-Za-z0-9_])confirm\s*\(/g);
      if (matches) offenders.push(`${file}: ${matches.length} call(s)`);
    }
    expect(offenders).toEqual([]);
  });
});
