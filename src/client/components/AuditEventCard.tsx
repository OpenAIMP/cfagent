/**
 * Issue #2371 (AOP phase 2, program #1969; renders the #2381 outcome
 * catalog): one audit event card
 * for the records explorer. For a cataloged code the resolved business
 * message leads, the raw code is secondary, and category/retryability
 * are visible — never a raw-code-only rendering for a cataloged code.
 * The raw payload stays visible below, unchanged. Built only from
 * ui primitives (Card, Badge); the card keeps the explorer's existing
 * event-* class names so its styling is untouched.
 */
import React from "react";
import { Card, Badge } from "../components/ui";
import type { AuditLogEvent } from "../chat/types";

export function AuditEventCard({ event: e }: { event: AuditLogEvent }) {
  const resolved = e.resolvedAspects ?? null;
  return (
    <Card padding="none" className="event-item">
      <div className="event-header">
        <span className={`event-agent-tag ${e.agent}`}>{e.agent.toUpperCase()}</span>
        <span className="event-type">{e.type}</span>
        <span className="event-time">{new Date(e.created_at).toLocaleTimeString()}</span>
      </div>
      {resolved ? (
        <div>
          <div>
            <strong>{resolved.businessMessage}</strong>
          </div>
          <div>
            <span>{resolved.code}</span>{" "}
            <Badge size="xs" tone="info">
              {resolved.category}
            </Badge>{" "}
            <Badge size="xs" tone={resolved.retryable ? "success" : "neutral"}>
              {resolved.retryable ? "Retryable" : "Not retryable"}
            </Badge>
          </div>
        </div>
      ) : null}
      <pre className="event-payload">{JSON.stringify(e.payload, null, 2)}</pre>
    </Card>
  );
}
