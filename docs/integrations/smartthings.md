# SmartThings integration

This guide defines the credential-free server connector that exists today and the work required before TrashPal can control a real SmartThings device.

## Current status

| Surface                                                              | Status                    | Evidence                                                                                         |
| -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| Provider-neutral logical-device, state, command, and receipt schemas | Deterministic unit-proven | Strict Zod contracts in `@trash-palace/connectors`                                               |
| SmartThings OAuth authorization-code request and callback boundary   | Deterministic unit-proven | One-time tenant/session-bound state tests; synthetic token responses                             |
| Device-specific read and execute scopes                              | Deterministic unit-proven | Authorization URL requests `r:devices:$` and `x:devices:$`                                       |
| Token refresh rotation and uninstall cleanup ports                   | Deterministic unit-proven | Synthetic single-use rotation and verified DELETE lifecycle tests                                |
| Paginated discovery and opaque candidate projection                  | Deterministic unit-proven | Multi-page, no-auto-mapping, explicit-human-mapping, and cross-origin next-link tests            |
| Status reads and allowlisted projection                              | Deterministic unit-proven | Light, lock, and thermostat state fixtures                                                       |
| Command safety and outcome reconciliation                            | Deterministic unit-proven | Gateway-command identity, retry-safe unlock, ambient convergence, durable lighting, and webhooks |
| HTTP, Caretaker, and MCP composition                                 | Blocked                   | No production application adapter or route uses this package yet                                 |
| Encrypted production credential vault and durable journals           | Blocked                   | Ports exist; no production adapter exists                                                        |
| SmartThings webhook RSA-SHA256 verifier and public-key cache         | Blocked                   | Verification is mandatory at the port; the cryptographic adapter is absent                       |
| SmartThings app registration, OAuth, subscriptions, and real devices | Blocked                   | No registered app, approved user, credential, public callback, or hardware evidence              |
| Live latency, quotas, command accuracy, and webhook reliability      | Blocked                   | No credentialed run has occurred                                                                 |

Do not describe TrashPal as connected to SmartThings. The repository contains a production-shaped adapter and credential-free contract evidence; the deterministic gateway simulator remains the executable default.

## Why this provider shape works

SmartThings [Service Integrations](https://developer.smartthings.com/docs/getting-started/what-you-can-build) are server-accessible API Access Apps. After a user authorizes selected devices, a server can discover them, read their status, send commands, and receive subscribed events. That is the direction TrashPal needs: the customer links devices they already use instead of exposing TrashPal-owned hardware to another ecosystem.

The official API Access Apps pages currently carry a notice that parts of the refreshed experience are still coming soon. The [June 30, 2026 release note](https://developer.smartthings.com/docs/release-notes) introduces this path. Registration and a real integration remain external validation work, not an assumption hidden behind mocks.

## Runtime boundary

```text
Caretaker / MCP / HTTP
        |
        | tenant + logical slot + allowlisted action
        v
TrashPal application policy and operation ledger
        |
        | provider-neutral DeviceConnectorPort
        v
SmartThingsConnector
        |
        | tenant-scoped mapping + credential-vault lease
        v
SmartThings REST API  <---- verified SmartThings webhook
        |
        | ACCEPTED is non-terminal
        v
read-after-write reconciliation -> TrashPal operation receipt
```

Caretaker, MCP, PostHog, logs, and reader-facing APIs may receive only:

- a TrashPal logical slot such as `entry-light`;
- the allowlisted device class and capabilities;
- the sanitized state needed for the task;
- the gateway command identifier or a deterministic lighting child-command identifier; and
- `accepted_non_terminal`, `outcome_unknown`, or `verified`.

They must never receive access tokens, refresh tokens, installed-app IDs, SmartThings device or location IDs, user-assigned provider labels, provider command IDs, raw status payloads, webhook payloads, or free-form provider errors. The package returns fixed error codes instead of provider response bodies.

## Authorization

Production access uses SmartThings' documented [OAuth 2.0 authorization-code flow](https://developer.smartthings.com/docs/service-integrations/oauth). Personal access tokens are not the product path.

1. TrashPal creates a random state and stores only its digest with the tenant, browser-session binding, exact redirect URI, and ten-minute expiry.
2. The browser is sent to `/v1/oauth/authorize` with the registered redirect URI and `r:devices:$ x:devices:$`.
3. SmartThings asks the user to select the devices the app may read and execute. The narrower `$` scopes avoid granting every device. The available scope behavior is documented in [API Access App Setup](https://developer.smartthings.com/docs/service-integrations/app-setup#oauth-scopes).
4. The callback atomically consumes the exact state. A different tenant, session, digest, redirect URI, expired state, or replay fails before token exchange.
5. The server exchanges the code through `/v1/oauth/token` with HTTP Basic client authentication.
6. The credential vault stores the access token, refresh token, installed-app ID, granted scopes, expiry, and revision. The public result contains none of them.

SmartThings' current OAuth page does not document `code_challenge`, `code_challenge_method`, or `code_verifier`. The adapter therefore does not invent PKCE support. It records `SMARTTHINGS_PKCE_SUPPORT = "not_documented"` and relies on a confidential server client, exact redirect registration, and one-time state binding. Re-check the official OAuth contract before a live registration; add PKCE only after SmartThings documents and verifies it.

The [token-management contract](https://developer.smartthings.com/docs/service-integrations/token-management) says refresh tokens are single-use and both tokens rotate. The vault port serializes refresh per tenant and replaces both values under one expected revision. A verified SmartThings DELETE lifecycle webhook removes the credential for the matching tenant and installed app.

## Discovery and explicit logical-device mapping

`GET /v1/devices` returns only devices granted during authorization. SmartThings' [pagination contract](https://developer.smartthings.com/docs/service-integrations/api-overview#pagination-of-responses) puts the next URL in `_links.next.href`; the adapter follows every page, detects loops, caps traversal, and rejects a next link unless it remains on `https://api.smartthings.com/v1/devices`.

Discovery records each supported component as an opaque candidate. The mapping repository assigns a keyed `stcand_…` identifier instead of exposing or directly hashing provider identifiers. A public candidate contains only that identifier and allowlisted capabilities. It does not contain a SmartThings identifier, provider label, logical device type, logical slot, or automatic recommendation.

A candidate cannot be read or controlled. A human must explicitly link it to a logical device that already exists in TrashPal:

```text
(tenant, SmartThings device ID, component ID) -> opaque candidate
                                                   |
                                      explicit human confirmation
                                                   |
                                                   v
                                existing TrashPal logical device
```

The connector rejects a missing logical device, an agent-authored confirmation, and any mapping whose existing logical-device capabilities are not a subset of the candidate capabilities. The provider side of the completed mapping stays in the connector repository. The public logical device uses an app-owned display name and one of these allowlisted capability shapes:

| Logical class | SmartThings capability      | TrashPal capability          |
| ------------- | --------------------------- | ---------------------------- |
| Light         | `switch`                    | `light.power`                |
| Light         | `switchLevel`               | `light.brightness`           |
| Lock          | `lock`                      | `lock.state`                 |
| Thermostat    | `temperatureMeasurement`    | `thermostat.temperature`     |
| Thermostat    | `thermostatMode`            | `thermostat.mode`            |
| Thermostat    | `thermostatHeatingSetpoint` | `thermostat.heatingSetpoint` |
| Thermostat    | `thermostatCoolingSetpoint` | `thermostat.coolingSetpoint` |

Unknown capabilities are not forwarded as generic data and cannot become generic commands. A provider label or identifier cannot be supplied through a discovery result, mapping request, or command input.

## Reads and commands

Status reads use `GET /v1/devices/{deviceId}/status`, validate the extensible provider envelope, and copy only known scalar attributes into the strict logical state. SmartThings documents the device and status shapes in [Query and List Devices](https://developer.smartthings.com/docs/service-integrations/query-and-list-devices).

Commands use the exact capability vocabulary maintained by SmartThings:

| Logical action                  | Provider command                               | Product constraint                                           |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `light.setPower`                | `switch.on` or `switch.off`                    | Durable sequence child; explicit target state; no toggle     |
| `light.setBrightness`           | `switchLevel.setLevel`                         | Durable sequence child; integer from 1 through 100           |
| `lock.lock`                     | `lock.lock`                                    | Bound to a tenant slot and gateway command                   |
| `lock.unlock`                   | `lock.unlock`                                  | Fresh confirmation bound idempotently to one gateway command |
| `thermostat.setHeatingSetpoint` | `thermostatHeatingSetpoint.setHeatingSetpoint` | Unit match; heat-capable mode; ambient convergence required  |
| `thermostat.setCoolingSetpoint` | `thermostatCoolingSetpoint.setCoolingSetpoint` | Unit match; cool-capable mode; ambient convergence required  |

The setpoint limits are TrashPal policy, intentionally narrower than SmartThings' generic production capability schema. A matching setpoint echo is not completion: reconciliation also requires a fresh ambient-temperature reading within 0.5 °C or 1 °F of the target and a mode that can drive toward it (`heat`, `emergency heat`, or `auto` for heating; `cool` or `auto` for cooling). SmartThings' current capability vocabulary is listed in [Production Capabilities](https://developer.smartthings.com/docs/devices/capabilities/capabilities-reference).

Every direct command first claims `(tenant, gateway command ID, logical slot, canonical sanitized-command digest)` in a durable journal. The parent core operation ID is not accepted as a connector idempotency key because one operation can materialize several gateway commands. An exact retry returns the retained receipt; a changed command with the same gateway command ID conflicts. SmartThings does not document an idempotency key for the command endpoint, so the adapter does not send an invented header. A transport failure after the request may have left the server is `outcome_unknown` and is reconciled instead of resent.

An unlock request carries a short-lived confirmation only to an authority port. That port atomically consumes the confirmation or returns the grant already bound to the same gateway command. The command journal retains `lock.unlock` and its normalized routing fields, never the confirmation value. A definite provider rejection can therefore be retried under the same gateway command without either reusing the confirmation for a different command or persisting authority material.

A duration-bound lighting request is not translated into hidden sequential HTTP calls. Before the first call, the lighting-plan store atomically retains three ordered children with deterministic IDs derived from the parent gateway command:

1. turn power on;
2. set brightness after the power-on child is verified; and
3. turn power off after the brightness child is verified and the requested duration has elapsed.

The connector rejects an unpersisted child, an out-of-order child, a child with the wrong derived ID, and an early scheduled-off child. This makes a process restart recoverable instead of silently losing the off action.

SmartThings explicitly says a command response with `ACCEPTED` means queued, not completed. The adapter returns `accepted_non_terminal` and keeps reconciliation required. See [Control Devices](https://developer.smartthings.com/docs/service-integrations/control-devices#confirming-state-changes).

## Webhooks and reconciliation

SmartThings signs webhooks with RSA-SHA256 over `(request-target)`, `digest`, and `date`. The official [verification sequence](https://developer.smartthings.com/docs/service-integrations/webhook-events#request-verification) requires retrieving the key named by `keyId`, reconstructing the signing string, verifying the signature, and matching the SHA-256 body digest.

The connector refuses to parse a webhook or resolve an installation until the injected verifier returns success. It also enforces the exact route and a bounded signed date. `handleWebhook` accepts the raw request only; it does not accept a caller-provided tenant. After verification and strict body parsing, the credential vault resolves the installed-app identity to the tenant. The production verifier still needs a key-fetch allowlist, cache and rotation policy, replay tests, and fail-closed network behavior.

A verified device event is a hint, not proof of final command state:

1. Match the webhook's installed-app ID to the tenant credential.
2. Claim the tenant-scoped delivery digest under a fenced 60-second processing lease. Only a completed receipt is a duplicate; a live claim returns a retryable busy result, a failed handler releases its claim, and an expired claim can be recovered.
3. Resolve each provider device through the private mapping store.
4. Read current state from SmartThings instead of trusting the webhook value.
5. Mark only matching pending connector commands `verified`.
6. Return only sanitized logical states and connector command IDs.

DELETE lifecycle handling retains a minimal credential-vault revocation tombstone keyed to the tenant and installed-app identity. It contains no token. If a process stops after deleting tokens but before completing the webhook receipt, a retry can recover the expired claim, recognize that exact installation as already revoked, and complete the delivery. A different installation identifier still fails the tenant boundary.

Subscriptions are scoped to an installed app and documented in [Subscribe to Events](https://developer.smartthings.com/docs/service-integrations/subscribe-to-events). A production composition should create device subscriptions only after authorization and retain their lifecycle separately from tokens.

## Failure classification

| Provider outcome                           | Connector meaning               | Action                                                                               |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| `401`                                      | Access token expired or invalid | Rotate once under the tenant refresh lock, then retry the authenticated request once |
| `403`                                      | Granted access is insufficient  | Stop and ask the user to reconnect or change selection                               |
| `404`                                      | Provider device is absent       | Reconcile mappings; do not remap automatically                                       |
| `429`                                      | Rate limited                    | Use `x-ratelimit-reset` as a bounded millisecond delay                               |
| Read transport error or `5xx`              | Temporary read failure          | Retry with bounded backoff outside the adapter                                       |
| Command transport error or ambiguous `5xx` | Outcome unknown                 | Keep the operation pending and reconcile; do not resend                              |
| Invalid provider JSON                      | Contract failure                | Fail closed without storing or returning the raw body                                |

SmartThings documents endpoint-specific limits and `x-ratelimit-reset` in [API Overview and Request Patterns](https://developer.smartthings.com/docs/service-integrations/api-overview#rate-limiting). The adapter classifies the signal; the worker remains responsible for bounded jitter, retry budget, and alerting.

## Why direct HTTP is deliberate

The first adapter uses an injected Fetch-compatible port instead of adding an SDK. The implemented surface is small, the official REST contract is explicit, and direct HTTP keeps token rotation, next-link validation, non-terminal command semantics, and redaction visible in tests. It also avoids granting a large SDK access to the credential boundary before the product composition exists.

Reconsider an official SDK only if it materially improves supported OAuth, signature verification, schema maintenance, or retry correctness. Convenience wrappers alone do not justify moving this security boundary.

## Credential-free verification

Run the package checks without an account, credential, network request, or device:

```bash
pnpm --filter @trash-palace/connectors typecheck
pnpm exec eslint packages/connectors --max-warnings=0
pnpm --filter @trash-palace/connectors test
```

The tests prove contract behavior against synthetic provider responses. They do not prove SmartThings registration, OAuth interoperability, token lifetime, API availability, command execution, event delivery, quota behavior, physical-device state, or production safety.

## Production integration sequence

1. Implement encrypted, tenant-scoped adapters for the credential vault, OAuth state, candidate and provider mapping, command journal, unlock-authority grant, lighting-plan, logical-device catalog, and webhook receipt ports.
2. Implement and adversarially test the RSA-SHA256 webhook verifier against SmartThings keys, digest mismatch, stale dates, key rotation, key-fetch SSRF, duplicate delivery, and invalid signatures.
3. Compose the connector behind application services. HTTP, Caretaker, and MCP must accept only logical slots and existing operation authority; none may call provider methods with arbitrary capability or command strings.
4. Register a test-only API Access App with exact redirect and target URLs. Request only `r:devices:$` and `x:devices:$`; do not request location read scope when the installed-app endpoint can supply the needed location ID.
5. Link named test users and selected test devices. Retain a sanitized receipt that proves granted scope behavior without retaining tokens, provider IDs, labels, or raw payloads.
6. Create subscriptions, exercise signed device and DELETE lifecycle callbacks, rotate tokens, revoke access, and verify cleanup.
7. Test representative light, lock, and thermostat devices across timeout, offline, stale-state, duplicate-event, response-loss, and rate-limit cases. Unlock must retain evidence of fresh human confirmation without retaining the confirmation secret.
8. Measure live latency, command convergence, webhook lag, refresh reliability, request volume, and failure distribution. Define retry budgets from evidence.
9. Complete privacy, threat-model, incident-response, credential-rotation, deletion, and support reviews before enabling non-test users.

Until that sequence is complete, SmartThings connectivity is **Blocked** and the gateway simulator remains the only supported runtime provider.
