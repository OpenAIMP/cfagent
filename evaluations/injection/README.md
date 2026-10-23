# Prompt-injection eval sets (#767)

Versioned red-team fixtures for paths where untrusted content reaches an LLM
prompt (see `docs/THREAT_MODEL.md` §7). Each version directory holds a
`manifest.json` (version, categories, provenance, runner) and a `cases.json`.

- **v1** — the email→NLQ path (THREAT_MODEL §7 path 1), defended in #862.
  Runner: `tests/nlq_injection_evalset.test.ts` (CI, via the normal test
  suite). Cases are assembled through the production `plannerPrompt` /
  `withUntrustedRule` helpers; invariants: delimiter containment, exactly
  one real END delimiter, legitimate request preserved as data, rule present
  in the system prompt — plus a per-case negative control proving the
  undefended assembly fails the same invariants.
- **v2** — the orchestrator chat-turn path (THREAT_MODEL §7 path 2),
  defended in #879. Runner: `tests/orchestrator_injection_evalset.test.ts`
  (CI, via the normal test suite). Cases place stored content (session
  memory, vector/knowledge results, options-research context) into the
  production `buildOrchestratorSystemPrompt` assembly in its declared
  slot; invariants: content arrives only inside the retrieved-content
  delimiters as data, exactly one real END delimiter per populated slot
  (embedded markers defused), legitimate datum preserved inside the
  region, rule present in the system prompt — plus a per-case negative
  control proving the separation-stripped (pre-#879) assembly fails the
  same invariants.

Adding a case: append to `cases.json` with a unique `caseId`, a declared
`category`, and an `expect.mustContainData` substring naming the legitimate
request inside the attack/control email that must survive as data. New
attack categories must also be added to the manifest's `categories` list —
the runner fails if a declared category has no case.
