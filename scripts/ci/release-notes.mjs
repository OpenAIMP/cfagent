#!/usr/bin/env node
/**
 * Build the body of a GitHub Release from the curated CHANGELOG.md.
 *
 * `deploy.yml` tags every successful deploy (`v0.1.<patch>`, issue #321) and
 * publishes one Release per tag. Before this script the Release body was
 * generated commit titles only, with a link to CHANGELOG.md appended after the
 * fact — so `/releases` never showed what actually changed for a user, and the
 * curated entries (features, fixes, migrations, known limitations) stayed in
 * the repo. Generated notes cannot carry that text: `gh release create` refuses
 * `--generate-notes` together with `--notes`/`--notes-file`.
 *
 * So the workflow asks GitHub for the generated commit list, hands it here, and
 * this script puts the curated section on top of it:
 *
 *     <curated section for the tag, else [Unreleased]>
 *     ---
 *     ### Commits
 *     <generated commit list>
 *     <link to CHANGELOG.md at the tag>
 *
 * Everything is a pure function of the inputs so tests/release_notes_script.test.ts
 * can pin the section matching, the ordering, the honest empty case, and the
 * length cap without a network call.
 *
 * CLI:
 *   node scripts/ci/release-notes.mjs --tag v0.1.4
 *        [--changelog CHANGELOG.md] [--generated generated.md]
 *        [--repo owner/name] [--out notes.md]
 *
 * Exit codes: 0 whenever notes were produced (including "no curated section" —
 * a missing changelog entry must not block a deploy that already happened);
 * 2 on a usage error, so a broken invocation is visible instead of silent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** GitHub rejects release bodies over 125,000 characters; stay well clear. */
export const MAX_BODY_CHARS = 100_000;

/** A curated section larger than this is truncated with a pointer to the file. */
const MAX_CURATED_CHARS = 60_000;

const SECTION_HEADING = /^##\s+/;
const BRACKETED_HEADING = /^##\s+\[([^\]]+)\]/;
const LINK_REFERENCE = /^\[[^\]]+\]:\s+\S+/;
const TERMINATOR = /^\s*(?:---+|<!--.*-->)\s*$/;

/** `v0.1.4` / `V0.1.4` / ` 0.1.4 ` all normalize to `0.1.4`. */
export function normalizeVersion(tag) {
  return String(tag ?? "")
    .trim()
    .replace(/^v/i, "");
}

/** The bracketed version of a `## [...]` heading, or null for other `##` lines. */
function headingVersion(heading) {
  const match = BRACKETED_HEADING.exec(heading);
  return match ? normalizeVersion(match[1]) : null;
}

/**
 * Pull one `## [...]` section out of the changelog.
 *
 * Lookup order is exact tag version first, then `[Unreleased]` — that is how
 * this repo cuts releases: a release PR moves the `[Unreleased]` entries into
 * `## [X.Y.Z]`, and entries that have not been versioned yet are still the
 * ones describing the deploy that just happened.
 *
 * @returns {{version: string, source: "version"|"unreleased", body: string, truncated: boolean}|null}
 */
export function extractSection(markdown, tag) {
  const text = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    // Every `##` heading closes a section, bracketed or not: `## Release
    // discipline` and future prose headings must not leak into the entries.
    if (SECTION_HEADING.test(lines[i])) starts.push(i);
  }

  const wanted = normalizeVersion(tag).toLowerCase();
  const sections = starts
    .map((start, index) => ({
      start,
      end: index + 1 < starts.length ? starts[index + 1] : lines.length,
      version: headingVersion(lines[start]),
      rawVersion: BRACKETED_HEADING.exec(lines[start])?.[1].trim() ?? null,
    }))
    .filter((section) => section.version !== null);

  const picked =
    sections.find((section) => section.version.toLowerCase() === wanted) ??
    sections.find((section) => section.version.toLowerCase() === "unreleased") ??
    null;
  if (!picked) return null;

  const kept = [];
  for (let i = picked.start + 1; i < picked.end; i += 1) {
    const line = lines[i];
    // A trailing rule or HTML comment closes the entries; link-reference
    // definitions (`[0.1.0]: https://...`) belong to the file, not a release.
    if (TERMINATOR.test(line)) break;
    if (LINK_REFERENCE.test(line)) continue;
    kept.push(line.replace(/[ \t]+$/, ""));
  }

  let body = tidy(kept.join("\n"));
  let truncated = false;
  if (body.length > MAX_CURATED_CHARS) {
    const cut = body.lastIndexOf("\n", MAX_CURATED_CHARS);
    body = `${body.slice(0, cut > 0 ? cut : MAX_CURATED_CHARS).trimEnd()}\n\n_…truncated; the full entry list is in CHANGELOG.md._`;
    truncated = true;
  }

  return {
    version: picked.rawVersion,
    source: picked.version.toLowerCase() === "unreleased" ? "unreleased" : "version",
    body,
    truncated,
  };
}

/** Trim the edges, drop whitespace-only lines, and collapse blank-line runs. */
function tidy(body) {
  // A BOM from a Windows-authored `gh api > file` redirect would otherwise
  // become the first character of the release body.
  const lines = String(body)
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  const out = [];
  for (const line of lines) {
    if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
    out.push(line);
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Compose the release body: curated entries first (what a user reads), the
 * generated commit list second, and a link to the changelog at the tag last.
 *
 * @returns {{body: string, curated: object|null, hasGenerated: boolean}}
 */
export function buildReleaseNotes({ changelog, tag, generated = "", repo = "" } = {}) {
  const curated = extractSection(changelog, tag);
  const blocks = [];

  if (curated && curated.body) {
    blocks.push({ text: curated.body });
  }

  const commits = tidy(String(generated ?? "").replace(/\r\n?/g, "\n"));
  if (commits) {
    // The rule only appears between two blocks; a lone commit list must not
    // open the body with a horizontal line.
    blocks.push({ text: `### Commits\n\n${commits}`, rule: blocks.length > 0 });
  }

  const slug = String(repo ?? "").trim();
  if (slug) {
    blocks.push({ text: `Curated changelog at this tag: https://github.com/${slug}/blob/${tag}/CHANGELOG.md` });
  }

  let body = "";
  for (const block of blocks) {
    if (!body) {
      body = block.text;
    } else {
      body += `${block.rule ? "\n\n---\n\n" : "\n\n"}${block.text}`;
    }
  }
  if (body.length > MAX_BODY_CHARS) {
    const cut = body.lastIndexOf("\n", MAX_BODY_CHARS);
    body = `${body.slice(0, cut > 0 ? cut : MAX_BODY_CHARS).trimEnd()}\n\n_…truncated; see CHANGELOG.md for the full history._`;
  }

  return { body, curated, hasGenerated: commits.length > 0 };
}

/** Parse `--flag value` pairs; unknown flags are a usage error. */
export function parseArgs(argv) {
  const known = new Set(["tag", "changelog", "generated", "repo", "out"]);
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
    args[name] = value;
    i += 1;
  }
  if (!args.tag) throw new Error("--tag is required");
  return args;
}

function readIfPossible(path, label) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    // Notes must never be the reason a deploy that already shipped fails: a
    // missing file is reported and the body falls back to whatever is left.
    process.stderr.write(
      `::warning title=Release notes input missing::could not read ${label} at ${path}: ${error.message}\n`
    );
    return "";
  }
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`release-notes: ${error.message}\n`);
    return 2;
  }

  const changelog = readIfPossible(args.changelog ?? "CHANGELOG.md", "changelog");
  const generated = readIfPossible(args.generated, "generated notes");
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? "";

  const { body, curated, hasGenerated } = buildReleaseNotes({
    changelog,
    tag: args.tag,
    generated,
    repo,
  });

  if (!curated) {
    process.stderr.write(
      `::warning title=Curated changelog missing::no [${normalizeVersion(args.tag)}] or [Unreleased] section found in ${
        args.changelog ?? "CHANGELOG.md"
      }; the release will carry generated notes only\n`
    );
  } else if (curated.source === "unreleased") {
    process.stdout.write(
      `release-notes: no versioned section for ${args.tag}; using [Unreleased]\n`
    );
  }
  if (!hasGenerated) {
    process.stderr.write(
      "::warning title=Release notes without commit list::generated notes were empty\n"
    );
  }

  const out = body.endsWith("\n") ? body : `${body}\n`;
  if (args.out) {
    writeFileSync(args.out, out, "utf-8");
    process.stdout.write(
      `release-notes: wrote ${out.length} characters to ${args.out} (source: ${
        curated ? curated.source : "generated only"
      })\n`
    );
  } else {
    process.stdout.write(out);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
