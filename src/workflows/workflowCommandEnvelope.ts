/**
 * Issue #1737 — translators between run-screen job commands
 * and messaging envelopes. In this slice commands travel as
 * workflow params (routes start workflows directly); the
 * envelope form makes them queue-carriable later, so the
 * work-queue consumer that starts workflows from commands
 * (an ADR 0003 follow-up, not this slice) needs no command
 * redesign.
 *
 * Envelope contract (messaging port, CloudEvents v1.0): the
 * command rides in data; the id is deterministic per job
 * (workflow-command:run-screen:<jobId>), so a redelivered
 * command carries the same idempotency key as the original.
 * The subject is the job id. Job-routing extensions carry
 * the parent/shard identity; no stage extension rides on a
 * command (commands initiate the pipeline — stage identity
 * belongs to the stage events and projection rows the run
 * produces, not to the command itself). Claim-check holds:
 * the envelope is size-validated by the messaging port, so
 * an oversized command (e.g. a symbol list over the cap) is
 * invalid at every boundary — and the command validator
 * already caps symbols before an envelope is ever built.
 */

import {
  isMessageEnvelope,
  type MessageEnvelope,
} from "../messaging/messagingPorts";
import {
  assertWorkflowJobCommand,
  type WorkflowJobCommand,
} from "./workflowPorts";

/** Build the envelope for a run-screen command. */
export function toWorkflowCommandEnvelope(
  command: WorkflowJobCommand,
  time: string = new Date().toISOString(),
): MessageEnvelope {
  assertWorkflowJobCommand(command);
  return {
    specversion: "1.0",
    id: `workflow-command:run-screen:${command.jobId}`,
    source: command.source,
    type: "run-screen",
    time,
    correlationid: command.jobId,
    subject: command.jobId,
    jobid: command.jobId,
    ...(command.parentJobId ? { parentjobid: command.parentJobId } : {}),
    ...(command.shard ? { shardid: command.shard.shardId } : {}),
    data: command,
  };
}

/**
 * Unwrap a run-screen command envelope, or null when the
 * envelope is not a valid run-screen command. Null means
 * "drop": the message can never become a workflow start.
 */
export function fromWorkflowCommandEnvelope(
  envelope: MessageEnvelope,
): WorkflowJobCommand | null {
  if (!isMessageEnvelope(envelope)) return null;
  if (envelope.type !== "run-screen") return null;
  try {
    return assertWorkflowJobCommand(envelope.data as WorkflowJobCommand);
  } catch {
    return null;
  }
}
