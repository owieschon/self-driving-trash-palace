# Continuous integration

Use this page to configure and verify the checks that protect `main` before and after a change merges.

A green check is trusted evidence only when its toolchain is pinned and its authentication uses the narrowest caller and namespace scope the provider supports.

## Required checks

`Quality`, shown under the `CI` workflow, verifies and runs a pinned `actionlint` binary, installs the pinned workspace dependencies, checks documentation impact, formatting, and typed ESLint rules, typechecks, runs the deterministic test suite, and builds every package on Ubuntu 24.04 with Node 22. The root `pnpm check` command invokes `pnpm docs-impact:check`; CI inherits that command instead of maintaining a second validation rule in workflow YAML.

The documentation-impact verifier reads [the retained impact assessment](../../docs-impact.json), resolves each changed contract through the [contract-to-claim registry](../contract-claims.json), and requires the exact affected-claim union. For an `updated` disposition, every canonical source owner must exist in the [knowledge catalog](../../knowledge/catalog.json) and its canonical file must be present. `generated-only` and `no-user-impact` cannot be used for registered user-facing contracts.

`PostgreSQL 17 integration` runs every test file under `packages/db/src` and `packages/integration/src` against PostgreSQL 17.10 on Ubuntu 24.04 with Node 22.23.1 and pnpm 11.7.0. The service uses the same immutable image digest as `compose.yaml`, publishes only to `127.0.0.1:55432`, and uses fixed fictional CI credentials. A machine-readable Vitest receipt checks that every discovered test file ran and that no test was skipped, pending, disabled, or marked todo.

`Public artifact reproducibility` first requires a clean checkout, binds the current commit and index-tree object IDs, then creates two copies by reading the exact stage-zero blobs from Git. It validates the corresponding worktree paths for symlink escapes but never uses their bytes, scrubs ambient `GIT_*` repository overrides, and rejects a changed commit or index tree before issuing a receipt. The copies contain no generated output, Next.js build output, `.env*` path component, or retained run artifact. Each copy installs the frozen lockfile from an explicit shared pnpm store under a different locale and timezone, generates only the public API, MCP, tool, event, state-machine, and public-context-receipt allowlist, verifies raw-byte digests and canonical tool contracts, decodes every JSON artifact with fatal UTF-8 handling, scans decoded and encoded output for host paths on POSIX and Windows, and compares the two SHA-256 manifests byte-for-byte. The scan covers the repository, home, package stores, runtime roots, Node executable, and every `PATH` entry with path-boundary matching. Run the same verifier from a clean tracked checkout with `pnpm references:verify-reproducible`.

Each child has a distinct synthetic home, temporary directory, and XDG roots. It receives only the host `PATH`, the explicit package-manager locations, and fixed build inputs; it does not inherit ambient credentials, runtime injection options, or user and global package-manager configuration.

The per-copy install uses pnpm's offline mode and cannot fetch a missing package. The generator does not run inside an operating-system network sandbox, so this check proves offline dependency resolution and byte reproducibility, not the absence of arbitrary network syscalls from repository code.

`Credential-free composed Quest` builds the production-shaped Compose graph on Ubuntu 24.04 and runs the Night Shift Homecoming Quest through the public HTTP and MCP boundaries. It proves service readiness, exact Host and Origin acceptance, cross-tenant denial, HTTP/MCP result parity, persisted approval across a gateway and worker restart, deterministic fixture-clock arming, one logical operation after a lost acknowledgement, independent verification, mirror-tenant state preservation, and HTTP 401 rejection after delegated-token revocation. The command must finish with a succeeded mission, a passing ledger, and strict schema validation before it writes `evals/reports/credential-free-quest.json`. The receipt accepts evidence only for that run's mission alias, requires every transactional product-evidence outbox row to be acknowledged exactly once by the local sink, and checks the complete lifecycle through `mission completed`; valid evidence left by an earlier run cannot satisfy it.

The job deletes any pre-existing receipt before the run, checks the retained receipt boundary again, and runs the publication-safety scan. Only that JSON receipt is uploaded, and only after both checks pass. The artifact expires after three days. The private Compose environment, raw JSONL evidence, raw service logs, database state, and named volumes are never uploaded. An `always()` diagnostic step prints at most 40 stack-state lines and 80 redacted lines per service, truncates long lines, and removes generated credentials, authorization values, session cookies, and database user information before writing to the Actions log. A final `always()` step removes the stack, named volumes, and `artifacts/private/local-stack.env`; cleanup failure fails the job.

This Quest is credential-free but not network-isolated. Dependency installation and image pulls use the runner network, and the Compose bridge does not block runtime egress. The receipt therefore records `runtimeEgressIsolation: not_enforced`, `externalIntegrationsConfigured: false`, and keeps model-backed behavior and PostHog ingestion marked `blocked`.

`Endor Labs`, also shown under `CI`, runs after both `Quality` and `PostgreSQL 17 integration` for trusted same-repository pull requests and `main`. It scans dependencies from the committed root lockfile, repository history for secrets, source with SAST, GitHub Actions, and AI-model artifacts. Pull requests use `main` as their differential baseline. Pushes to `main` create monitored versions in Endor Labs. Findings are uploaded to GitHub code scanning as SARIF.

Endor does not depend on the composed Quest. Its privileged OIDC and code-scanning boundary remains gated by the deterministic build and PostgreSQL checks, while the credential-free Quest runs independently so both failure domains remain visible.

The Endor job installs the pinned package manager but does not execute dependency lifecycle scripts or repository code. TypeScript call-graph generation is disabled at this boundary; `CI / Quality` establishes build and test behavior before the scan starts.

Endor does not run privileged OIDC scans against code from forks or Dependabot. GitHub treats Dependabot pull requests like fork workflows, even though their head repository matches the base repository. GitHub accepts a skipped required job, so `Quality`, `PostgreSQL 17 integration`, `Public artifact reproducibility`, and `Credential-free composed Quest` remain the premerge gates for those pull requests. The next trusted `main` scan evaluates merged external and dependency updates.

## One-time Endor setup

The workflow fails closed until both sides of keyless authentication exist:

1. In Endor Labs, create a tenant namespace for this project.
2. Under **Settings > Access Control > Auth Policy**, add a **GitHub Action OIDC** policy with the **Code Scanner** role. Endor's documented keyless flow uses `user = owieschon`, which identifies the account rather than this repository. Scope that policy to only this project's Endor namespace. If Endor later documents a repository claim for this flow, replace the account-wide caller claim with `owieschon/trash-palace`.
3. Set the repository variable without storing an API key:

   ```bash
   REPOSITORY=owieschon/trash-palace
   ENDOR_NAMESPACE='YOUR_ENDOR_NAMESPACE'

   gh variable set ENDOR_NAMESPACE \
     --repo "$REPOSITORY" \
     --body "$ENDOR_NAMESPACE"
   ```

4. Run `CI` with `workflow_dispatch` and confirm that the Endor project, monitored `main` version, and GitHub code-scanning result all exist.

The workflow pins the Endor action, Endor CLI version and checksum, and SARIF uploader by immutable commit or digest. Review the pinned scanner release before updating `endorctl_version` and `endorctl_checksum` together.

Endor documents the tenant-side policy in [Keyless authentication in GitHub](https://docs.endorlabs.com/setup-deployment/ci-cd/keyless-authentication/github-keyless-auth) and the workflow inputs in [Scanning with GitHub Actions](https://docs.endorlabs.com/setup-deployment/ci-cd/scan-with-github-actions).

## Merge policy

Require these status checks on `main` after the first successful run:

- `Quality`
- `PostgreSQL 17 integration`
- `Public artifact reproducibility`
- `Credential-free composed Quest`
- `Endor Labs`

Select the emitted check-run names in the branch rules UI instead of typing a composite workflow label.

Do not mark a check successful through `continue-on-error`. If Endor is unavailable, keep the check failed and diagnose the service or authentication boundary instead.

The PostgreSQL, public-artifact, and composed-Quest jobs are locally contract-checked but remain unverified on Ubuntu until this workflow completes in GitHub Actions. Do not treat a macOS run as equivalent Ubuntu evidence.
