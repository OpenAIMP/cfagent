/**
 * Issue #2471 (program #2468, Phase 1) — guided first-run screen.
 *
 * Guided steps: (1) account/identity confirmation, (2) E*TRADE connect
 * guidance, (3) notification preferences, (4) completion. Built ONLY
 * from src/client/components/ui/ primitives with token-only styling
 * (ux-architecture §20): no bespoke classes, no inline styles.
 *
 * Read-only by construction: step 1 renders identity and tier as
 * plain text from the #2219 self-only endpoint. The screen assigns no
 * tier, writes no tier record, and takes no tenant input — there is
 * no input on step 1 at all. Step 2 points at the EXISTING Settings
 * E*TRADE path (it dispatches the Settings menu's own
 * "open-settings-menu" event); it builds no connect flow. Step 3 is
 * the NotificationPreferencesPanel over the existing lifecycle
 * preferences route. Finish persists completion per user (see
 * firstRunApi for the mechanism and its stated limitation) and then
 * calls onComplete; the gate hides the screen from then on.
 *
 * Failure policy (#462 partial contract, typed never silent): an
 * identity load failure shows a fixed caller-facing error and offers
 * Continue to hub via onDismiss — it never skips silently into the
 * hub, and never marks completion on failure.
 */
import React, { useEffect, useState } from "react";
import { Badge, Button, Card, Notice, PageSection, PageShell, Spinner } from "./components/ui";
import {
  fetchPlatformIdentity,
  markFirstRunComplete,
  type PlatformIdentityView,
} from "./firstRunApi";
import { NotificationPreferencesPanel } from "./NotificationPreferencesPanel";

export interface FirstRunScreenProps {
  /** Session login, used only as the completion-store key. */
  userLogin: string;
  /** Called after Finish persists completion. */
  onComplete?: () => void;
  /** Called when the user leaves setup without completing (session-only). */
  onDismiss?: () => void;
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: "Confirm your account",
  2: "Connect your brokerage",
  3: "Notification preferences",
  4: "You are all set",
};

export function FirstRunScreen({ userLogin, onComplete, onDismiss }: FirstRunScreenProps) {
  const [step, setStep] = useState<Step>(1);
  const [identity, setIdentity] = useState<PlatformIdentityView | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await fetchPlatformIdentity();
        if (!cancelled) setIdentity(found);
      } catch {
        if (!cancelled) setIdentityError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = () => {
    markFirstRunComplete(userLogin);
    onComplete?.();
  };

  return (
    <PageShell
      title="Welcome — first-run setup"
      scopeNote="A guided first run: confirm your account, connect your brokerage, and set notification preferences."
      loading={loading}
      loadingLabel="Loading your account"
    >
      <PageSection title={`Step ${step} of 4: ${STEP_TITLES[step]}`}>
        {identityError || identity === null ? (
          <Card>
            <Notice tone="danger">
              First-run setup couldn&apos;t load your account. Check your
              connection and try again, or continue to the hub for now —
              setup will show again on your next login until it is completed.
            </Notice>
            {onDismiss && (
              <Button type="button" variant="primary" onClick={onDismiss}>
                Continue to hub
              </Button>
            )}
          </Card>
        ) : step === 1 ? (
          <Card>
            <p>
              Signed in as: <strong>{identity.userLogin}</strong>
            </p>
            <p>
              Tier: <Badge tone="neutral">{identity.tier}</Badge>
            </p>
            <p>
              Account: {identity.hasAccount ? "Active" : "Not set up yet"}
              {identity.tenantId ? ` (workspace ${identity.tenantId})` : ""}
            </p>
            <p>
              Identity and tier are shown from your account and cannot be
              changed here. This screen assigns nothing.
            </p>
            <Button type="button" variant="primary" onClick={() => setStep(2)}>
              Continue
            </Button>
          </Card>
        ) : step === 2 ? (
          <Card>
            <p>
              To connect your brokerage, open Settings (the gear menu) and use
              the E*TRADE section to connect or switch environments. This
              screen does not connect anything itself — Settings is the one
              existing E*TRADE path.
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.dispatchEvent(new CustomEvent("open-settings-menu"))}
            >
              Open Settings
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>{" "}
            <Button type="button" variant="primary" onClick={() => setStep(3)}>
              Continue
            </Button>
          </Card>
        ) : step === 3 ? (
          <>
            <NotificationPreferencesPanel
              identity={identity}
              onSaved={() => setStep(4)}
              onContinue={() => setStep(4)}
            />
            <Button type="button" variant="secondary" onClick={() => setStep(2)}>
              Back
            </Button>
          </>
        ) : (
          <Card>
            <p>
              You are all set. Your preferences are saved, and this setup
              screen will not show again on your next login.
            </p>
            <Button type="button" variant="primary" onClick={finish}>
              Finish
            </Button>
          </Card>
        )}
      </PageSection>
    </PageShell>
  );
}
