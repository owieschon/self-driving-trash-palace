# Export agent evidence to PostHog

Use this guide when a credentialed evaluation needs to send analytics-safe local evidence to a PostHog US or EU Cloud project.

The exporter accepts only the repository's `SafeEvidenceEvent` contract. It revalidates each event at the capture boundary, so configuration can enable transport but cannot broaden the data contract.

## Before you start

First establish [what the evidence can prove](../concepts/evidence-and-improvement.md), [instrument the local workflow](instrument-an-agentic-workflow.md), and [validate the improvement metric](validate-an-improvement-metric.md). Export transports safe evidence; it does not strengthen the underlying claim.

## Choose the evidence path

| Evidence environment | Behavior                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `test`               | Keep evidence in the in-memory sink. The exporter rejects the event.        |
| `local`              | Keep evidence in the local JSONL sink. The exporter rejects the event.      |
| `evaluation`         | Export only after the credentialed run enables and configures the boundary. |
| `hosted_demo`        | Export only after the hosted process enables and configures the boundary.   |

Omitting the enable switch creates no PostHog client. Setting it to `false` has the same result.

## Configure one Cloud region

The process must inject all three values when export is enabled:

| Variable                              | Accepted value                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `TRASH_PALACE_POSTHOG_EXPORT_ENABLED` | `true` enables export. Missing or `false` disables it.                                        |
| `TRASH_PALACE_POSTHOG_REGION`         | `us` or `eu`. The exporter derives the matching ingestion host and rejects every other value. |
| `TRASH_PALACE_POSTHOG_PROJECT_TOKEN`  | A `phc_` project token. Personal API keys are rejected.                                       |

Set the values in the credentialed process rather than committing them to an environment file:

```bash
export TRASH_PALACE_POSTHOG_EXPORT_ENABLED=true
export TRASH_PALACE_POSTHOG_REGION=us
export TRASH_PALACE_POSTHOG_PROJECT_TOKEN='<POSTHOG_PROJECT_TOKEN>'
```

## Keep analytics aliases stable

Reuse the same secret of at least 32 bytes when constructing `AnalyticsAliaser` within one evidence environment. Rotating that secret changes every analytics alias and breaks identity continuity; use a separate secret when two environments must not correlate.

Keep the alias secret separate from the PostHog project token. The alias secret stays in the producing process and never enters export messages, receipts, or public evidence.

Create the exporter from an injected environment object, then submit existing safe events:

```ts
const exporter = await createPostHogEvidenceExporterFromEnvironment(process.env)

try {
  const receipt = await exporter.exportBatch(events)
  inspectReceipt(receipt)
} finally {
  await exporter.shutdown()
}
```

The project token reaches only the client factory. Receipts and errors contain stable codes instead of client error messages.

## Read the batch receipt

Each input position receives one result, and counts derive from those ordered results:

| Status             | Meaning                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `submitted`        | `posthog-node` accepted the capture and its batch flush returned. This is not ingestion proof.                        |
| `duplicate`        | The same stable event ID and payload already reached a successful local flush. No second capture was queued.          |
| `delivery_unknown` | Capture returned, but the batch flush failed. Reuse the same event identity while reconciling the uncertain delivery. |
| `capture_failed`   | The client rejected this capture before the flush. Other events in the batch still ran.                               |
| `rejected`         | Contract validation, publication safety, local-only mode, insert-ID integrity, or lifecycle state blocked the event.  |
| `disabled`         | Export was off. The local sink remains the evidence owner.                                                            |

> **Warning:** A successful flush proves only that the SDK transport returned without error. Instead of labeling it ingestion-verified, retain the local receipt and verify the event in PostHog during the separately approved credentialed phase.

The exporter currently uses its stable event ID as `$insert_id`, but no retained receipt proves
server-side deduplication for that property. If a future exporter depends on PostHog ingestion
idempotency, pass the stable value through the Node SDK's top-level `uuid` field and verify the
behavior in the approved PostHog project before claiming it.

## Next step

[Review the evaluation methodology and limitations](../resources/evaluation-methodology-and-limitations.md).
