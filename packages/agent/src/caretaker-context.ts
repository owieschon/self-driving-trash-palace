import {
  ContextReceiptSchema,
  hashToolValue,
  type ContextReceipt,
  type Sha256,
} from '@trash-palace/core'

/** Canonical content identity for the exact policy, tool registry, and source set in a receipt. */
export function contextBundleHashForReceipt(receiptInput: ContextReceipt): Sha256 {
  const receipt = ContextReceiptSchema.parse(receiptInput)
  return hashToolValue({
    schemaVersion: 'caretaker-context-bundle-binding@1',
    policyHash: receipt.policyHash,
    toolRegistryHash: receipt.toolRegistryHash,
    sources: [...receipt.sources].sort((left, right) =>
      `${left.sourceId}@${left.version}`.localeCompare(`${right.sourceId}@${right.version}`),
    ),
  })
}
