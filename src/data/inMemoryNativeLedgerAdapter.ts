/**
 * Issue #2192 — in-memory native ledger.
 *
 * A test double with the same port semantics as the D1
 * adapter. It is NOT a production store and NOT a second
 * source of truth — it exists so the port contract is
 * testable without any store at all. No migration concept
 * applies here (there is no SQL to migrate).
 */
import {
  buildNativeChargeTransaction,
  buildNativeCreditTransaction,
  nativeLedgerSessionId,
  type NativeLedgerPort,
  type NativeLedgerRow,
  type NativeLedgerRowInput,
} from "./nativeLedgerPorts";

export class InMemoryNativeLedgerAdapter implements NativeLedgerPort {
  private rows = new Map<string, NativeLedgerRow>();

  private key(sessionId: string, action: string): string {
    return `${sessionId}\n${action}`;
  }

  async recordRow(
    input: NativeLedgerRowInput,
  ): Promise<{ row: NativeLedgerRow; duplicate: boolean }> {
    const existing = await this.findRow(input.runRequestId, input.kind);
    if (existing) return { row: existing, duplicate: true };
    const built =
      input.kind === "charge"
        ? buildNativeChargeTransaction(input)
        : buildNativeCreditTransaction(input);
    this.rows.set(this.key(built.sessionId, built.action), built);
    return { row: built, duplicate: false };
  }

  async findRow(
    runRequestId: string,
    kind: "charge" | "credit",
  ): Promise<NativeLedgerRow | undefined> {
    return this.rows.get(this.key(nativeLedgerSessionId(runRequestId), kind));
  }

  async listRowsForRun(runRequestId: string): Promise<NativeLedgerRow[]> {
    const sessionId = nativeLedgerSessionId(runRequestId);
    return [...this.rows.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) =>
        a.createdAtMs !== b.createdAtMs
          ? a.createdAtMs - b.createdAtMs
          : a.id < b.id
            ? -1
            : 1,
      );
  }

  async listRowsForTenant(tenantId: string): Promise<NativeLedgerRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) =>
        a.createdAtMs !== b.createdAtMs
          ? a.createdAtMs - b.createdAtMs
          : a.id < b.id
            ? -1
            : 1,
      );
  }
}
