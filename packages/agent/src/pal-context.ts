import {
  CaretakerDecisionRequestSchema,
  CaretakerDecisionSchema,
  CaretakerFrozenContextSchema,
  CaretakerLiveStateSchema,
  createCaretakerFrozenContext,
  type CaretakerDecision,
  type CaretakerDecisionRequest,
  type CaretakerFrozenContext,
  type CaretakerLiveState,
} from './decision-engine.js'
import { contextBundleHashForReceipt } from './caretaker-context.js'

/** The public name for the bounded agent identity. Historical Caretaker contracts remain stable. */
export const PAL_AGENT_IDENTITY = 'Pal' as const

/** Public compatibility views over the one existing frozen-context and decision contract. */
export const PalDecisionSchema = CaretakerDecisionSchema
export const PalDecisionRequestSchema = CaretakerDecisionRequestSchema
export const PalFrozenContextSchema = CaretakerFrozenContextSchema
export const PalLiveStateSchema = CaretakerLiveStateSchema

export type PalDecision = CaretakerDecision
export type PalDecisionRequest = CaretakerDecisionRequest
export type PalFrozenContext = CaretakerFrozenContext
export type PalLiveState = CaretakerLiveState

export const createPalFrozenContext = createCaretakerFrozenContext
export const palContextBundleHashForReceipt = contextBundleHashForReceipt
