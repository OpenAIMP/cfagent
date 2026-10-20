/**
 * The tag-release job used to push `v0.1.x` tags and stop there, so `/releases`
 * stayed empty while the curated changelog lived only in the file (issue #321
 * follow-up). These assertions pin the publication step: one GitHub Release per
 * deploy, the curated CHANGELOG section as its body with the generated commit
 * list underneath, a re-run leaving existing notes alone, and a loud failure
 * when the tag step did not hand over what the release needs.
 *
 * The body composition itself is pinned by tests/release_notes_script.test.ts;
 * this file only checks the workflow calls it in the right order with the right
 * inputs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf-8"
);

function job(start: string, end: string): string {
  const from = workflow.indexOf(start);
  const to = workflow.indexOf(end, from + start.length);
  expect(from, `missing job: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return workflow.slice(from, to);
}

describe("deploy.yml — GitHub Releases carry the curated changelog", () => {
  const tagRelease = job("\n  tag-release:", "\n  # ── Step 4:");
  const publish = tagRelease.slice(tagRelease.indexOf("Publish GitHub Release"));

  it("publishes a release right after the tag is pushed", () => {
    const tagAt = tagRelease.indexOf("Create release tag");
    const releaseAt = tagRelease.indexOf("Publish GitHub Release");
    expect(tagAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(tagAt);
    // The job had contents: write for the tag push; the release API needs it too.
    expect(tagRelease).toContain("contents: write");
  });

  it("hands the tag and the previous tag to the release step", () => {
    expect(tagRelease).toContain('echo "RELEASE_TAG=$TAG" >> "$GITHUB_ENV"');
    expect(tagRelease).toContain('echo "PREVIOUS_TAG=$LATEST" >> "$GITHUB_ENV"');
  });

  it("composes the body from CHANGELOG.md for this tag", () => {
    expect(publish).toContain("node scripts/ci/release-notes.mjs");
    expect(publish).toContain('--tag "$RELEASE_TAG"');
    expect(publish).toContain("--changelog CHANGELOG.md");
    expect(publish).toContain('--out "$notes"');
  });

  it("scopes the generated commit list to the previous tag", () => {
    expect(publish).toContain("releases/generate-notes");
    expect(publish).toContain('-f tag_name="$RELEASE_TAG"');
    expect(publish).toContain('-f previous_tag_name="$PREVIOUS_TAG"');
    // --generate-notes cannot be combined with --notes-file, so the commit
    // list has to come from the API; a regression to the old flag would drop
    // the curated section again.
    const createLine = publish
      .split("\n")
      .find((line) => line.includes("gh release create"));
    expect(createLine, "missing gh release create").toBeTruthy();
    expect(createLine).not.toContain("--generate-notes");
  });

  it("publishes once, after the curated body exists", () => {
    const composeAt = publish.indexOf("scripts/ci/release-notes.mjs");
    const createAt = publish.indexOf("gh release create");
    expect(composeAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(composeAt);
    expect(publish).toContain('--notes-file "$notes"');
    // No create-then-edit: a cancelled run between the two left a release
    // with no changelog on the Releases page.
    expect(publish).not.toContain("gh release edit");
  });

  it("is idempotent and fails loudly when the body could not be built", () => {
    expect(publish).toContain("gh release view");
    expect(publish).toContain("already exists");
    expect(publish).toContain("exit 0");
    expect(publish).toContain("::error title=Release not published::");
    // RELEASE_TAG missing, and a composed body that is empty: both abort.
    expect(publish.match(/exit 1/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("degrades to the curated notes when the commit list cannot be fetched", () => {
    // The release must not be blocked by a generate-notes API hiccup, and the
    // degradation must be visible in the run rather than silent.
    expect(publish).toContain("::warning title=Generated notes unavailable::");
    expect(publish).toContain(': > "$generated"');
  });

  it("keeps release publishing out of the code-deploy job", () => {
    const deploy = job("\n  deploy:", "\n  # ── Step 2b:");
    expect(deploy).not.toContain("gh release create");
    expect(deploy).not.toContain("release-notes.mjs");
  });
});
