/**
 * src/data/webhookReplayPorts.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A): the webhook_replay_nonces port (id field =
 * nonce). DO residency (D-0 (a),(b),(e)): replay claims are
 * claimed against the receiving instance's storage (#143).
 *
 * #CDO-mha7
 */
import type { WebhookReplayNonce } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface WebhookReplayPort
  extends RepositoryPort<WebhookReplayNonce> {}
