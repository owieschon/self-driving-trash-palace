# How TrashPal was built

This page records what the build process proved, what it missed, and where human judgment changed the result.

## The measured run

Specification began on July 14, 2026 at 4:43:43 PM EDT. The final plan was approved at 11:46:01 PM, after 7 hours, 2 minutes, and 18 seconds of specification work. Autonomous implementation was authorized at 11:49:06 PM. The initial public release followed on July 15 at 8:27:55 PM, 20 hours, 38 minutes, and 49 seconds later.

The run was continuous, not unattended in the literal sense. Its session record contains 52 user messages including the kickoff, or 51 interventions after work began. They fall into three recurring kinds:

- Direction changed the product boundary, such as replacing a single quest-shaped demo with a reusable automation product.
- Correction caught false assumptions, such as separating the signed-off frontend from the production topology and refusing to treat simulated providers as live integrations.
- Taste removed work that was technically plausible but narratively weak, including toy-like interactions and UI that made the raccoon more important than the reliability model.

The 20-hour duration includes implementation, builds, test runs, container work, research, receipt generation, and responses to those interventions. It is not a claim of 20 hours spent typing code.

## What the gates caught

The repository was specified before it was built. [`BUILD_SPEC.md`](BUILD_SPEC.md) defined the authority boundary, durable identities, unknown-outcome recovery, knowledge contract, evaluation labels, and publication rules. The implementation then had to satisfy executable checks rather than merely resemble the spec.

That distinction mattered. A local quality run passed while skipping database suites that needed PostgreSQL. Clean Ubuntu CI ran those suites, found seven stale fault expectations, and rejected the composed Quest. The repair aligned the application-response-loss contract and taught Caretaker to query the existing operation after an uncertain activation instead of activating again until its budget expired. Application idempotency had made the old behavior safe, but not smart.

The publication scanner also caught repository residue outside the product surface. Contract and copy checks found generated-reference drift and stale terminology. The credential-free Quest proved the services composed across HTTP, MCP, PostgreSQL, worker restarts, gateway faults, revocation, and independent verification.

## What still needed a person

The gates could prove behavior, but they could not decide whether the product felt like a real multi-tenant automation system or a polished Night Shift replay. Human review changed the information architecture, preserved Scheduled Hauler Access as a second program, removed dead controls, and kept the whimsical scenario subordinate to the technical claim.

An independent audit still found two demo-path bugs after the main build: approval could submit a different automation from the one under review, and the initial decision count ignored a seeded pending item. It also found an opinion that the code enacted but the docs never stated: people and agents should learn from one canonical, testable knowledge system. Those findings became fixes and this repository's [documentation standard](../knowledge/resources/trustworthy-docs-for-humans-and-agents.md), not footnotes erased from the story.

## Known bulk and honest limits

Two files remain larger than they should be: `packages/db/src/repositories.ts` is about 7,200 lines and `packages/application/src/testing/fakes.ts` is about 2,950. Splitting them before the application would add churn without changing the demonstrated contracts, so they are recorded as maintenance debt rather than disguised as a design choice.

The default path remains deterministic. Live device providers, production authentication, a deployed self-improving loop, and corpus-scale model behavior are not proven. The [limitations ledger](evaluation/limitations.md) is the current source for those boundaries.

The useful result is not that an agent wrote a large repository quickly. It is that the combination of a written contract, executable gates, retained receipts, independent review, and 51 human interventions made confident errors visible while they were still cheap to correct.
