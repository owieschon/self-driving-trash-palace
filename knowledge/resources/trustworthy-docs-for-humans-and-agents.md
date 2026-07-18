# Trustworthy docs for humans and agents

This page states the documentation standard that TrashPal is built to enforce. Read [context and authority](../concepts/context-authority.md) first for the boundary between host policy, authored guidance, and runtime evidence.

Great documentation gives another mind a working, honest, bounded model of a system so it can act correctly without the author standing nearby. That job does not change when the reader is an agent. Agents merely make missing steps, stale facts, and vague limits fail faster.

## One fact gets one owner

A fact should have one canonical source. Other pages link to it instead of restating it. TrashPal records those owners in the [claim registry](../../docs/claims/registry.json), where stable claim IDs point to their source and locator.

This keeps correction cheap. When runtime behavior changes, maintainers can find the explanation that must change with it instead of searching for prose that happens to sound related.

## The source must be the source delivered

The [knowledge catalog](../catalog.json) pins every published source by path, version, and SHA-256 digest. A changed page with an unchanged catalog fails verification. An agent therefore cannot quietly receive different instructions under the same source identity.

Pal does not consume a parallel summary written for machines. Its `knowledge.search` tool selects from this same catalog, applies audience and permission filters, and returns cited, versioned sections. The navigation can change how a person finds a source without changing what the agent is taught.

## Order is part of correctness

Good facts in the wrong order still make bad instructions. The [navigation manifest](../navigation.json) declares the Use and Build learning paths, including prerequisites and the next source in each sequence. Repository tests reject missing sources, backwards prerequisites, and broken next links.

That structure supports progressive disclosure without making the knowledge vague. A reader can stop after the first useful path. An agent can request the next bounded source when its current context is insufficient.

## Explanation never outranks runtime truth

Documentation can describe an intended contract, but code and retained evidence decide whether the contract holds. The [first architecture decision](../../docs/decisions/0001-separate-runtime-truth-from-explanation.md) separates those responsibilities. The [executable reference](executable-contracts.md) points to OpenAPI, MCP, event, and mission projections generated from typed owners and drift-checked during `pnpm check`.

The [evaluation methodology and limitations](evaluation-methodology-and-limitations.md) defines the labels used when evidence is missing. The honest result is Blocked or Unverified. A polished guide, a successful process exit, or an agent's confident report cannot upgrade that result.

## A useful page leaves a checkable result

Concept pages name the model and its limits. Procedures give ordered actions and expected evidence. Reference pages answer lookup questions. Evaluation pages state what a result proves and what it does not.

The standard is simple: a person should be able to use the page, an agent should be able to act from the same maintained source, and the repository should detect when either audience would be taught something stale. People are charitable readers who fill gaps. Agents are not. Trustworthy documentation should not require charity from either one.
