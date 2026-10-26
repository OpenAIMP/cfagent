/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — the #1738 actor-turn plug.
 *
 * Calibration plugs into the actor turn WITHOUT replacing the
 * actor port: a beforeTurn implementation calls this helper to
 * append the currently-active calibration note (if any) to the
 * turn's instructions. The runner itself is untouched — the
 * hook boundary is the designed extension point.
 *
 * Never-blocks: a resolver failure degrades to the base
 * instructions (warned, never thrown), so a telemetry outage
 * can never fail a chat turn. An absent note is a no-op:
 * instructions pass through byte-identical.
 */
export async function applyCalibratedPromptToInstructions(
  resolve: (actorKey: string, promptKey: string) => Promise<string | null>,
  actorKey: string,
  promptKey: string,
  baseInstructions: string,
): Promise<string> {
  try {
    const note = await resolve(actorKey, promptKey);
    if (!note) return baseInstructions;
    return `${baseInstructions}\n\n${note}`;
  } catch (err) {
    console.warn(
      `[telemetry] calibrated-prompt resolution failed, using base instructions (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
    return baseInstructions;
  }
}
