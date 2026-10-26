/**
 * PageShell contract (#1804 S1, issue #1808), DOM-free (no jsdom in the
 * node suite): title + scope note + sections, with loading winning over
 * error, error over empty, empty over children — all carried by ui/
 * primitives, never raw divs.
 */
import { describe, it, expect } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { PageShell, PageSection } from "../src/client/components/ui/PageShell";
import { Spinner } from "../src/client/components/ui/Spinner";
import { EmptyState } from "../src/client/components/ui/EmptyState";
import { Notice } from "../src/client/components/ui/Notice";

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return collectText(props.children);
  }
  return "";
}

function findByType(node: ReactNode, type: unknown): ReactNode | null {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (isValidElement(node)) {
    if (node.type === type) return node;
    const props = node.props as { children?: ReactNode };
    return findByType(props.children, type);
  }
  return null;
}

describe("PageShell", () => {
  it("renders title, scope note, and section children", () => {
    const tree = PageShell({
      title: "Social Posting",
      scopeNote: "Today's brief and approvals",
      children: PageSection({ title: "Pending", children: "approval cards" }),
    });
    const text = collectText(tree);
    expect(text).toContain("Social Posting");
    expect(text).toContain("Today's brief and approvals");
    expect(text).toContain("Pending");
    expect(text).toContain("approval cards");
  });

  it("loading shows a Spinner and hides children", () => {
    const tree = PageShell({ title: "T", loading: true, loadingLabel: "Waiting", children: "child" });
    expect(findByType(tree, Spinner)).not.toBeNull();
    expect(collectText(tree)).not.toContain("child");
  });

  it("error shows a danger Notice and hides children", () => {
    const tree = PageShell({ title: "T", error: "Feed failed", children: "child" });
    const notice = findByType(tree, Notice) as ReactNode;
    expect(notice).not.toBeNull();
    expect(collectText(notice)).toContain("Feed failed");
    expect(collectText(tree)).not.toContain("child");
  });

  it("empty shows an EmptyState and hides children", () => {
    const tree = PageShell({
      title: "T",
      empty: true,
      emptyTitle: "No posts yet",
      emptyDescription: "Nothing submitted",
      children: "child",
    });
    const empty = findByType(tree, EmptyState) as ReactNode;
    expect(empty).not.toBeNull();
    const props = (empty as { props: { title: string; description?: string } }).props;
    expect(props.title).toBe("No posts yet");
    expect(props.description).toBe("Nothing submitted");
    expect(collectText(tree)).not.toContain("child");
  });

  it("loading wins over error and empty", () => {
    const tree = PageShell({ title: "T", loading: true, error: "boom", empty: true, children: "child" });
    expect(findByType(tree, Spinner)).not.toBeNull();
    expect(findByType(tree, Notice)).toBeNull();
    expect(findByType(tree, EmptyState)).toBeNull();
  });

  it("error wins over empty", () => {
    const tree = PageShell({ title: "T", error: "boom", empty: true, children: "child" });
    expect(findByType(tree, Notice)).not.toBeNull();
    expect(findByType(tree, EmptyState)).toBeNull();
  });

  it("PageSection renders its title, description, and children", () => {
    const tree = PageSection({ title: "Token health", description: "Per-channel status", children: "rows" });
    const text = collectText(tree);
    expect(text).toContain("Token health");
    expect(text).toContain("Per-channel status");
    expect(text).toContain("rows");
  });
});
