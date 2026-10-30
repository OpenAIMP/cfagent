/** @vitest-environment jsdom */

/**
 * Issue #2471 (program #2468, Phase 1) — second-user journey at the
 * production seams, no new route involved:
 *
 *   admin grants (existing IAAA grantMembership, #945)
 *     -> the grantee is authorized for tenant actions
 *     -> notification preferences round-trip through the existing
 *        lifecycle store (the store behind the existing preferences
 *        route)
 *     -> first-run completion persists per user, so a later login
 *        does not re-show the screen.
 *
 * The component half of the journey (first-run steps, panel save) is
 * covered by tests/first_run_screen_2471.test.tsx; this file proves the
 * server-side seams the journey consumes compose.
 */
import { describe, it, expect } from "vitest";
import {
  createMemoryMembershipStore,
  createMembership,
  authorize,
} from "../src/security/authorization";
import { grantMembership } from "../src/security/iaaaMembershipStore";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import { isFirstRunComplete, markFirstRunComplete } from "../src/client/firstRunApi";

const UUID_ADMIN = "11111111-1111-4111-8111-111111111111";
const UUID_SECOND = "22222222-2222-4222-8222-222222222222";

describe("second-user journey (#2471)", () => {
  it("grant -> authorized -> preferences persist -> completion hides first-run on later login", async () => {
    // Admin provisions a second user via the EXISTING grant path.
    const memberships = createMemoryMembershipStore();
    await createMembership(memberships, {
      internalUserId: UUID_ADMIN,
      tenantId: "tenant-1",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
      createdBy: "system:bootstrap",
      nowMs: 1_000,
    });
    const granted = await grantMembership(memberships, {
      granterInternalUserId: UUID_ADMIN,
      internalUserId: UUID_SECOND,
      tenantId: "tenant-1",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: UUID_ADMIN }],
      nowMs: 2_000,
    });
    expect(granted.ok).toBe(true);
    expect(await memberships.getMembershipsByUser(UUID_SECOND)).toHaveLength(1);

    // The grantee can act in the tenant (login + journey are usable).
    const decision = await authorize(memberships, {
      actorInternalUserId: UUID_SECOND,
      tenantId: "tenant-1",
      permission: "task:create",
      nowMs: 2_000,
    });
    expect(decision.decision).toBe("allow");

    // First-run: before completion the screen must show.
    expect(isFirstRunComplete("second-user")).toBe(false);

    // Preferences set during first-run persist via the existing store.
    const lifecycle = new InMemoryLifecycleAdapter();
    const saved = await lifecycle.setPreferences({
      userId: "second-user",
      tenantId: "tenant-1",
      digestEnabled: true,
      welcomeEnabled: true,
    });
    expect(saved.digestEnabled).toBe(true);
    const reread = await lifecycle.getPreferences("second-user", "tenant-1");
    expect(reread.digestEnabled).toBe(true);
    expect(reread.welcomeEnabled).toBe(true);

    // Completion: a later login does not re-show the screen.
    markFirstRunComplete("second-user");
    expect(isFirstRunComplete("second-user")).toBe(true);
  });
});
