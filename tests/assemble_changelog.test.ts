/**
 * tests/assemble_changelog.test.ts
 *
 * The release PR folds changelog.d fragments into CHANGELOG.md with
 * scripts/ci/assemble-changelog.mjs (issue #1801). These tests pin the
 * fold contract:
 * - fragment bullets merge under the matching existing `### ` header and
 *   append new headers after the existing ones;
 * - non-entry lines in [Unreleased] (prose, link references) stay in
 *   [Unreleased]; only headers and bullets move;
 * - the new versioned section lands directly after [Unreleased], before
 *   older versioned sections;
 * - a fold with nothing to move writes nothing and deletes nothing;
 * - a missing [Unreleased] section, or a headerless fragment, fails
 *   loudly instead of publishing a half-folded changelog.
 */
import { describe, it, expect } from "vitest";
import { foldChangelog, parseArgs } from "../scripts/ci/assemble-changelog.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- **Unreleased feature (#1):** waiting for release.",
  "",
  "### Fixed",
  "",
  "- **Unreleased fix (#2):** waiting for release.",
  "",
  "## [0.2.0] - 2026-10-19",
  "",
  "- **Old feature (#0):** already shipped.",
  "",
].join("\n");

const FRAGMENTS = [
  { name: "9-added.md", content: "### Added\n\n- **Fragment feature (#9):** new work\n" },
  { name: "10-fixed.md", content: "### Fixed\n\n- **Fragment fix (#10):** new fix\n" },
  { name: "11-security.md", content: "### Security\n\n- **Fragment security (#11):** new note\n" },
];

describe("assemble-changelog — fold", () => {
  it("merges fragments under matching headers and appends new headers", () => {
    const { changelog, folded, versionedBody } = foldChangelog(CHANGELOG, FRAGMENTS, "0.3.0");
    expect(folded).toEqual(["10-fixed.md", "11-security.md", "9-added.md"]);
    expect(versionedBody).toContain("Unreleased feature (#1)");
    expect(versionedBody).toContain("Fragment feature (#9)");
    expect(versionedBody).toContain("Fragment fix (#10)");
    expect(versionedBody).toContain("### Security");
    expect(versionedBody).toContain("Fragment security (#11)");
    expect(changelog).toContain("## [0.3.0]");
    // The new section sits after [Unreleased] and before the older release.
    expect(changelog.indexOf("## [0.3.0]")).toBeLessThan(changelog.indexOf("## [0.2.0]"));
    expect(changelog.indexOf("## [Unreleased]")).toBeLessThan(changelog.indexOf("## [0.3.0]"));
    // Folded entries leave [Unreleased].
    const unreleased = changelog.split("## [0.3.0]")[0];
    expect(unreleased).not.toContain("Unreleased feature (#1)");
    expect(unreleased).not.toContain("Fragment feature (#9)");
  });

  it("keeps non-entry lines in [Unreleased]", () => {
    const withProse = CHANGELOG.replace(
      "- **Unreleased fix (#2):** waiting for release.",
      "- **Unreleased fix (#2):** waiting for release.\n\nSee the migration guide for details.\n\n[0.2.0]: https://example.test/compare"
    );
    const { changelog } = foldChangelog(withProse, [], "0.3.0");
    const unreleased = changelog.split("## [0.3.0]")[0];
    expect(unreleased).toContain("See the migration guide for details.");
    expect(unreleased).toContain("[0.2.0]: https://example.test/compare");
    expect(changelog).not.toContain("Unreleased fix (#2):** waiting for release.\n\nSee the migration");
  });

  it("moves only [Unreleased] entries when there are no fragments", () => {
    const { changelog, folded } = foldChangelog(CHANGELOG, [], "0.3.0");
    expect(folded).toEqual([]);
    expect(changelog).toContain("## [0.3.0]");
    expect(changelog).toContain("Unreleased feature (#1)");
  });

  it("writes nothing when there is nothing to fold", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0]\n\n- old\n";
    const { changelog, folded, versionedBody } = foldChangelog(empty, [], "0.3.0");
    expect(changelog).toBe(empty.replace(/\r\n?/g, "\n"));
    expect(folded).toEqual([]);
    expect(versionedBody).toBe("");
  });

  it("throws without an [Unreleased] section and on a headerless fragment", () => {
    expect(() => foldChangelog("# Changelog\n", [], "0.3.0")).toThrow(
      /no ## \[Unreleased\] section/
    );
    expect(() =>
      foldChangelog(CHANGELOG, [{ name: "bad.md", content: "- no header\n" }], "0.3.0")
    ).toThrow(/no '### ' section header/);
  });

  it("adds the date suffix only when a date is given", () => {
    const dated = foldChangelog(CHANGELOG, [], "0.3.0", "2026-10-26").changelog;
    expect(dated).toContain("## [0.3.0] - 2026-10-26");
    const plain = foldChangelog(CHANGELOG, [], "0.3.0").changelog;
    expect(plain).toContain("## [0.3.0]\n");
    expect(plain).not.toContain("2026-10-26");
  });

  it("parses the hyphenated fragments-dir flag", () => {
    expect(parseArgs(["--tag", "v0.3.0", "--fragments-dir", "changelog.d"])).toEqual({
      tag: "v0.3.0",
      fragmentsDir: "changelog.d",
    });
    expect(() => parseArgs([])).toThrow(/--tag is required/);
    expect(() => parseArgs(["--tag", "v0.3.0", "--bogus", "x"])).toThrow(/unknown flag/);
  });
});
