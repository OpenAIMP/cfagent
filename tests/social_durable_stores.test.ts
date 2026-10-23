import { describe, it, expect } from "vitest";
import {
  createSessionStoreSocialLedger,
  createSessionStorePendingApprovalStore,
  createSocialStoresFromNamespace,
} from "../src/agents/social/durableStores";
import type { SocialDraft } from "../src/agents/social/draft";

/**
 * Fake SessionStore DO namespace. Implements the real reply contract
 * (get → {value}, put/delete → {ok:true}, list restricted to the
 * etrade namespace → 400 {error}) and records every op sent, so tests
 * can prove the adapters never send a "list" op for social keys.
 */
function makeFakeNamespace() {
  const data = new Map<string, string>();
  const ops: Array<{ op: string; ns: string; key: string }> = [];
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
      ops.push({ op: body.op, ns: body.ns, key: body.key });
      if (body.op === "list") {
        return Response.json({ error: "list is restricted to E*TRADE token entries" }, { status: 400 });
      }
      const mapKey = `${body.ns}:${body.key}`;
      if (body.op === "get") {
        return Response.json({ value: data.has(mapKey) ? data.get(mapKey)! : null });
      }
      if (body.op === "put") {
        if (typeof body.value !== "string") return Response.json({ error: "value is required" }, { status: 400 });
        data.set(mapKey, body.value);
        return Response.json({ ok: true });
      }
      if (body.op === "delete") {
        data.delete(mapKey);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unknown op" }, { status: 400 });
    },
  };
  const namespace = {
    idFromName: (_name: string) => "kv",
    get: (_id: unknown) => stub,
  };
  return {
    namespace,
    ops,
    rawPut: (ns: string, key: string, value: string) => void data.set(`${ns}:${key}`, value),
  };
}

function mkDraft(channel: string, date = "2026-10-26"): SocialDraft {
  return {
    id: `draft-${channel}`,
    date,
    channel: channel as SocialDraft["channel"],
    text: `post for ${channel}`,
    status: "draft",
    createdAtMs: 0,
    originalLength: 10,
    truncated: false,
  };
}

describe("SessionStore-backed social ledger", () => {
  it("round-trips drafts and lists by date via fan-out gets over known channels", async () => {
    const { namespace, ops } = makeFakeNamespace();
    const ledger = createSessionStoreSocialLedger(namespace.get(namespace.idFromName("kv")) as never);
    await ledger.putDraft(mkDraft("x"));
    await ledger.putDraft(mkDraft("threads"));
    await ledger.putDraft(mkDraft("x", "2026-10-27"));
    expect(await ledger.getDraft("2026-10-26", "x")).toEqual(mkDraft("x"));
    expect(await ledger.getDraft("2026-10-26", "facebook")).toBeUndefined();
    const opsBeforeList = ops.length;
    const listed = await ledger.listDrafts("2026-10-26");
    expect(listed.map((d) => d.channel).sort()).toEqual(["threads", "x"]);
    // Exact key convention, social namespace, and no list op anywhere.
    expect(ops.some((o) => o.op === "list")).toBe(false);
    expect(ops.filter((o) => o.op === "put").map((o) => o.key)).toContain("social-draft:2026-10-26:x");
    expect(ops.every((o) => o.ns === "social")).toBe(true);
    // Fan-out queried exactly the five known channels for the list.
    const listGets = ops.slice(opsBeforeList).filter((o) => o.op === "get");
    expect(listGets.map((o) => o.key).sort()).toEqual([
      "social-draft:2026-10-26:facebook",
      "social-draft:2026-10-26:instagram",
      "social-draft:2026-10-26:linkedin",
      "social-draft:2026-10-26:threads",
      "social-draft:2026-10-26:x",
    ]);
  });

  it("treats corrupt stored values as absent, never minting a draft", async () => {
    const { namespace, rawPut } = makeFakeNamespace();
    const ledger = createSessionStoreSocialLedger(namespace.get(namespace.idFromName("kv")) as never);
    rawPut("social", "social-draft:2026-10-26:x", "not-json{{{");
    rawPut("social", "social-draft:2026-10-26:threads", JSON.stringify({ nope: true }));
    rawPut("social", "social-draft:2026-10-26:facebook", "null");
    expect(await ledger.getDraft("2026-10-26", "x")).toBeUndefined();
    expect(await ledger.getDraft("2026-10-26", "threads")).toBeUndefined();
    expect(await ledger.getDraft("2026-10-26", "facebook")).toBeUndefined();
    expect(await ledger.listDrafts("2026-10-26")).toEqual([]);
  });

  it("fails loud on transport failure so the executor can retry", async () => {
    const failing = {
      async fetch(): Promise<Response> {
        throw new Error("do down");
      },
    };
    const ledger = createSessionStoreSocialLedger(failing as never);
    await expect(ledger.getDraft("2026-10-26", "x")).rejects.toThrow(/do down/);
    await expect(ledger.putDraft(mkDraft("x"))).rejects.toThrow(/do down/);
    const errorReply = {
      async fetch(): Promise<Response> {
        return Response.json({ error: "boom" }, { status: 500 });
      },
    };
    const ledger2 = createSessionStoreSocialLedger(errorReply as never);
    await expect(ledger2.getDraft("2026-10-26", "x")).rejects.toThrow();
  });
});

describe("SessionStore-backed pending approval store", () => {
  it("records, lists, and clears pending approvals with the mirrored key convention", async () => {
    const { namespace, ops } = makeFakeNamespace();
    const store = createSessionStorePendingApprovalStore(namespace.get(namespace.idFromName("kv")) as never);
    await store.recordPending({ date: "2026-10-26", channel: "facebook", draftId: "draft-facebook", requestedAtMs: 1 });
    await store.recordPending({ date: "2026-10-26", channel: "instagram", draftId: "draft-instagram", requestedAtMs: 2 });
    expect((await store.listPending("2026-10-26")).map((p) => p.channel).sort()).toEqual(["facebook", "instagram"]);
    expect(ops.some((o) => o.op === "list")).toBe(false);
    expect(ops.filter((o) => o.op === "put").map((o) => o.key)).toContain("social-pending:2026-10-26:facebook");
    await store.clearPending("2026-10-26", "facebook");
    expect((await store.listPending("2026-10-26")).map((p) => p.channel)).toEqual(["instagram"]);
    expect(ops.some((o) => o.op === "delete")).toBe(true);
  });

  it("treats corrupt pending values as absent", async () => {
    const { namespace, rawPut } = makeFakeNamespace();
    const store = createSessionStorePendingApprovalStore(namespace.get(namespace.idFromName("kv")) as never);
    rawPut("social", "social-pending:2026-10-26:facebook", "{{{bad");
    expect(await store.listPending("2026-10-26")).toEqual([]);
  });
});

describe("createSocialStoresFromNamespace", () => {
  it("returns null without a namespace, and working stores with one", async () => {
    expect(createSocialStoresFromNamespace(null)).toBeNull();
    expect(createSocialStoresFromNamespace(undefined)).toBeNull();
    const { namespace } = makeFakeNamespace();
    const stores = createSocialStoresFromNamespace(namespace as never);
    expect(stores).not.toBeNull();
    await stores!.ledger.putDraft(mkDraft("linkedin"));
    expect((await stores!.ledger.getDraft("2026-10-26", "linkedin"))?.id).toBe("draft-linkedin");
  });
});
