import { describe, expect, it } from 'vitest'

import { CaretakerEvidenceRecorder, CaretakerRunEvidence } from './caretaker-evidence.js'
import { PalEvidenceRecorder, PalRunEvidence } from './pal-evidence.js'

describe('Pal evidence compatibility surface', () => {
  it('uses the existing redacted evidence recorder and run envelope', () => {
    expect(PalEvidenceRecorder).toBe(CaretakerEvidenceRecorder)
    expect(PalRunEvidence).toBe(CaretakerRunEvidence)
  })
})
