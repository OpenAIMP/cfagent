/**
 * Issue #2471 (program #2468, Phase 1) — first-run gate for the hub.
 *
 * Mounted once in Chat. It renders nothing when this user already
 * completed first-run (localStorage flag, keyed by login) or dismissed
 * setup for this session. Otherwise it shows the FirstRunScreen in a
 * Modal over the hub. Dismissal (Escape, backdrop, or Continue to hub)
 * is session-only: it never marks completion, so setup shows again on
 * the next login until the user finishes it. Completion (Finish) marks
 * the per-user flag and hides the gate from then on.
 *
 * The gate never blocks the hub on a load failure: the screen itself
 * renders the error with a Continue-to-hub path, so a broken identity
 * endpoint degrades to an unguided hub, not a bricked one.
 */
import React, { useState } from "react";
import { Modal } from "./components/ui";
import { FirstRunScreen } from "./FirstRunScreen";
import { isFirstRunComplete } from "./firstRunApi";

export interface FirstRunGateProps {
  userLogin: string;
}

export function FirstRunGate({ userLogin }: FirstRunGateProps) {
  const [dismissed, setDismissed] = useState(false);
  const [completed, setCompleted] = useState(() =>
    userLogin ? isFirstRunComplete(userLogin) : true,
  );

  if (!userLogin || dismissed || completed) return null;

  return (
    <Modal
      open
      title="Welcome — first-run setup"
      onClose={() => setDismissed(true)}
      size="lg"
    >
      <FirstRunScreen
        userLogin={userLogin}
        onComplete={() => setCompleted(true)}
        onDismiss={() => setDismissed(true)}
      />
    </Modal>
  );
}
