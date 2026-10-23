import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  planWithRules,
  executeNLQQuery,
  executeNLQQueryAsync,
  executeNaturalLanguageQuery,
  type NLQPlan,
  type NLQSocialBriefPort,
} from "../src/agents/nlq";
import type { Env } from "../src/types";
import { SOCIAL_BRIEF_MAX_CHARS } from "../src/agents/social/briefStore";

class FakeSocialBriefPort implements NLQSocialBriefPort {
  writes: Array<{ date: string; text: string }> = [];
  failWith: Error | null = null;
  async setBrief(req: { date: string; text: string }): Promise<void> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    this.writes.push(req);
  }
}

function socialPlan(text: string, dayOffset = 0): NLQPlan {
  return {
    domain: "social",
    operation: "create",
    socialData: { action: "set_brief", text, dayOffset },
    terms: "social brief",
    role: "any",
    since: null,
    limit: 25,
  } as NLQPlan;
}

function makeOrm() {
  return new DatabaseORM(new MockSqlStorage());
}

beforeEach(() => {
  vi.useFakeTimers();
  // Monday 2026-10-26 09:00 EDT = 13:00Z.
  vi.setSystemTime(new Date("2026-10-26T13:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NLQ social brief fast-path (rule planner)", () => {
  it("plans an explicit imperative set as a social set_brief for today", () => {
    const plan = planWithRules("Set social brief to Markets rallied today.");
    expect(plan.domain).toBe("social");
    expect(plan.operation).toBe("create");
    expect(plan.socialData).toEqual({ action: "set_brief", text: "Markets rallied today.", dayOffset: 0 });
  });

  it("plans use-the-post and tomorrow forms with dayOffset 1", () => {
    const a = planWithRules("Use the social post for tomorrow: Big day ahead.");
    expect(a.domain).toBe("social");
    expect(a.socialData).toEqual({ action: "set_brief", text: "Big day ahead.", dayOffset: 1 });
    const b = planWithRules("Set tomorrow's social brief to Hello.");
    expect(b.domain).toBe("social");
    expect(b.socialData?.dayOffset).toBe(1);
    expect(b.socialData?.text).toBe("Hello.");
    const c = planWithRules("set social brief: Hello world");
    expect(c.domain).toBe("social");
    expect(c.socialData?.text).toBe("Hello world");
  });

  it("never plans a brief from a question, a discussion, or an empty set", () => {
    for (const q of [
      "What should our social brief say?",
      "Show me social posts",
      "What is the social brief for today?",
      "How do I set a social brief?",
      "Set social brief to   ",
      "Tell me about social media strategy",
      "Use the social brief to explain the rally",
    ]) {
      expect(planWithRules(q).domain, q).not.toBe("social");
    }
  });

  it("a reminder request still wins the scheduling fast-path, not social", () => {
    const plan = planWithRules("Remind me to check social media in 10 minutes");
    expect(plan.domain).toBe("scheduling");
  });
});

describe("NLQ social brief executor (async)", () => {
  it("writes through the port and reports the date, never echoing the text", async () => {
    const port = new FakeSocialBriefPort();
    const result = await executeNLQQueryAsync(
      makeOrm(),
      "session-1",
      socialPlan("Markets rallied today."),
      {} as Env,
      "octocat",
      undefined,
      { socialBriefPort: port },
    );
    expect(result.domain).toBe("social");
    expect(port.writes).toEqual([{ date: "2026-10-26", text: "Markets rallied today." }]);
    expect(result.summary).toContain("2026-10-26");
    expect(result.summary).not.toContain("Markets rallied");
    expect(result.count).toBe(1);
  });

  it("resolves dayOffset 1 to tomorrow's NY date", async () => {
    const port = new FakeSocialBriefPort();
    await executeNLQQueryAsync(
      makeOrm(),
      "session-1",
      socialPlan("Tomorrow's post.", 1),
      {} as Env,
      "octocat",
      undefined,
      { socialBriefPort: port },
    );
    expect(port.writes).toEqual([{ date: "2026-10-27", text: "Tomorrow's post." }]);
  });

  it("without a port, fails honestly and writes nothing", async () => {
    const result = await executeNLQQueryAsync(
      makeOrm(),
      "session-1",
      socialPlan("No port brief."),
      {} as Env,
      "octocat",
      undefined,
      {},
    );
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/port/i);
  });

  it("a throwing port fails honestly as an error result, never a fake success", async () => {
    const port = new FakeSocialBriefPort();
    port.failWith = new Error("store down");
    const result = await executeNLQQueryAsync(
      makeOrm(),
      "session-1",
      socialPlan("Will fail."),
      {} as Env,
      "octocat",
      undefined,
      { socialBriefPort: port },
    );
    expect(result.status).toBe("error");
    expect(port.writes).toEqual([]);
  });

  it("empty and over-long text fail without touching the port", async () => {
    const port = new FakeSocialBriefPort();
    for (const text of ["", "   ", "x".repeat(SOCIAL_BRIEF_MAX_CHARS + 1)]) {
      const result = await executeNLQQueryAsync(
        makeOrm(),
        "session-1",
        socialPlan(text),
        {} as Env,
        "octocat",
        undefined,
        { socialBriefPort: port },
      );
      expect(result.status).toBe("error");
    }
    expect(port.writes).toEqual([]);
  });

  it("the sync executor refuses social plans honestly (async port required)", () => {
    const result = executeNLQQuery(makeOrm(), "session-1", socialPlan("Sync brief."));
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/asynchronous/i);
  });
});

describe("NLQ social brief funnel (executeNaturalLanguageQuery)", () => {
  it("passes a bound port through to the executor for an explicit set", async () => {
    const port = new FakeSocialBriefPort();
    const { plan, result } = await executeNaturalLanguageQuery(
      makeOrm(),
      "session-1",
      "Set social brief to Funnel brief.",
      {} as Env,
      "octocat",
      undefined,
      { socialBriefPort: port },
    );
    expect(plan.domain).toBe("social");
    expect(port.writes).toEqual([{ date: "2026-10-26", text: "Funnel brief." }]);
    expect(result.domain).toBe("social");
  });

  it("without a bound port the funnel reports the honest port error", async () => {
    const { plan, result } = await executeNaturalLanguageQuery(
      makeOrm(),
      "session-1",
      "Set social brief to Funnel brief.",
      {} as Env,
      "octocat",
      undefined,
      {},
    );
    expect(plan.domain).toBe("social");
    expect(result.status).toBe("error");
  });
});
