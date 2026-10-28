/** @vitest-environment jsdom */
/**
 * Issue #1382: Social posting UI — brief editor, manual trigger, status readout.
 *
 * Harness follows the established panel tests (agentic_wallet_panel.test.tsx):
 * the REAL socialPostingApi module is driven against a stubbed global fetch,
 * and the component renders with react-dom/client in jsdom.
 *
 * Honesty pins (issue #1382 scope):
 *  - the brief editor stores only what the user types, never invented
 *    content: with no stored brief the editor starts empty;
 *  - NO enable/disable control for the goal exists anywhere in the panel:
 *    the enabled state is a read-only readout, and a manual trigger never
 *    enables the goal (the goals re-read after a trigger still says
 *    DISABLED);
 *  - token validity "unknown" is shown as unknown, never upgraded;
 *  - a failed load renders an error state instead of invented data.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SocialPostingPanel } from "../src/client/SocialPostingPanel";
import {
  SOCIAL_BRIEF_MAX_CHARS,
  getBrief,
  getTokenHealth,
  listPendingApprovals,
  saveBrief,
  listPosts,
} from "../src/client/socialPostingApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GOAL = {
  id: "daily-social-post",
  name: "Daily social post",
  cron: "0 9 * * 1-5",
  operation: "social.publish",
  budgetCents: 1,
  enabled: false,
};

const TOKEN_CHANNELS = {
  threads: {
    channel: "threads",
    tokenEnvVar: "THREADS_ACCESS_TOKEN",
    presence: "configured",
    validity: "unknown",
    validated: false,
    validationEndpoint: "https://graph.threads.net/v1.0/me",
    validationEndpointConfirmed: true,
  },
  x: {
    channel: "x",
    tokenEnvVar: "X_ACCESS_TOKEN",
    presence: "unconfigured",
    validity: "unknown",
    validated: false,
    validationEndpoint: null,
    validationEndpointConfirmed: false,
  },
  facebook: {
    channel: "facebook",
    tokenEnvVar: "FACEBOOK_PAGE_ACCESS_TOKEN",
    presence: "unconfigured",
    validity: "unknown",
    validated: false,
    validationEndpoint: "https://graph.facebook.com/v21.0/me",
    validationEndpointConfirmed: true,
  },
  instagram: {
    channel: "instagram",
    tokenEnvVar: "INSTAGRAM_ACCESS_TOKEN",
    presence: "unconfigured",
    validity: "unknown",
    validated: false,
    validationEndpoint: "https://graph.instagram.com/v21.0/me",
    validationEndpointConfirmed: true,
  },
  linkedin: {
    channel: "linkedin",
    tokenEnvVar: "LINKEDIN_ACCESS_TOKEN",
    accountEnvVar: "LINKEDIN_AUTHOR_URN",
    presence: "unconfigured",
    accountPresence: "unconfigured",
    validity: "unknown",
    validated: false,
    validationEndpoint: "https://api.linkedin.com/v2/me",
    validationEndpointConfirmed: true,
  },
};

const APPROVAL = {
  date: "2026-10-24",
  channel: "facebook",
  draftId: "draft-1",
  requestedAtMs: 1792849200000,
  text: "Pending approval draft",
  status: "approved",
};

interface FetchCall {
  method: string;
  url: string;
  body?: unknown;
}

interface StubState {
  brief?: string | null;
  briefStatus?: number;
  approvals?: unknown[];
  goals?: unknown[];
  tokenChannels?: unknown;
  posts?: unknown[];
  failAll?: boolean;
}

function installFetch(state: StubState, calls: FetchCall[]) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });
    if (state.failAll) {
      return Response.json({ error: "Store unavailable." }, { status: 500 });
    }
    if (url.startsWith("/api/social/posts")) {
      return Response.json({
        ok: true,
        date: "2026-10-24",
        posts: state.posts ?? [
          {
            channel: "threads",
            draftId: "draft-threads-1",
            date: "2026-10-24",
            status: "posted",
            text: "Hello Threads post",
            platformPostId: "th_post_12345",
            submissionEndpoint: "https://graph.threads.net/v1.0/me/threads_publish",
            postUrl: "https://www.threads.net/t/th_post_12345",
            createdAtMs: 1792849200000,
          },
        ],
      });
    }
    if (url.startsWith("/api/social/brief")) {
      if (method === "POST") return Response.json({ ok: true, date: "2026-10-24" });
      return Response.json(
        { ok: true, date: "2026-10-24", brief: state.brief ?? null },
        { status: state.briefStatus ?? 200 },
      );
    }
    if (url.startsWith("/api/social/approvals")) {
      return Response.json({ ok: true, date: "2026-10-24", approvals: state.approvals ?? [] });
    }
    if (url.startsWith("/api/social/token-health")) {
      return Response.json({
        ok: true,
        channels: state.tokenChannels ?? Object.values(TOKEN_CHANNELS),
      });
    }
    if (url.startsWith("/api/schedule/goals")) {
      if (url.endsWith("/trigger") && method === "POST") {
        return Response.json({
          ok: true,
          tick: {
            timestamp: "2026-10-24T14:00:00.000Z",
            goalsEvaluated: 1,
            jobsCreated: 1,
            jobsSkipped: 0,
            errors: [],
          },
        });
      }
      return Response.json({ ok: true, goals: state.goals ?? [GOAL] });
    }
    return Response.json({ error: "Unexpected route." }, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SocialPostingPanel />);
  });
  await flush();
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(button: HTMLButtonElement) {
  act(() => {
    button.click();
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`No button containing "${text}"`);
  return found;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // #2149: sections are URL-synced tabs (?view=); reset the URL so each
  // test starts on the default Brief tab instead of inheriting a prior
  // test's visited tab.
  window.history.pushState(null, "", "/");
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  vi.unstubAllGlobals();
});

describe("socialPostingApi request shapes", () => {
  it("getBrief requests the brief for the given date", async () => {
    const calls: FetchCall[] = [];
    installFetch({ brief: "Hello" }, calls);
    const result = await getBrief("2026-10-24");
    expect(result.brief).toBe("Hello");
    expect(calls).toEqual([{ method: "GET", url: "/api/social/brief?date=2026-10-24", body: undefined }]);
  });

  it("saveBrief posts the exact text and date as JSON", async () => {
    const calls: FetchCall[] = [];
    installFetch({}, calls);
    const result = await saveBrief("Hello Threads", "2026-10-24");
    expect(result.date).toBe("2026-10-24");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/social/brief");
    expect(calls[0].body).toEqual({ text: "Hello Threads", date: "2026-10-24" });
  });

  it("saveBrief refuses empty text and over-cap text without fetching", () => {
    const calls: FetchCall[] = [];
    installFetch({}, calls);
    // saveBrief validates synchronously, before any fetch is issued.
    expect(() => saveBrief("   ", "2026-10-24")).toThrow();
    expect(() => saveBrief("x".repeat(SOCIAL_BRIEF_MAX_CHARS + 1), "2026-10-24")).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("listPendingApprovals and getTokenHealth hit their routes", async () => {
    const calls: FetchCall[] = [];
    installFetch({ approvals: [APPROVAL] }, calls);
    const approvals = await listPendingApprovals("2026-10-24");
    expect(approvals.approvals).toHaveLength(1);
    const health = await getTokenHealth();
    expect(health.channels.threads.presence).toBe("configured");
    expect(health.rawChannels).toHaveLength(5);
    expect(calls.map((c) => c.url)).toContain("/api/social/approvals?date=2026-10-24");
    expect(calls.map((c) => c.url)).toContain("/api/social/token-health");
  });
});

describe("SocialPostingPanel", () => {
  it("renders the stored brief, the goal state, token presence, and pending approvals", async () => {
    const calls: FetchCall[] = [];
    installFetch({ brief: "Stored brief text", approvals: [APPROVAL] }, calls);
    await renderPanel();
    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe("Stored brief text");
    // #2149: goal, token, and approval content live behind tabs — navigate
    // to each before asserting (visited panels stay mounted, so later
    // assertions still see earlier tabs' content).
    clickButton(buttonByText("Goals"));
    expect(container.textContent).toContain("Daily social post");
    expect(container.textContent).toContain("DISABLED");
    clickButton(buttonByText("Token health"));
    // Verify all 5 channels render when server returns array format (#1391)
    expect(container.textContent).toContain("Threads — Configured · validity Unknown");
    expect(container.textContent).toContain("X — Not configured · validity Unknown");
    expect(container.textContent).toContain("Facebook — Not configured · validity Unknown");
    expect(container.textContent).toContain("Instagram — Not configured · validity Unknown");
    expect(container.textContent).toContain("LinkedIn — Not configured · validity Unknown");
    clickButton(buttonByText("Approvals"));
    expect(container.textContent).toContain("Pending approval draft");
  });

  it("renders token health rows when server returns record format for backward compatibility", async () => {
    installFetch({ tokenChannels: TOKEN_CHANNELS }, []);
    await renderPanel();
    clickButton(buttonByText("Token health"));
    expect(container.textContent).toContain("Threads — Configured · validity Unknown");
    expect(container.textContent).toContain("X — Not configured · validity Unknown");
  });

  it("starts with an empty editor when no brief is stored — no invented content", async () => {
    installFetch({ brief: null, approvals: [] }, []);
    await renderPanel();
    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe("");
    expect(buttonByText("Save brief").disabled).toBe(true);
  });

  it("saves exactly the typed text and shows a saved confirmation", async () => {
    const calls: FetchCall[] = [];
    installFetch({ brief: null, approvals: [] }, calls);
    await renderPanel();
    const textarea = container.querySelector("textarea")!;
    setTextareaValue(textarea, "My typed post");
    await flush();
    clickButton(buttonByText("Save brief"));
    await flush();
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/social/brief");
    expect(post?.body).toEqual({ text: "My typed post", date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(container.textContent).toContain("Brief saved");
  });

  it("disables Save and posts nothing when the text exceeds the 4000-char cap", async () => {
    const calls: FetchCall[] = [];
    installFetch({ brief: null, approvals: [] }, calls);
    await renderPanel();
    const textarea = container.querySelector("textarea")!;
    setTextareaValue(textarea, "x".repeat(SOCIAL_BRIEF_MAX_CHARS + 1));
    await flush();
    expect(buttonByText("Save brief").disabled).toBe(true);
    expect(container.textContent).toContain(`4000`);
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/social/brief")).toBe(false);
  });

  it("trigger posts to the trigger route, shows the tick result, and leaves the goal disabled", async () => {
    const calls: FetchCall[] = [];
    installFetch({ brief: "Ready post", approvals: [] }, calls);
    await renderPanel();
    clickButton(buttonByText("Goals"));
    clickButton(buttonByText("Run now"));
    await flush();
    const trigger = calls.find((c) => c.method === "POST" && c.url === "/api/schedule/goals/daily-social-post/trigger");
    expect(trigger).toBeDefined();
    expect(container.textContent).toContain("created 1");
    expect(container.textContent).toContain("DISABLED");
    expect(calls.some((c) => c.url.includes("/enabled"))).toBe(false);
  });

  it("exposes no enable/disable control for the goal", async () => {
    installFetch({ brief: null, approvals: [] }, []);
    await renderPanel();
    const labels = buttons().map((b) => b.textContent ?? "");
    expect(labels.some((l) => l === "Enable" || l === "Disable")).toBe(false);
  });

  it("renders an error state when loading fails", async () => {
    installFetch({ failAll: true }, []);
    await renderPanel();
    // The panel surfaces the server's error text (the established panel
    // pattern) instead of invented data or a silent empty state.
    expect(container.textContent).toContain("Store unavailable.");
  });

  it("listPosts API retrieves submitted posts for the date (#1391)", async () => {
    const calls: FetchCall[] = [];
    installFetch({ brief: null, approvals: [] }, calls);
    const data = await listPosts("2026-10-24");
    expect(data.ok).toBe(true);
    expect(data.posts).toHaveLength(1);
    expect(data.posts[0].channel).toBe("threads");
    expect(data.posts[0].submissionEndpoint).toBe("https://graph.threads.net/v1.0/me/threads_publish");
    expect(data.posts[0].postUrl).toBe("https://www.threads.net/t/th_post_12345");
  });

  it("renders submitted post URL and submission endpoint in the UI (#1391)", async () => {
    installFetch({
      brief: "Test brief",
      posts: [
        {
          channel: "threads",
          draftId: "draft-th-1",
          date: "2026-10-24",
          status: "posted",
          text: "Live Threads post content",
          platformPostId: "th_post_99999",
          submissionEndpoint: "https://graph.threads.net/v1.0/me/threads_publish",
          postUrl: "https://www.threads.net/t/th_post_99999",
          createdAtMs: 1792849200000,
        },
      ],
    }, []);
    await renderPanel();

    // #2149: posts live behind the Posts tab (the tab label replaces the
    // old "Submitted posts" section title).
    clickButton(buttonByText("Posts"));
    expect(container.textContent).toContain("Threads");
    expect(container.textContent).toContain("POSTED");
    expect(container.textContent).toContain("https://graph.threads.net/v1.0/me/threads_publish");

    const link = container.querySelector('a[href="https://www.threads.net/t/th_post_99999"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("https://www.threads.net/t/th_post_99999");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("renders dry run note when a post has no live postUrl (#1391)", async () => {
    installFetch({
      brief: "Dry run brief",
      posts: [
        {
          channel: "x",
          draftId: "draft-x-1",
          date: "2026-10-24",
          status: "dry-run-posted",
          text: "Dry run X post",
          platformPostId: null,
          submissionEndpoint: "https://api.twitter.com/2/tweets",
          postUrl: null,
          createdAtMs: 1792849200000,
        },
      ],
    }, []);
    await renderPanel();

    clickButton(buttonByText("Posts"));
    expect(container.textContent).toContain("X");
    expect(container.textContent).toContain("DRY-RUN-POSTED");
    expect(container.textContent).toContain("Dry run (simulated — not submitted to live platform)");
    expect(container.textContent).toContain("https://api.twitter.com/2/tweets");
  });
});

