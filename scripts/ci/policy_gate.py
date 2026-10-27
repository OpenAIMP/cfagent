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
(g) superseded by (i) (owner direction 2026-10-27, issue #1894):
    no file may be deleted at all — see (i)
(i) No-deletion rule (owner direction 2026-10-27, issue #1894):
    any file deletion fails, with no label bypass. Retire by deprecating
    in place (see (j)), never by deleting. Pure renames pass.
(j) Deprecation completeness (owner direction 2026-10-27, issue #1894):
    a new deprecation marker in code must name what superseded it, e.g.
    'superseded by src/new_module.ts'. Deprecated code must not be used.
Head evaluation: a merge-commit HEAD (CI checkout default on
pull_request events) resolves to its second parent, the PR branch head,
so (d)/(e)/(f)/(i)/(j) evaluate the branch tree, not the merge tree.
Attribution: (a)/(b)/(c) read the PR body and labels ONLY — commit
messages are not fallback context.
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


def resolve_effective_head(head: str) -> str:
    """Resolve the tree the gate must evaluate.

    In CI, actions/checkout on pull_request events checks out the MERGE
    commit (the workflow passes no ref), and the gate runs with HEAD set
    to it. Evaluating the merge tree makes check (f) vacuous: the merge
    base of main and a merge commit is main itself, so no file ever
    counts as added-to-main-since-branching. A merge commit's second
    parent is the PR branch head — evaluate that instead. A
    single-parent head resolves to itself. Unresolvable heads fall back
    to the given ref rather than crashing the gate.
    """
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--verify", f"{head}^{{commit}}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.strip()
    except Exception:
        return head
    try:
        out = subprocess.run(
            ["git", "cat-file", "-p", sha],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout
        parents = [line.split()[1] for line in out.splitlines() if line.startswith("parent ")]
    except Exception:
        return head
    if len(parents) >= 2:
        return parents[1]
    return head


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
    # Evaluate the branch tree, not a merge-commit tree (see
    # resolve_effective_head). All diffs below use the resolved head.
    head = resolve_effective_head(head)

    # Attribution reads the PR body and labels ONLY (owner direction
    # 2026-10-27, issue #1894). Commit messages are NOT fallback context:
    # a bot must not satisfy (a)/(b)/(c) by pasting an issue ref or a
    # hashtag into a commit message while the PR body carries neither.
    text = body
    full_body = body
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

    # (i) No-deletion rule (owner direction 2026-10-27, issue #1894):
    # NO file may be deleted in a PR — any deletion fails, with no label
    # bypass. The allow-test-deletion label no longer permits deletions.
    # Retire by deprecating in place (see (j)): keep the file, mark it
    # deprecated with its superseding reference, and remove it from
    # exports/indexes instead of deleting it. Pure renames (git R
    # status) are moves, not deletions, and pass; a rename paired with
    # a rewrite that falls below rename similarity still reports as D
    # and fails — split it into a pure rename commit plus a
    # modification commit. If a listed file is one the branch simply
    # lacks because main moved, update the branch to current main.
    # Genuine exceptions (e.g. removing an accidentally committed
    # secret, legal takedown) are owner emergency exceptions: the gate
    # stays red and only an owner admin bypass with an exception record
    # merges.
    try:
        status_lines = subprocess.run(
            ["git", "diff", "--name-status", "-M", base, head],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.splitlines()
        deleted_all = [
            line.split("\t", 1)[1] for line in status_lines if line.startswith("D\t")
        ]
        if deleted_all:
            sample = ", ".join(sorted(deleted_all)[:5])
            suffix = "..." if len(deleted_all) > 5 else ""
            failures.append(
                f"(i) no deletion: PR deletes {len(deleted_all)} file(s): {sample}{suffix}. "
                "No file may be deleted — mark the code deprecated in place (see (j)) "
                "and remove it from exports/indexes instead. "
                "The 'allow-test-deletion' label no longer permits deletions. "
                "If a listed file is one the branch simply lacks because main moved, "
                "update the branch to current main."
            )
    except Exception as e:
        failures.append(f"(i) no-deletion verification error: {e}")

    # (j) Deprecation completeness (owner direction 2026-10-27, #1894):
    # Deprecated code must not be used, and a deprecation must name what
    # superseded it — e.g. 'superseded by src/new_module.ts'. Applies to
    # ADDED lines in code files only (src/, scripts/); tests, docs, and
    # prose are excluded because their comments routinely mention
    # already-deprecated APIs without declaring a new deprecation.
    # Lines negating deprecation ("not deprecated", "never deprecated")
    # are not markers. File-level: if a file's added lines contain any
    # marker but no superseding reference anywhere in that file's added
    # lines, the deprecation is incomplete.
    try:
        diff_text = subprocess.run(
            ["git", "diff", base, head],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout
        deprecation_re = re.compile(r"@deprecated|\bdeprecated\b", re.IGNORECASE)
        negation_re = re.compile(
            r"\b(not|never|isn'?t)\s+deprecated\b|not-deprecated", re.IGNORECASE
        )
        superseding_re = re.compile(
            r"superseded\s+by|superseded-by|replaced\s+by|in\s+favor\s+of|use\s+.+\s+instead",
            re.IGNORECASE,
        )
        current_path = None
        current_added: List[str] = []
        file_chunks = []

        def flush():
            if current_path is not None:
                file_chunks.append((current_path, list(current_added)))

        for line in diff_text.splitlines():
            if line.startswith("diff --git "):
                flush()
                current_path = None
                current_added = []
                continue
            if line.startswith("+++ "):
                target = line[4:].strip()
                if target.startswith("b/"):
                    target = target[2:]
                current_path = target
                continue
            if current_path is not None and line.startswith("+") and not line.startswith("+++"):
                current_added.append(line[1:])
        flush()
        for path, added in file_chunks:
            if not (path.startswith("src/") or path.startswith("scripts/")):
                continue
            if path.endswith(".md"):
                continue
            markers = [
                line.strip()
                for line in added
                if deprecation_re.search(line) and not negation_re.search(line)
            ]
            if markers and not any(superseding_re.search(line) for line in added):
                marker = markers[0][:100]
                failures.append(
                    f"(j) deprecation incomplete: {path} adds a deprecation marker "
                    f"({marker}) but no superseding reference in the same file's added lines. "
                    "Deprecated code must not be used — name what superseded it, "
                    "e.g. 'superseded by src/new_module.ts'."
                )
    except Exception as e:
        failures.append(f"(j) deprecation verification error: {e}")

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
        "non-regression guards, no deletions, deprecation completeness, "
        "and process documentation line verified."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
