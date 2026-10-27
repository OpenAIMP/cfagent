### Added

- **Think fleet foundation (#1962, tracker #1951):** Think adapter landed behind the existing actor port with zero port interface changes — `src/actors/thinkAdapter.ts` (PortThink + ThinkActorTurn + lifecycle boot), `src/actors/thinkPortMapping.ts` (pure mapping), the `"think"` factory variant in `src/actors/createActorPorts.ts`, and `tests/think-port-mapping.test.ts` (9/9). Source: O3 spike #1935, byte-identical for the three standalone files. The existing actor-ports conformance suite still passes 24/24, untouched.
