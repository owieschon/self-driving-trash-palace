# ADR 0007: Keep Google Home access inside a native companion

This decision defines where Google Home authority and data may cross the TrashPal boundary.

Status: Accepted

## Context

TrashPal needs a path from its deterministic simulator to real home devices without giving Caretaker, MCP clients, analytics, or the Node backend ambient access to a person's home.

Google's current [Home APIs](https://developers.home.google.com/apis) are native Android and iOS SDKs. They expose structures, devices, traits, state, commands, events, and automations through a user-consented mobile application. The documented surface is not a general Node or server SDK. Google's [Cloud-to-cloud integration](https://developers.home.google.com/cloud-to-cloud) and [HomeGraph REST API](https://developers.home.google.com/reference/home-graph/rest) expose a provider's own devices to Google; they do not grant a backend general access to devices already present in a user's Google Home.

The official [Google Home Developers MCP server](https://developers.home.google.com/reference/home-developers/mcp) searches documentation. It does not discover, read, or control devices.

Google's [developer policies](https://developers.home.google.com/policies) impose an additional boundary. They prohibit using Google Home integration data to train artificial-intelligence models or other related tools, limit retained Home-derived data to ten days, require user knowledge and consent for changes, and require secondary user verification for operations that make a home less secure.

## Decision

Keep the gateway simulator as the default provider in local development and CI. A passing simulator or synthetic contract test never establishes live Google Home connectivity.

Add real Google Home support only through an Android or iOS native companion:

1. The companion owns Google OAuth, Home Permissions, raw structure and device identifiers, device names, room names, traits, state, and SDK responses. This data never enters the backend, Caretaker context, MCP, analytics, logs, traces, or public artifacts.
2. A user explicitly maps a native device to an app-owned logical binding such as `dev_front_lock`. The backend receives only the logical tenant, palace, device, and capability identifiers in a signed lease that expires within five minutes. The lease carries the durable `google_home_derived_restricted` source classification.
3. The backend wraps an existing stable gateway command in a signed command envelope. The envelope binds one tenant, palace, logical binding, capability, gateway command ID, exact approval hash, issue time, and expiry time. The gateway command ID is also the idempotency key.
4. One application orchestrator owns the dispatch boundary. It requires adapters for persisted exact-approval verification, key-to-tenant signature trust, an atomic replay journal, one-use mobile confirmation, immediate native consent/binding/safety checks, private SDK dispatch, sanitized-receipt verification, and a trusted clock. No caller-provided boolean bag or timestamp can bypass those ports.
5. The native checks return only command-bound transient facts. Temperature changes must explicitly pass configured thermostat bounds and the current energy budget. Lighting changes must explicitly pass the energy budget. Unknown is a failure, not success.
6. The companion returns only a signed sanitized outcome. It may report a bounded status and error code, but not a provider response, raw state, device identifier, room, trait, or free-form error message.
7. An atomic journal compares the canonical request hash before any effect. An exact retry returns the first verified receipt without redispatch; a changed request under the same command ID fails as a conflict. Unlock confirmation is consumed inside that first-execution boundary and can be used once.
8. Google-derived leases and receipts carry a deletion deadline no more than ten days after recording. Receipt retention is anchored to `firstRecordedAt`, so rewriting a receipt cannot extend its lifetime. Production storage must delete records by the deadline; a shorter lifetime is preferred.

Signatures use Ed25519 over an exact UTF-8 payload: domain, version, algorithm, key ID, signing time, and the RFC 8785-compatible canonical JSON subset admitted by the ASCII wire schemas, joined by line feeds with no trailing line feed. A signature is exactly 64 bytes encoded as 86 unpadded base64url characters. The core conformance test includes a fixed RFC 8032 key, payload, and signature vector that Kotlin and Swift implementations must reproduce before exchanging real keys.

Unlock is never autonomous. The exact approved plan is necessary but insufficient: each unlock envelope must also carry a fresh secured-mobile confirmation, and the companion must validate that confirmation immediately before dispatch. Google's [Automation API blocked-action list](https://developers.home.google.com/apis/android/automation/blocked-actions) also blocks `LockUnlock.Unlock`, so an automation cannot substitute for this confirmation.

Keep TrashPal's existing provider-neutral MCP tools. Do not add `google_home.execute`, raw provider discovery, or another command escape hatch. Caretaker reasons over app-owned capabilities, constraints, plans, operations, and sanitized evidence; it does not reason over Google Home data.

The source classification is a durable contract, not enforcement evidence. The current repository does not yet connect that classification to every knowledge-ingestion, MCP, observability, analytics, logging, and deletion adapter. That downstream enforcement is a separate blocked integration requirement and must be proved before a native provider is enabled.

## Verification boundary

Credential-free CI exercises strict schemas, tenant and binding matching, exact persisted-approval failure, stable and conflicting replay, one-use mobile confirmation, expiry, consent revocation, stale leases, thermostat and energy facts, first-receipt retention, raw-field rejection, exact Ed25519 wire format, and sanitized receipts using synthetic data. CI does not resolve the native Home SDK or make a Google request.

A separate native conformance suite must use a fake Home client for deterministic tests. Credentialed validation then progresses through [Google Home Playground](https://developers.home.google.com/tools/home-playground), [Matter Virtual Device](https://developers.home.google.com/tools/virtual-device), and physical multi-vendor devices as required by Google's [testing guidance](https://developers.home.google.com/apis/android/test).

## Consequences

- The TypeScript contracts establish a safe integration seam, not live connectivity.
- A native companion, OAuth configuration, user consent, hardware validation, attestation, privacy review, and Google production approval remain separate deliverables.
- A consent revocation, stale binding, expired envelope, invalid signature, tenant mismatch, unsupported command, or missing mobile confirmation produces no device effect.
- Raw Home data must not be used as Caretaker context or exported through PostHog. The source contract records that rule, but downstream sink enforcement remains blocked until implementations and evidence exist. Any proposed exception also requires explicit policy and legal review, including written Google approval if that review determines it is required.
- Android is the first implementation target because the iOS SDK also requires App Attest and physical-device provisioning. The wire boundary remains platform-neutral.

The current implementation state and blocked prerequisites live in [the Google Home integration guide](../integrations/google-home.md).
