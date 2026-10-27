/**
 * Issue #1957 (think-fleet, tracker #1951, shape (a)) — PaymentsAgent
 * migrates from Agent to PortThink.
 *
 * PaymentsAgent is a non-chat, RPC-only actor: it drives no turns, has
 * no chat hooks, and registers no scheduler callbacks (verified
 * against the pre-migration file: no beforeTurn/onChatResponse/
 * onChatError/schedule in the class). Its migration is therefore the
 * base class alone, and its "Think turn path" coverage is this pin:
 * the class extends PortThink, defines no turn hooks of its own (so
 * any turn would go through PortThink's translation, with portHooks
 * unset), and its RPC surface is intact. Prototype-level assertions
 * only — instantiating a Durable Object needs a live ctx/env, which
 * this pin deliberately does not fake.
 */
import { describe, it, expect } from "vitest";
import { PaymentsAgent } from "../src/agents/payments-agent";
import { PortThink } from "../src/actors/thinkAdapter";

const RPC_METHODS = [
  "budgetCheck",
  "processPaidRequest",
  "todaySpent",
  "listPayments",
  "migrateLegacyLedger",
] as const;

const TURN_HOOKS = ["beforeTurn", "onChatResponse", "onChatError"] as const;

describe("PaymentsAgent Think migration (#1957)", () => {
  it("extends PortThink, not raw Agent", () => {
    expect(Object.getPrototypeOf(PaymentsAgent)).toBe(PortThink);
  });

  it("defines no turn hooks of its own", () => {
    for (const hook of TURN_HOOKS) {
      expect(
        Object.prototype.hasOwnProperty.call(PaymentsAgent.prototype, hook),
        hook
      ).toBe(false);
      // The hook resolves through PortThink's translation, not a
      // class-defined override.
      expect(typeof (PaymentsAgent.prototype as any)[hook]).toBe("function");
    }
  });

  it("keeps its RPC surface intact", () => {
    for (const method of RPC_METHODS) {
      expect(typeof (PaymentsAgent.prototype as any)[method]).toBe("function");
    }
  });

  it("leaves portHooks unset: there were no port hooks to keep", () => {
    expect("portHooks" in PaymentsAgent.prototype).toBe(false);
  });
});
