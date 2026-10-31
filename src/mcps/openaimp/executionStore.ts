/**
 * Issue #1744 — cryptographic execution isolation store.
 *
 * Shared by every ToolPermissionPort adapter: adapters differ ONLY
 * in scope resolution, never in isolation mechanics, so the
 * isolation contract holds identically behind any adapter.
 *
 * Mechanics: each execution gets a fresh 256-bit random key and a
 * random id. The key is held ONLY by the gate that created the
 * execution — it never enters tool arguments, tool context, audit
 * payloads, or stream events. Opening a record requires the exact
 * key (constant-time compare); any other key, any other
 * execution's key, or an unknown id opens nothing. Ending with
 * the exact key destroys the record; afterwards even the right
 * key opens nothing. A wrong-key end destroys nothing.
 *
 * Records are per-isolate, short-lived (created and destroyed
 * inside one gated execution, in a finally block), and hold no
 * durable state. Process/memory isolation between tools remains
 * the Workers runtime's job — this store is execution-CONTEXT
 * isolation at the gate layer, exactly the issue's
 * "per-execution keys/context separation".
 */

import type { McpPrincipal } from "./mcpPermissionPorts";

export interface ExecutionRecord {
  executionId: string;
  toolName: string;
  principal: McpPrincipal;
  startedAtMs: number;
}

export interface ExecutionSeal {
  executionId: string;
  /** 256-bit random key, hex-encoded. Held by the gate only. */
  executionKey: string;
}

export interface ExecutionStore {
  begin(principal: McpPrincipal, toolName: string): ExecutionSeal;
  open(executionId: string, executionKey: string): ExecutionRecord | null;
  end(executionId: string, executionKey: string): boolean;
}

function randomKeyHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality (no early exit on first mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function createExecutionStore(): ExecutionStore {
  const records = new Map<string, { key: string; record: ExecutionRecord }>();
  return {
    begin(principal, toolName) {
      const seal: ExecutionSeal = {
        executionId: crypto.randomUUID(),
        executionKey: randomKeyHex(),
      };
      records.set(seal.executionId, {
        key: seal.executionKey,
        record: { executionId: seal.executionId, toolName, principal, startedAtMs: Date.now() },
      });
      return seal;
    },
    open(executionId, executionKey) {
      const entry = records.get(executionId);
      if (!entry) return null;
      return constantTimeEqual(entry.key, executionKey) ? entry.record : null;
    },
    end(executionId, executionKey) {
      const entry = records.get(executionId);
      if (!entry || !constantTimeEqual(entry.key, executionKey)) return false;
      records.delete(executionId);
      return true;
    },
  };
}
