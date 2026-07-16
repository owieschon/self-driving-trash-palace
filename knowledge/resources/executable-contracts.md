# Executable API, MCP, and event reference

This page points readers to machine-readable projections of executable contracts; it does not restate those contracts.

Prerequisites: understand [context authority](../concepts/context-authority.md) and review the [evaluation methodology and limitations](evaluation-methodology-and-limitations.md).

| Reference                                                                                                                     | Executable owner                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [OpenAPI 3.1](../../generated/reference/openapi.json)                                                                         | Tool registry, web API registry, and HTTP boundary |
| [Tool registry](../../generated/reference/tool-registry.json) and [per-tool schemas](../../generated/reference/tools)         | Typed tool registry and result envelopes           |
| [MCP catalog](../../generated/reference/mcp-catalog.json)                                                                     | Executable MCP transport projection                |
| [Evidence event registry](../../generated/reference/event-registry.json)                                                      | Analytics-safe event schemas                       |
| [Mission state machine](../../generated/reference/mission-state-machine.json)                                                 | Mission state schema and transition resolver       |
| [Context registry](../../generated/reference/context-registry.json) and [context schemas](../../generated/reference/contexts) | Context compiler schemas and routing               |
| [SHA-256 manifest](../../generated/reference/manifest.json)                                                                   | Reference generator output                         |

## Regenerate after changing an owner

Use the source commit timestamp so another clean checkout can reproduce the same bytes:

```bash
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" pnpm references:generate
pnpm references:check
```

Check mode reads the retained epoch from the manifest when `SOURCE_DATE_EPOCH` is absent. It performs no writes and fails for a missing, changed, or unexpected generated file. `pnpm check` runs it before the other quality gates.

The [CI reproducibility check](../../docs/operations/continuous-integration.md) separately builds the explicit public subset twice and compares its verified manifests. Its tool registry points only to schemas inside `generated/public-reference`, so the subset can be published without this internal tree. Internal context schemas are not part of that publication boundary.

## Finish

The Build path is complete when the retained references match their executable owners and the repository quality gate passes.
