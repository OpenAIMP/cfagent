/**
 * tests/release_notes_script.test.ts
 *
 * The Release body for a deploy is composed by scripts/ci/release-notes.mjs,
 * which deploy.yml's tag-release job calls between "ask GitHub for the commit
 * list" and "gh release create". These tests pin the parts that decide what a
 * reader actually sees on the Releases page:
 *
 *  - the section is chosen for *this* tag, with `[Unreleased]` as the honest
 *    fallback (release PRs move entries out; un-versioned work still describes
 *    the deploy);
 *  - the heading line, trailing rules and changelog link definitions never
 *    leak into the release;
 *  - curated entries sit above the generated commit list, not below it;
 *  - an absent section degrades to generated notes instead of failing a deploy
 *    that already shipped;
 *  - GitHub's 125k body limit is respected.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_BODY_CHARS,
  buildReleaseNotes,
  extractSection,
  normalizeVersion,
  parseArgs,
} from "../scripts/ci/release-notes.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "All notable changes are documented here.",
  "",
  "## Release discipline",
  "",
  "- Move `## [Unreleased]` entries into a versioned section before tagging.",
  "",
  "## [Unreleased]",
  "",
  "### Fixed",
  "",
  "- **Unreleased fix (#1):** the thing that is not versioned yet.",
  "",
  "## [0.2.0] - 2026-10-19",
  "",
  "### Added",
  "",
  "- **Versioned feature (#2):** what shipped in 0.2.0.",
  "",
  "### Security",
  "",
  "- **Scoped token (#3):** rotated on deploy.",
  "",
  "## [0.1.0] - 2026-10-18",
  "",
  "First tagged release.",
  "",
  "[0.1.0]: https://example.test/compare/v0.0.0...v0.1.0",
  "",
].join("\n");

describe("release-notes — version matching", () => {
  it("normalizes the tag prefix", () => {
    expect(normalizeVersion("v0.1.4")).toBe("0.1.4");
    expect(normalizeVersion("V0.1.4")).toBe("0.1.4");
    expect(normalizeVersion(" 0.1.4 ")).toBe("0.1.4");
    expect(normalizeVersion(undefined)).toBe("");
  });

  it("prefers the section for the exact tag over [Unreleased]", () => {
    const section = extractSection(CHANGELOG, "v0.2.0");
    expect(section?.source).toBe("version");
    expect(section?.version).toBe("0.2.0");
    expect(section?.body).toContain("Versioned feature (#2)");
    expect(section?.body).not.toContain("Unreleased fix");
  });

  it("matches with or without the v prefix, case-insensitively", () => {
    expect(extractSection(CHANGELOG, "0.2.0")?.version).toBe("0.2.0");
    expect(extractSection(CHANGELOG, "V0.2.0")?.version).toBe("0.2.0");
  });

  it("falls back to [Unreleased] for a tag with no versioned section", () => {
    const section = extractSection(CHANGELOG, "v0.3.0");
    expect(section?.source).toBe("unreleased");
    expect(section?.body).toContain("Unreleased fix (#1)");
  });

  it("returns null instead of inventing a section", () => {
    expect(extractSection("## [1.0.0] - 2026-01-01\n\n- one\n", "v2.0.0")).toBeNull();
    expect(extractSection("", "v0.1.0")).toBeNull();
  });

  it("does not treat prose headings as sections", () => {
    // `## Release discipline` must not be absorbed into [Unreleased]'s body.
    expect(extractSection(CHANGELOG, "v0.2.0")?.body).not.toContain("Move `## [Unreleased]`");
    expect(extractSection(CHANGELOG, "v0.3.0")?.body).not.toContain("Release discipline");
  });
});

describe("release-notes — section body shape", () => {
  it("drops the heading line and keeps the entry subheadings", () => {
    const body = extractSection(CHANGELOG, "v0.2.0")!.body;
    expect(body.startsWith("### Added")).toBe(true);
    expect(body).not.toContain("## [0.2.0]");
    expect(body).toContain("### Security");
    expect(body).toContain("**Scoped token (#3):**");
  });

  it("drops changelog link definitions and trailing rules", () => {
    const body = extractSection(CHANGELOG, "v0.1.0")!.body;
    expect(body).toBe("First tagged release.");
  });

  it("terminates the section at a well-formed HTML comment line", () => {
    const md = "## [Unreleased]\n\n- one\n\n<!-- markdownlint-disable -->\n\n- two\n";
    const body = extractSection(md, "v0.0.1")!.body;
    expect(body).toBe("- one");
  });

  it("terminates the section at an unterminated HTML comment line (#854)", () => {
    // Per the HTML spec `<!--` opens a comment that runs to `-->` or end of
    // input, so `<!-- oops` is still a comment line — the old `<!--.*-->`
    // tag filter missed it and leaked raw comment text into release notes.
    const md = "## [Unreleased]\n\n- one\n\n<!-- oops, unterminated\n\n- two\n";
    const body = extractSection(md, "v0.0.1")!.body;
    expect(body).toBe("- one");
    expect(body).not.toContain("unterminated");
  });

  it("does not terminate on a comment with trailing text", () => {
    // A line that is not *only* a comment keeps the old pass-through behavior.
    const md = "## [Unreleased]\n\n- one\n<!-- note --> keep me\n";
    const body = extractSection(md, "v0.0.1")!.body;
    expect(body).toContain("keep me");
  });

  it("normalizes CRLF changelogs", () => {
    const crlf = CHANGELOG.replace(/\n/g, "\r\n");
    const body = extractSection(crlf, "v0.2.0")!.body;
    expect(body).toContain("Versioned feature (#2)");
    expect(body).not.toContain("\r");
  });

  it("collapses blank-line runs and trims the edges", () => {
    const messy = "## [Unreleased]\n\n\n\n- one\n\n\n\n";
    expect(extractSection(messy, "v0.0.1")!.body).toBe("- one");
  });

  it("truncates an oversized section with a pointer to the file", () => {
    const huge = [
      "## [Unreleased]",
      "",
      ...Array.from({ length: 1500 }, (_, i) => `- **Entry ${i}:** ${"x".repeat(80)}`),
    ].join("\n");
    const section = extractSection(huge, "v0.1.0")!;
    expect(section.truncated).toBe(true);
    expect(section.body.length).toBeLessThan(70_000);
    expect(section.body).toContain("truncated");
    expect(section.body.endsWith("CHANGELOG.md._")).toBe(true);
  });
});

describe("release-notes — body composition", () => {
  const generated = "## What's Changed\n\n* Fix the thing by @someone in #1\n";

  it("puts the curated changelog above the generated commits", () => {
    const { body, curated, hasGenerated } = buildReleaseNotes({
      changelog: CHANGELOG,
      tag: "v0.2.0",
      generated,
      repo: "OpenAIMP/cfagent",
    });
    const curatedAt = body.indexOf("Versioned feature (#2)");
    const commitsAt = body.indexOf("### Commits");
    const whatChangedAt = body.indexOf("What's Changed");
    expect(curatedAt).toBeGreaterThan(-1);
    expect(commitsAt).toBeGreaterThan(curatedAt);
    expect(whatChangedAt).toBeGreaterThan(commitsAt);
    expect(curated?.source).toBe("version");
    expect(hasGenerated).toBe(true);
  });

  it("links the changelog at the released tag", () => {
    const { body } = buildReleaseNotes({
      changelog: CHANGELOG,
      tag: "v0.2.0",
      generated,
      repo: "OpenAIMP/cfagent",
    });
    expect(body).toContain("https://github.com/OpenAIMP/cfagent/blob/v0.2.0/CHANGELOG.md");
  });

  it("omits the commits section when the API returned nothing", () => {
    const { body, hasGenerated } = buildReleaseNotes({
      changelog: CHANGELOG,
      tag: "v0.2.0",
      generated: "\n  \n",
      repo: "OpenAIMP/cfagent",
    });
    expect(hasGenerated).toBe(false);
    expect(body).not.toContain("### Commits");
    expect(body).toContain("Versioned feature (#2)");
  });

  it("still publishes generated notes when the changelog has no section", () => {
    const { body, curated, hasGenerated } = buildReleaseNotes({
      changelog: "# Changelog\n\nNothing yet.\n",
      tag: "v0.9.9",
      generated,
      repo: "OpenAIMP/cfagent",
    });
    expect(curated).toBeNull();
    expect(hasGenerated).toBe(true);
    // No leading horizontal rule when there is nothing above the commits.
    expect(body.startsWith("### Commits")).toBe(true);
    expect(body).toContain("What's Changed");
  });

  it("does not emit a repository link without a repo slug", () => {
    const { body } = buildReleaseNotes({ changelog: CHANGELOG, tag: "v0.2.0", generated });
    expect(body).not.toContain("https://github.com//");
    expect(body).not.toContain("Curated changelog at this tag");
  });

  it("honors GitHub's body limit", () => {
    const { body } = buildReleaseNotes({
      changelog: CHANGELOG,
      tag: "v0.2.0",
      generated: "- a very long commit list entry\n".repeat(10_000),
      repo: "OpenAIMP/cfagent",
    });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 200);
    expect(body).toContain("Versioned feature (#2)");
  });
});

describe("release-notes — CLI arguments", () => {
  it("parses the flags the workflow passes", () => {
    expect(
      parseArgs([
        "--tag",
        "v0.1.4",
        "--changelog",
        "CHANGELOG.md",
        "--generated",
        "gen.md",
        "--repo",
        "OpenAIMP/cfagent",
        "--out",
        "notes.md",
      ])
    ).toEqual({
      tag: "v0.1.4",
      changelog: "CHANGELOG.md",
      generated: "gen.md",
      repo: "OpenAIMP/cfagent",
      out: "notes.md",
    });
  });

  it("rejects a missing tag, unknown flags, and flags without a value", () => {
    expect(() => parseArgs([])).toThrow(/--tag is required/);
    expect(() => parseArgs(["--tag"])).toThrow(/missing value/);
    expect(() => parseArgs(["--tag", "v0.1.0", "--notes", "x"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["v0.1.0"])).toThrow(/unexpected argument/);
  });
});
