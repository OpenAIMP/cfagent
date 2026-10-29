/**
 * Interaction consistency (#2283, epic #2150 slice 5): no native
 * alert() dialogs in client code. Transient feedback goes through the
 * global Toast primitive — an alert() blocks the whole tab, cannot be
 * styled, and traps keyboard users in a browser dialog.
 *
 * Same scan discipline as the confirm pin: comments stripped, only the
 * call form `alert(` at a word boundary matches.
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

/**
 * Drop string-literal contents (prose like "broker alert(s)" or
 * "drawdown alert (%)" is not a call). Template interpolations
 * ${...} are code, so their contents are kept.
 */
function stripStringContents(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      i++;
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          // Interpolation: keep the code, skip only the delimiters.
          let depth = 1;
          i += 2;
          while (i < text.length && depth > 0) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") depth--;
            if (depth > 0) out += text[i];
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

describe("no native alert dialogs in client code (#2283)", () => {
  it("has zero alert( calls in src/client", () => {
    const offenders: string[] = [];
    for (const file of walk(CLIENT_DIR)) {
      const clean = stripStringContents(stripComments(readFileSync(file, "utf8")));
      const matches = clean.match(/(?<![A-Za-z0-9_])alert\s*\(/g);
      if (matches) offenders.push(`${file}: ${matches.length} call(s)`);
    }
    expect(offenders).toEqual([]);
  });
});
