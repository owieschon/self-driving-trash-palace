# Threat model

This page identifies the assets, trust boundaries, abuse cases, controls, and residual risks for the credential-free TrashPal core.

## Security objective

An authenticated tenant may use Caretaker to inspect and propose work, but only application code may authorize a consequential mutation, bind it to an exact human approval, execute one logical operation, and declare success from deterministic evidence.

The fictional fixture is treated as production-shaped data. A whimsical tenant name does not weaken isolation, approval, or publication controls.

## Assets and trust boundaries

| Asset                         | Boundary                                   | Required control                                                                                                  |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Tenant state and identities   | Browser, HTTP, MCP, agent, and worker      | Resolve the organization from authenticated context; never accept it as a model or tool argument                  |
| Approval authority            | Human session and application transaction  | Bind actor, role, plan hash, action set, protected versions, expiry, and nonce                                    |
| Logical operation identity    | Application, database, worker, and gateway | Create it server-side, enforce uniqueness, and reconcile an unknown outcome before retry                          |
| Mission authority             | Worker lease and database                  | Fence every mission mutation by organization, mission, lease owner, token, and epoch                              |
| Agent context                 | Knowledge compiler and runtime projection  | Pin versions and hashes, separate host policy from untrusted evidence, and reject incompatible or private sources |
| Model credentials and prompts | Local process and provider adapter         | Keep credentials outside context and evidence; disable general tools; retain structured metadata only             |
| Analytics evidence            | Local sink and optional PostHog exporter   | Alias identifiers with keyed HMAC, allowlist properties, deduplicate inserts, and disable export by default       |
| Public artifacts              | Repository and CI                          | Scan reader-facing files, reports, receipts, media metadata, and archives before publication                      |

## Abuse cases and executable controls

| Abuse case                                             | Control                                                                                    | Verification                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Cross-tenant read or mutation                          | Authenticated tenant repositories, foreign keys, and host allowlist collapse               | Tenant-isolation unit, PostgreSQL, HTTP, and MCP tests                        |
| Forged or stale approval                               | Exact plan-hash and protected-version binding, short expiry, and server-created operations | Approval, activation, stale-state, and mutation tests                         |
| Blind retry after a lost response                      | Durable call and operation ledgers plus bounded reconciliation                             | Commit-then-response-lost and concurrent retry cases                          |
| Duplicate or reordered gateway callback                | Signed tenant-bound callback, monotonic generation, and evidence provenance                | Duplicate, stale, delayed, and forged callback tests                          |
| Lease takeover continues old work                      | Epoch-fenced writes and immutable terminal replay                                          | Lease-loss, restart, and raw PostgreSQL mutation tests                        |
| Retrieved text changes safety policy                   | Compiler-generated policy section and untrusted-evidence role                              | Prompt-injection and public-closure mutation tests                            |
| Model invokes ambient tools or reads local files       | Empty SDK tool surface, isolated runtime roots, and explicit credential/live-run gates     | Claude adapter contract tests; live behavior remains blocked without approval |
| Analytics leaks identifiers, prompts, or credentials   | HMAC aliases, strict event schemas, publication scrub, and disabled default export         | Redaction, event, sink, and exporter tests                                    |
| Two local processes corrupt one evidence file          | Interprocess lock, reload-under-lock, canonical payload comparison, and durable append     | Same-process and child-process concurrency tests                              |
| A report, screenshot, or skill archive leaks host data | Git-derived public surface and recursive text, metadata, ZIP, and TAR scanning             | Seeded leak tests for every retained artifact class                           |

## Publication boundary

`pnpm publication:check` obtains tracked and non-ignored files from Git. It never walks ignored credential paths. A tracked credential-shaped path fails immediately. The scanner covers root reader documents, `docs`, generated reference, authored knowledge, examples, public artifacts, evaluation reports, and skill packages.

Text is checked for credential shapes, email addresses, absolute home paths, private PostHog links, and, on strict retained surfaces, raw identifiers, prompt fields, and private-network URLs. Images are checked for printable metadata. ZIP, skill, TAR, and compressed TAR archives are opened with path, link, expansion, entry-count, size, and checksum controls before their contents are scanned.

Instead of retaining a private value as an example, use an environment-variable name, a repository-relative path, or a clearly typed placeholder that does not resemble a credential.

## Residual risks

- The local evidence file is durable for ordinary process and machine failures, but it is not a hosted event bus. Hosted mode requires a PostgreSQL evidence outbox before multiple machines may export.
- Printable metadata scanning does not prove that every image pixel is free of private text. A human must review screenshots before publication; OCR can be added when screenshots enter the core deliverable.
- Static scanning detects known credential and path shapes, not every possible semantic disclosure. Public artifacts still require review against their declared audience and evidence label.
- Deterministic tests establish application behavior, not real-model quality, PostHog ingestion, or a live self-improving loop. Those claims remain blocked until separately approved evidence exists.
- The gateway is simulated. Its signatures, callbacks, and failure model are production-shaped, but compatibility with physical hardware is unverified.

## Response

If a publication check fails, remove the private value from the reader-facing artifact and regenerate it from sanitized inputs. Do not weaken the scanner or add the leaked value to an allowlist. If a credential may have been exposed, rotate it before continuing and keep the contaminated artifact out of Git history.
