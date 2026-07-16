# Google Home integration

This guide explains the credential-free boundary that exists today and the work required before TrashPal can control a real Google Home device.

## Current status

| Surface                                                             | Status                    | Evidence                                                                            |
| ------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| Logical binding, command envelope, and sanitized receipt schemas    | Deterministic unit-proven | Strict core schemas and synthetic conformance tests                                 |
| Safe application orchestration and replay contract                  | Deterministic unit-proven | Port-driven application tests with an in-memory atomic journal                      |
| Exact Ed25519 payload and signature format                          | Deterministic unit-proven | Fixed UTF-8 payload and RFC 8032 key/signature conformance vector                   |
| Restricted Google-derived source classification                     | Contract-defined          | Durable core type on leases and receipts                                            |
| Classification enforcement in every downstream sink                 | Blocked                   | No knowledge, MCP, observability, analytics, logging, or deletion integration yet   |
| Gateway simulator                                                   | CI default                | Existing local provider; no Google request                                          |
| Android or iOS companion                                            | Blocked                   | Not implemented; Home SDK artifact and native project are absent                    |
| OAuth, Home Permissions, device discovery, state reads, and control | Blocked                   | No Google project, native client, test-user consent, credential, or device evidence |
| Physical-device behavior, latency, quota use, and stability         | Blocked                   | No credentialed hardware run                                                        |
| Production registration and distribution                            | Blocked                   | Google currently marks app registration and store launch as coming soon             |
| Google-derived data in Caretaker, MCP, analytics, or logs           | Prohibited by policy      | Contract records the rule; downstream enforcement is not implemented                |

Do not describe the current repository as connected to Google Home. It contains a production-oriented contract and policy seam whose tests require no credentials.

## What the official APIs support

Google documents Home APIs for [Android](https://developers.home.google.com/apis/android/get-started) and [iOS](https://developers.home.google.com/apis/ios/get-started). A consented native app can:

- enumerate the one structure the user grants and its logical rooms and devices;
- read device traits and subscribe to state changes with the [Device API](https://developers.home.google.com/apis/android/device);
- check command support and issue supported commands with the [Control API](https://developers.home.google.com/apis/android/device/control); and
- create supported durable routines with the [Automation API](https://developers.home.google.com/apis/android/automation).

The public SDK remains a native mobile dependency. Google's current [official Android sample](https://github.com/google-home/google-home-api-sample-app-android) consumes `play-services-home` and `play-services-home-types` 17.1.0 from Google's Maven repository, while the older [Android SDK setup page](https://developers.home.google.com/apis/android/sdk) still describes a signed-in download. Pin and verify the current published artifacts instead of relying on that stale setup instruction. Integration work still requires a physical Android 10-or-newer device. The [iOS SDK setup](https://developers.home.google.com/apis/ios/sdk) requires iOS 17 or newer, provisioning, App Groups, App Attest, and a physical device rather than the iOS Simulator.

Cloud-to-cloud is not a shortcut for this use case. It lets a device provider expose its own devices to Google through SYNC, QUERY, and EXECUTE fulfillment. It does not let the TrashPal server enumerate another provider's devices from a user's existing home.

Google's Home Developers MCP endpoint is also not a device gateway. Its documented tool searches Home developer documentation. TrashPal keeps its existing `capabilities.list`, approval, activation, operation, and evidence tools instead of presenting a Google-specific MCP command.

## Runtime boundary

```text
Caretaker / MCP
      |
      | app-owned capabilities, exact approved plan, operation ID
      v
TrashPal backend
      |
      | signed + expiring logical command envelope
      v
Android or iOS companion
      |
      | local OAuth, permission, binding, support, and freshness checks
      v
Google Home SDK -> selected structure and device
      |
      | sanitized signed outcome only
      v
TrashPal operation and evidence pipeline
```

The native companion is the only component that may hold:

- Google OAuth material;
- raw structure, room, and device identifiers;
- user-assigned Google device or room names;
- raw traits, attributes, events, and SDK responses; or
- the local map from a Google device identifier to a TrashPal logical binding.

The typed boundary accepts only strict allowlisted records:

- a signed five-minute logical binding lease;
- a signed command envelope with one stable gateway command ID and expiry;
- a signed sanitized receipt with a bounded outcome and error code;
- a `google_home_derived_restricted` source classification on every lease and receipt; and
- a deletion deadline no more than ten days after the first Google-derived record is written.

There is no `metadata`, provider payload, or free-form error field. Unknown properties fail schema validation. Keep these records out of model prompts, PostHog events, MCP responses, logs, and traces.

The classification tag does not enforce that last sentence by itself. Adapters for knowledge ingestion, MCP, observability, analytics, logs, retention deletion, and any future data export must reject the classification and retain test evidence. Those adapters do not exist yet, so downstream enforcement remains blocked.

## Application orchestrator

`GoogleHomeNativeCompanionBoundaryService` is the only safe dispatch entry point defined by the TypeScript seam. It cannot execute with a caller-supplied bag of trusted booleans or a caller-chosen timestamp. Its constructor requires seven authority and effect ports plus a trusted clock:

| Port                            | Required production property                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Persisted approval verification | Reads durable state and matches tenant, palace, mission, operation, approval, plan hash, command ID, and payload hash             |
| Key-to-tenant signature trust   | Resolves each binding, envelope, and receipt key to its tenant before accepting the signature                                     |
| Atomic replay journal           | Compares the canonical request hash, serializes concurrent calls, and stores the verified first receipt before returning          |
| One-use mobile confirmation     | Atomically validates and consumes command-bound secure confirmation for unlock                                                    |
| Native checks                   | Rechecks consent, local binding, command support, native safety, thermostat bounds, and energy budget immediately before dispatch |
| Private native dispatch         | May use raw SDK data internally but returns only the strict sanitized receipt                                                     |
| Receipt verification            | Verifies the sanitized outcome before the journal retains it                                                                      |
| Trusted clock                   | Supplies dispatch time independently of the request                                                                               |

The repository defines these interfaces and proves their orchestration with fakes. It does not contain production adapters for them.

## Dispatch sequence

1. The user signs into Google in the native companion and grants Home access through Google's Permissions API. Access is structure-scoped, and sensitive devices require additional grants. See [OAuth setup](https://developers.home.google.com/apis/android/oauth) and [Permissions](https://developers.home.google.com/apis/android/permissions).
2. The user explicitly maps a supported Google device to a TrashPal logical slot. The companion keeps the provider identifier locally and emits a signed short-lived logical binding lease.
3. Caretaker works against the existing app-owned capability. It proposes and validates a plan; a human approves the exact plan hash. The orchestrator verifies that exact approval against persisted state rather than trusting the envelope alone.
4. The backend derives one stable gateway command and signs an envelope whose idempotency key is that command ID. A retry reuses the same envelope identity. A key registry independently resolves the signature key to the tenant.
5. The journal atomically reserves the command ID and canonical request hash. A completed exact replay returns its retained first receipt. A different request with the same ID fails before dispatch.
6. Immediately before first dispatch, the companion verifies active consent, the unexpired local binding, supported trait and command, native device safety, and unexpired authority. Temperature requires passed configured thermostat bounds and energy budget; lighting requires a passed energy budget. Missing and unknown facts reject the command without an effect.
7. For unlock, the companion atomically consumes a fresh device credential or user PIN confirmation. Arrival evidence, model output, an approved plan, and a background automation are not substitutes. A different command cannot reuse that confirmation.
8. The private adapter executes the supported SDK command, reads the resulting state when the API permits, and emits only a signed sanitized outcome. An ambiguous response remains `unknown`; it is never promoted to success.
9. The orchestrator verifies the receipt signature, key-to-tenant trust, exact tenant, palace, binding, device, capability, command, idempotency, chronology, source class, and sanitized outcome before the journal retains it.

## Credential-free verification

Run the boundary tests without a Google account, SDK, or network request:

```bash
pnpm exec vitest run \
  packages/core/src/__tests__/google-home-native-companion.test.ts \
  packages/application/src/__tests__/google-home-native-companion-boundary.test.ts
```

The suite uses synthetic identifiers and states. It proves:

- extra raw-provider fields are rejected;
- tenant, palace, logical binding, device, capability, command, and receipt mismatches are rejected;
- the command ID remains the idempotency key;
- exact replay returns the first receipt without redispatch, while a changed request conflicts;
- persisted approval mismatch fails before native dispatch;
- signatures are exactly 64-byte Ed25519 values and one fixed vector is byte-for-byte reproducible;
- binding leases and envelopes expire;
- consent is rechecked and revocation fails closed;
- unlock needs a current, command-bound, single-use secured-mobile confirmation;
- thermostat and energy safety checks are explicit and fail closed;
- a receipt is signed, sanitized, matching, chronological, and retained from its first recording time; and
- no Google-specific tool is added to the MCP registry.

This suite does not prove OAuth, SDK compatibility, user consent, device discovery, state accuracy, command execution, hardware behavior, or production approval.

## Credentialed validation ladder

Do not skip directly from synthetic tests to a claimed production integration.

1. Build a native facade against pinned current Home SDK artifacts and retain fake-client unit coverage.
2. Configure a test-only Google Cloud project, OAuth consent screen, native client, and named test users.
3. Exercise discovery, reads, subscriptions, supported-command checks, consent revocation, and sanitized receipts against [Google Home Playground](https://developers.home.google.com/tools/home-playground).
4. Commission a [Matter Virtual Device](https://developers.home.google.com/tools/virtual-device) and verify reconnect, stale state, duplicate delivery, timeout, and revocation behavior.
5. Repeat the supported flows on physical devices from more than one manufacturer, with a supported hub where the device type requires one. Google's testing guidance states that virtual devices alone are insufficient.
6. Measure live latency, failure classes, and request volume. Apply exponential backoff against the documented [30,000-query-per-minute project quota](https://developers.home.google.com/apis/android/quota-management).
7. Complete privacy, security, data-deletion, secondary-verification, and Google review evidence before enabling non-test users.

Retain only a sanitized test receipt. Do not retain OAuth tokens, raw Home identifiers, user-assigned names, prompts containing Home data, screenshots of a user's home, or raw SDK payloads.

## Blocked external prerequisites

The following work remains **Blocked** until each external dependency exists:

- **Home SDK verification:** pin the current Android Maven artifacts or iOS SDK, confirm their licenses and distribution requirements, and verify the native build on the supported toolchain.
- **Native application:** create the Android or iOS companion, secure its local storage, and implement platform attestation and the local binding map.
- **Google project:** create the Cloud project, OAuth consent screen, native OAuth client, signing certificate or iOS provisioning configuration, and test-user allowlist.
- **User authorization:** complete Google Sign-In and the Home Permissions flow for one selected structure and every sensitive device used by a test.
- **Test equipment:** obtain a physical supported phone, Wi-Fi environment, Google Home app, supported hub where required, and representative real devices.
- **Trust material:** provision separate backend and companion signing keys, rotation, revocation, attestation, and replay protection. No key or token belongs in this repository.
- **Production boundary adapters:** implement persisted approval lookup, tenant-scoped key trust, durable atomic replay, secure one-use confirmation, native safety checks, private SDK dispatch, and receipt verification behind the existing ports.
- **Classification enforcement:** wire `google_home_derived_restricted` rejection and deletion behavior into knowledge ingestion, MCP, observability, analytics, logging, retention jobs, and every future export, then retain end-to-end evidence.
- **Policy review:** confirm the privacy policy, consent copy, deletion process, secondary user verification, security-update commitment, and use of any Google-derived receipt with counsel and Google requirements.
- **AI/data approval:** obtain the policy and legal determination, including written Google approval if required, before allowing any Google Home integration data into Caretaker, another model-related tool, MCP, PostHog, logs, or traces.
- **Hardware evidence:** complete Playground, virtual-device, and physical multi-vendor runs with redacted receipts.
- **Production registration:** register and obtain approval for the Home APIs application when Google makes registration and store launch available. The [current getting-started page](https://developers.home.google.com/apis/android/get-started) marks both steps as coming soon.

Until these prerequisites are complete, the simulator is the only executable provider and real Google Home connectivity remains unverified.

## Policy sources

Read these primary sources before changing the boundary:

- [Google Home Developer policies](https://developers.home.google.com/policies)
- [Home APIs overview](https://developers.home.google.com/apis)
- [Android OAuth](https://developers.home.google.com/apis/android/oauth)
- [Android Permissions API](https://developers.home.google.com/apis/android/permissions)
- [Official Android sample](https://github.com/google-home/google-home-api-sample-app-android)
- [Android SDK release notes](https://developers.home.google.com/apis/android/release-notes)
- [Blocked Automation API actions](https://developers.home.google.com/apis/android/automation/blocked-actions)
- [Home APIs testing](https://developers.home.google.com/apis/android/test)
- [Google Home Developers MCP](https://developers.home.google.com/reference/home-developers/mcp)

The rationale for this shape is recorded in [ADR 0007](../decisions/0007-google-home-native-companion-boundary.md).
