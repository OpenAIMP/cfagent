#!/usr/bin/env python3
"""Policy Gate for cfagent (issue #1487, #1684).

Evaluates GitOps compliance:
(a) Linked issue reference
(b) Lane label (lane:*)
(c) Agent hashtag (#<agent>-<id>)
(d) CHANGELOG entry under ## [Unreleased], or a changelog.d fragment
    (issue #1801: fragments end the prepend race — a PR adds one file
    under changelog.d/ and never touches CHANGELOG.md)
(e) Docs scope guard (docs PR cannot touch src/ or tests/)
(f) Stale base reversion guard (cannot delete files added to main since branching)
(g) Test deletion guard (cannot delete tests without allow-test-deletion label)
(h) Process documentation line (gitops §23: PR body must carry the §9
    "Process documentation impact:" checklist line — presence only,
    never a judgment of the decision's quality)
"""

import argparse
import os
import re
import subprocess
import sys
from typing import List, Optional, Set


def unreleased_section(text_content: str) -> List[str]:
    """Extract non-empty lines under the ## [Unreleased] section."""
    lines = text_content.splitlines()
    section = []
    in_section = False
    for line in lines:
        if line.startswith("## [Unreleased]"):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if in_section:
            section.append(line)
    return section


def evaluate_policy(
    base: str = "origin/main",
    head: str = "HEAD",
    title: str = "",
    body: str = "",
    labels: Optional[List[str]] = None,
    diff_only: bool = False,
) -> List[str]:
    """Run all policy gate evaluations and return any failure reasons."""
    labels = labels or []

    # Extract git commit messages as fallback context for issue, lane, and agent hashtag
    commit_context = ""
    try:
        commit_context = subprocess.run(
            ["git", "log", "--format=%s%n%b", f"{base}..{head}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout
    except Exception:
        pass

    text = body + "\n" + title + "\n" + commit_context
    full_body = body + "\n" + commit_context
    failures: List[str] = []

    if not diff_only:
        # (a) Linked issue
        if not re.search(r"(?i)\b(fixes|closes|resolves)\s+#\d+", text) and not re.search(
            r"OpenAIMP/cfagent#\d+", text
        ):
            failures.append(
                "(a) linked issue: PR body/title has no "
                "'Fixes #N' / 'Closes #N' / 'Resolves #N' "
                "and no OpenAIMP/cfagent#N reference"
            )

        # (b) Lane label
        has_lane_label = any(label.startswith("lane:") for label in labels) or bool(
            re.search(r"lane:[a-zA-Z0-9_-]+", full_body)
        )
        has_agent_hashtag = bool(re.search(r"#[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+", full_body))
        if not (has_lane_label or has_agent_hashtag):
            failures.append(
                "(b) lane label: PR carries no 'lane:*' label "
                "and no valid '#<agent>-<id>' hashtag in body (see gitops §21)"
            )

        # (c) Agent hashtag
        if not re.search(r"#[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+", full_body):
            failures.append(
                "(c) agent hashtag: PR body has no '#<agent>-<id>' "
                "hashtag (see AGENTS.md hashtag rule)"
            )

        # (h) Process documentation line (gitops §23). Presence only:
        # the gate checks that the §9 checklist line exists in the PR
        # body, never whether the decision it points at was correctly
        # recorded. Checked against the PR body alone (not commit
        # messages), because §23 names the PR body as the pointer.
        if not re.search(r"(?i)process documentation impact\s*:", body):
            failures.append(
                "(h) process documentation: PR body has no "
                "'Process documentation impact:' checklist line "
                "(see gitops §9/§23)"
            )

    # (d) CHANGELOG entry under ## [Unreleased], or a changelog.d fragment.
    # Fragments (issue #1801) end the prepend race: a PR adds one file
    # under changelog.d/ and never touches CHANGELOG.md, so no two PRs
    # write the same file. A direct CHANGELOG entry still passes.
    try:
        base_changelog = subprocess.run(
            ["git", "show", f"{base}:CHANGELOG.md"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout
        with open("CHANGELOG.md", encoding="utf-8") as handle:
            head_changelog = handle.read()

        base_lines = {line for line in unreleased_section(base_changelog) if line.strip()}
        head_lines = unreleased_section(head_changelog)
        added_entry = any(
            line.strip() and line not in base_lines for line in head_lines
        )
        added_fragment = False
        if not added_entry:
            added_files = subprocess.run(
                ["git", "diff", "--name-only", "--diff-filter=A", f"{base}...{head}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
            for candidate in added_files:
                if not candidate.startswith("changelog.d/"):
                    continue
                try:
                    fragment_text = subprocess.run(
                        ["git", "show", f"{head}:{candidate}"],
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        check=True,
                    ).stdout
                except Exception:
                    continue
                first = next(
                    (line.strip() for line in fragment_text.splitlines() if line.strip()),
                    "",
                )
                non_empty = [line.strip() for line in fragment_text.splitlines() if line.strip()]
                has_bullet = len(non_empty) > 1
                if first.startswith("### ") and has_bullet:
                    added_fragment = True
                    break
        if not added_entry and not added_fragment:
            failures.append(
                "(d) CHANGELOG: PR adds no entry under ## [Unreleased] in CHANGELOG.md "
                "and no changelog.d fragment (an added fragment whose first "
                "non-empty line is a '### ' section header followed by at least "
                "one entry line)"
            )
    except Exception as e:
        failures.append(f"(d) CHANGELOG verification error: {e}")

    # (e) Docs scope guard: docs-only PR cannot touch src/ or tests/
    is_docs_pr = bool(
        re.search(r"^(docs(\([^\)]+\))?:|\[docs\])", title.strip(), re.IGNORECASE)
    )
    try:
        touched_files = subprocess.run(
            ["git", "diff", "--name-only", f"{base}...{head}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.splitlines()

        if is_docs_pr:
            disallowed_code_files = [
                f for f in touched_files if f.startswith("src/") or f.startswith("tests/")
            ]
            if disallowed_code_files:
                sample = ", ".join(disallowed_code_files[:5])
                suffix = "..." if len(disallowed_code_files) > 5 else ""
                failures.append(
                    f"(e) docs scope: PR is scoped as documentation ('{title[:30]}...') "
                    f"but touches {len(disallowed_code_files)} code/test file(s): {sample}{suffix}. "
                    "Code changes must not ride in docs PRs."
                )
    except Exception as e:
        failures.append(f"(e) docs scope verification error: {e}")

    deleted_files: set[str] = set()
    head_missing_files: set[str] = set()

    # (f) Stale base reversion guard: ensure branch does not delete files added to base
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", base, head],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.strip()

        # Files added to base (e.g. main) since the merge base
        main_added_files = set(
            subprocess.run(
                ["git", "diff", "--name-only", "--diff-filter=A", merge_base, base],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
        )

        # Files present in base but missing in head
        head_missing_files = set(
            subprocess.run(
                ["git", "diff", "--name-only", "--diff-filter=D", base, head],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
        )

        # Also collect files explicitly deleted in the PR branch relative to merge_base
        deleted_files = set(
            subprocess.run(
                ["git", "diff", "--name-only", "--diff-filter=D", f"{merge_base}...{head}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
        )

        reverted_main_additions = [f for f in head_missing_files if f in main_added_files]
        if reverted_main_additions:
            sample = ", ".join(reverted_main_additions[:5])
            suffix = "..." if len(reverted_main_additions) > 5 else ""
            failures.append(
                f"(f) stale base reversion: PR branch was cut from a stale base and "
                f"reverts/deletes {len(reverted_main_additions)} file(s) added to main since branching: {sample}{suffix}. "
                "Rebase cleanly onto fresh main before merging."
            )
    except Exception as e:
        failures.append(f"(f) stale base verification error: {e}")

    # (g) Test deletion guard: disallow deleting test files without explicit label
    try:
        deleted_tests = [
            f
            for f in (head_missing_files | deleted_files)
            if f.startswith("tests/") and (f.endswith(".ts") or f.endswith(".js") or f.endswith(".json"))
        ]
        if deleted_tests and "allow-test-deletion" not in labels:
            sample = ", ".join(deleted_tests[:5])
            suffix = "..." if len(deleted_tests) > 5 else ""
            failures.append(
                f"(g) test deletion: PR deletes {len(deleted_tests)} test file(s): {sample}{suffix}. "
                "Deleting test files requires the 'allow-test-deletion' label and explicit justification."
            )
    except Exception as e:
        failures.append(f"(g) test deletion verification error: {e}")

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate cfagent Policy Gate.")
    parser.add_argument("--base", default="origin/main", help="Base git ref to compare against")
    parser.add_argument("--head", default="HEAD", help="Head git ref to check")
    parser.add_argument(
        "--diff-only",
        action="store_true",
        help="Run only git diff checks (changelog, docs scope, stale base, test deletion)",
    )
    args = parser.parse_args()

    body = os.environ.get("PR_BODY") or ""
    title = os.environ.get("PR_TITLE") or ""
    labels = (os.environ.get("PR_LABELS") or "").split()

    failures = evaluate_policy(
        base=args.base,
        head=args.head,
        title=title,
        body=body,
        labels=labels,
        diff_only=args.diff_only,
    )

    if failures:
        print("Policy gate FAILED:")
        for failure in failures:
            print("  - " + failure)
        return 1

    print(
        "Policy gate passed: linked issue, lane label, agent hashtag, "
        "CHANGELOG [Unreleased] entry or changelog.d fragment, docs scope, "
        "non-regression guards, and process documentation line verified."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
