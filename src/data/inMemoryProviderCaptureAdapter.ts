/**
 * Issue #2303 (#1976 step 1) — in-memory provider-capture
 * store. A test double with the same port semantics as the D1
 * and DO-SQLite adapters: the conformance suite runs unchanged
 * against all three, including the shared record flows
 * (providerCapturePorts.ts) and their never-throws failure
 * semantics. It is NOT a production store and NOT a second
 * source of truth.
 */
import type {
  DataProviderCapability,
  DataProviderId,
} from "../trading";
import type { FetchOutcomeRecorder } from "../trading";
import {
  createFetchOutcomeRecorderWithStore,
  getCaptureBlob,
  recordCaptureWithStore,
  recordFetchFailureWithStore,
  type CaptureBlobDeps,
  type CaptureRowStore,
  type DataCaptureRecord,
  type ProviderCaptureStore,
  type RecordCaptureInput,
  type RecordFetchFailureInput,
} from "./providerCapturePorts";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryProviderCaptureAdapter implements ProviderCaptureStore {
  private records: DataCaptureRecord[] = [];

  private rows(): CaptureRowStore {
    return {
      insertRow: (record) => {
        this.records.push(clone(record));
      },
      getById: (tenantId, id) => {
        const found = this.records.find(
          (r) => r.tenantId === tenantId && r.id === id,
        );
        return found ? clone(found) : null;
      },
    };
  }

  async recordCapture(
    blobDeps: CaptureBlobDeps,
    input: RecordCaptureInput,
  ): Promise<DataCaptureRecord> {
    return recordCaptureWithStore(this.rows(), blobDeps, input);
  }

  async recordFetchFailure(
    input: RecordFetchFailureInput,
  ): Promise<DataCaptureRecord> {
    return recordFetchFailureWithStore(this.rows(), input);
  }

  createFetchOutcomeRecorder(): FetchOutcomeRecorder {
    return createFetchOutcomeRecorderWithStore(this.rows());
  }

  async getCaptureById(
    tenantId: string,
    id: string,
  ): Promise<DataCaptureRecord | null> {
    const found = this.records.find(
      (r) => r.tenantId === tenantId && r.id === id,
    );
    return found ? clone(found) : null;
  }

  private listWhere(
    tenantId: string,
    pick: (r: DataCaptureRecord) => boolean,
  ): DataCaptureRecord[] {
    return this.records
      .filter((r) => r.tenantId === tenantId && pick(r))
      .sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0))
      .map(clone);
  }

  async listCapturesByRun(
    tenantId: string,
    runId: string,
  ): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, (r) => r.runId === runId);
  }

  async listCapturesByProvider(
    tenantId: string,
    providerId: DataProviderId,
  ): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, (r) => r.providerId === providerId);
  }

  async listCapturesByCapability(
    tenantId: string,
    capability: DataProviderCapability,
  ): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, (r) => r.capability === capability);
  }

  async listCaptureFailures(tenantId: string): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, (r) => r.status === "capture_failed");
  }

  async listFetchFailures(tenantId: string): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, (r) => r.status === "fetch_failed");
  }

  async readCaptureRaw(
    blobDeps: CaptureBlobDeps,
    tenantId: string,
    id: string,
  ): Promise<{ record: DataCaptureRecord; rawBytes: Uint8Array | null } | null> {
    const record = await this.getCaptureById(tenantId, id);
    if (!record) return null;
    if (!record.rawBlobRef) return { record, rawBytes: null };
    const rawBytes = await getCaptureBlob(
      blobDeps.env,
      blobDeps.storage,
      record.rawBlobRef,
    );
    return { record, rawBytes };
  }
}
