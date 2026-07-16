import {
  AnalyticsAliaser,
  InMemoryEvidenceSink,
  SafeApplicationEvidenceAdapter,
} from '@trash-palace/observability'
import type { InMemoryApplicationStore } from '../testing/fakes.js'

export function createApplicationEvidenceHarness() {
  const sink = new InMemoryEvidenceSink()
  const observability = new SafeApplicationEvidenceAdapter({
    sink,
    aliaser: new AnalyticsAliaser('application-evidence-test-key-at-least-32-bytes'),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: 'application-evidence-test',
  })
  return { observability, sink }
}

export async function applicationProductEvents(store: InMemoryApplicationStore) {
  return (await store.snapshot()).productEvidenceDeliveries.map(
    (delivery) => delivery.envelope.event,
  )
}
