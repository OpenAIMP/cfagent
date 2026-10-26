#!/usr/bin/env node
/**
 * Fold changelog.d fragments into CHANGELOG.md at release time (issue #1801).
 *
 * PRs add one fragment file under `changelog.d/` and never touch
 * CHANGELOG.md, so rebase merges no longer collide on the shared file.
 * The release PR runs this script to move the `## [Unreleased]` entries
 * plus all fragments into a new versioned section, and deletes the
 * folded fragments so the next release cannot double-count them.
 *
 * The fold is deliberately a manual release-PR step, like the existing
 * "move Unreleased into a versioned section" discipline — the releaser
 * reviews the diff before committing it. Running it twice is safe: the
 * second run finds nothing to fold and writes nothing.
 *
 * Rules:
 * - Entry lines are `### <Section>` headers and `- ` bullets. Any other
 *   non-empty line in [Unreleased] (prose, link references) stays in
 *   [Unreleased]; it is file content, not an entry.
 * - Fragment bullets merge under the matching existing `### ` header;
 *   a fragment header with no existing match appends a new section.
 * - The new versioned section goes directly after `## [Unreleased]`,
 *   newest-first like the existing versioned sections.
 *
 * CLI:
 *   node scripts/ci/assemble-changelog.mjs --tag v0.1.4
 *        [--changelog CHANGELOG.md] [--fragments-dir changelog.d]
 *
 * Exit codes: 0 on success (including "nothing to fold"); 2 on a usage
 * error; 1 when the changelog cannot be read, has no [Unreleased]
 * section, or a folded fragment cannot be deleted (the changelog was
 * already written in that case — the leftover fragment is visible in
 * the release diff for the releaser to handle).
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizeVersion, readFragmentDir, renderFragments } from "./release-notes.mjs";

const UNRELEASED_HEADING = /^## \[Unreleased\]/;
const SECTION_HEADING = /^##\s+/;
const SUBSECTION_HEADING = /^###\s+(.+)$/;
const BULLET = /^- /;

/** Split a section body into entry blocks plus leftover (non-entry) lines. */
function parseBlocks(lines) {
  const blocks = [];
  const otherLines = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, "");
    if (line.trim() === "") continue;
    const sub = SUBSECTION_HEADING.exec(line);
    if (sub) {
      current = { header: sub[1].trim(), bullets: [] };
      blocks.push(current);
      continue;
    }
    if (BULLET.test(line)) {
      if (!current) {
        current = { header: null, bullets: [] };
        blocks.push(current);
      }
      current.bullets.push(line);
      continue;
    }
    otherLines.push(line);
  }
  return { blocks, otherLines };
}

/**
 * Parse a rendered fragment body into blocks. Unlike the [Unreleased]
 * body, a fragment file is entry-only content: every non-empty line
 * under a `### ` header is entry content (bullets by convention, prose
 * tolerated), so nothing a fragment contributed is lost in the fold.
 */
function parseFragmentBlocks(body) {
  const blocks = [];
  let current = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    if (line.trim() === "") continue;
    const sub = SUBSECTION_HEADING.exec(line);
    if (sub) {
      current = { header: sub[1].trim(), bullets: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.bullets.push(line);
  }
  return blocks;
}

function renderBlocks(blocks) {
  const parts = [];
  for (const block of blocks) {
    const lines = block.header ? [`### ${block.header}`, ""] : [];
    lines.push(...block.bullets);
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Fold [Unreleased] entries plus fragments into a new versioned section.
 *
 * @param {string} changelogText full CHANGELOG.md content
 * @param {{name: string, content: string}[]} fragments changelog.d entries
 * @param {string} version bracket content for the new section, e.g. "0.1.4"
 * @param {string|null} dateStr "YYYY-MM-DD" suffix, or null for no suffix
 * @returns {{changelog: string, folded: string[], versionedBody: string}}
 */
export function foldChangelog(changelogText, fragments, version, dateStr = null) {
  const text = String(changelogText ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const start = lines.findIndex((line) => UNRELEASED_HEADING.test(line));
  if (start === -1) {
    throw new Error("no ## [Unreleased] section in changelog");
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (SECTION_HEADING.test(lines[i])) {
      end = i;
      break;
    }
  }

  const { blocks, otherLines } = parseBlocks(lines.slice(start + 1, end));
  const fragmentBody = renderFragments(fragments);
  const fragmentBlocks = fragmentBody ? parseFragmentBlocks(fragmentBody) : [];
  for (const frag of fragmentBlocks) {
    const existing = blocks.find((block) => block.header === frag.header);
    if (existing) existing.bullets.push(...frag.bullets);
    else blocks.push(frag);
  }
  const versionedBody = renderBlocks(blocks);
  if (versionedBody === "") {
    return { changelog: text, folded: [], versionedBody: "" };
  }

  const heading = dateStr ? `## [${version}] - ${dateStr}` : `## [${version}]`;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const next = [...before, "## [Unreleased]"];
  if (otherLines.length > 0) next.push("", ...otherLines);
  next.push("", heading, "", ...versionedBody.split("\n"));
  if (after.length > 0) next.push("");
  next.push(...after);
  let out = next.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return {
    changelog: out,
    folded: [...(fragments ?? [])].map((f) => f.name).sort(),
    versionedBody,
  };
}

export function parseArgs(argv) {
  const known = new Set(["tag", "changelog", "fragments-dir"]);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (!known.has(name)) throw new Error(`unknown flag: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    args[name === "fragments-dir" ? "fragmentsDir" : name] = value;
    i += 1;
  }
  if (!args.tag) throw new Error("--tag is required");
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`assemble-changelog: ${error.message}\n`);
    return 2;
  }
  const changelogPath = args.changelog ?? "CHANGELOG.md";
  const fragmentsDir = args.fragmentsDir ?? "changelog.d";
  let changelogText;
  try {
    changelogText = readFileSync(changelogPath, "utf-8");
  } catch (error) {
    process.stderr.write(`assemble-changelog: could not read ${changelogPath}: ${error.message}\n`);
    return 1;
  }
  const { fragments, skipped } = readFragmentDir(fragmentsDir);
  for (const item of skipped) {
    process.stderr.write(
      `::warning title=Changelog fragment skipped::${item.name}: ${item.reason}\n`
    );
  }
  let result;
  try {
    result = foldChangelog(
      changelogText,
      fragments,
      normalizeVersion(args.tag),
      new Date().toISOString().slice(0, 10)
    );
  } catch (error) {
    process.stderr.write(`assemble-changelog: ${error.message}\n`);
    return 1;
  }
  if (result.folded.length === 0 && result.versionedBody === "") {
    process.stdout.write("assemble-changelog: nothing to fold\n");
    return 0;
  }
  writeFileSync(changelogPath, result.changelog, "utf-8");
  const failed = [];
  for (const name of result.folded) {
    try {
      unlinkSync(`${fragmentsDir}/${name}`);
    } catch (error) {
      failed.push(`${name}: ${error.message}`);
    }
  }
  if (failed.length > 0) {
    for (const failure of failed) {
      process.stderr.write(`assemble-changelog: could not delete folded fragment ${failure}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `assemble-changelog: folded ${result.folded.length} fragment(s) into ## [${normalizeVersion(args.tag)}]\n`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
