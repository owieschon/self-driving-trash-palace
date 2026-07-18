# TrashPal revision preservation map

This map binds each revised behavior to an existing owner so the revision adapts the product instead of creating a parallel implementation.

| Revised behavior               | Existing owner to reuse                                              | Current proof                                                         | Preservation rule                                                                                            |
| ------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tenant-safe Palace access      | `TenantReadService`, session service, `PalaceSchema`                 | `packages/application/src/__tests__/tenant-read-service.test.ts`      | A workspace projection must authenticate and constrain every record to the member's organization and Palace. |
| Mission creation               | `MissionBootstrapService` and management route                       | `mission-bootstrap-service.test.ts`, `management-routes.test.ts`      | Do not add an automation-activation shortcut.                                                                |
| Human clarification            | `HumanTaskService` and `ClarificationService`                        | `human-task-service.test.ts`, `clarification-service.test.ts`         | Render the server question and submit its observed mission version.                                          |
| Exact proposal review          | `PlanService`, `ApprovalService`, and approval route                 | `approval-and-operation.test.ts`, `management-routes.test.ts`         | Render the persisted plan revision and use its stored approval nonce.                                        |
| Idempotent operation creation  | `OperationService` and operation ledger                              | `approval-and-operation.test.ts`                                      | Approval creates or returns one logical operation; browser retries do not mint another one.                  |
| Unknown-result recovery        | `OperationService.reconcile` and mission transitions                 | `approval-and-operation.test.ts`, worker tests                        | An unknown response remains checking until reconciliation finds durable truth.                               |
| Execution and observation      | Worker runtime, outbox, execution services                           | `apps/worker/src/worker-runtime.test.ts`                              | Do not add a client scheduler or infer device effects in the UI.                                             |
| Verification                   | `VerificationService`, deterministic verifier, verification evidence | `deterministic-verifier.test.ts`, `planning-and-verification.test.ts` | Only retained verification evidence may produce `verified`.                                                  |
| Continuous Pal operation       | Existing worker/outbox, mission resume, host policy, tool registry   | worker runtime and agent tests                                        | Event-driven continuation only; no perpetual model polling or second agent loop.                             |
| Palace local presentation time | Palace timezone plus web runtime clocks                              | `production-runtime.test.ts`, existing clock tests                    | Use security/wall time for greetings; never fixture domain time or browser-local `Date`.                     |
| Knowledge and Help             | `knowledge/catalog.json`, navigation, knowledge route                | `knowledge-catalog-route.test.ts`, `knowledge-eval.ts`                | One canonical corpus; audience metadata guides navigation without hiding developer material.                 |
| Approved visual foundation     | Relay components, current product components, product styles         | product browser tests                                                 | Restructure in place; do not introduce a second frontend or component library.                               |

## Historical compatibility residue

The codebase still contains historical Caretaker names in migrations, persistence relation names, generated evidence, and current runtime symbols. The controlled Pal migration is a later sequential phase. This contract freezes public language now without rewriting database history or creating compatibility copies of the product.

## Stop condition

If a planned behavior cannot name one existing owner and one current proof, stop the lane and report the missing source. It must not be filled with hard-coded fixture data, a new database table, a duplicate lifecycle, or a second knowledge tree.
