import { describe, expect, it } from 'vitest'

import { CaretakerLifecycleHost } from './caretaker-host.js'
import { PalLifecycleHost } from './pal-host.js'
import {
  getCaretakerHostPolicyContract,
  getPalHostPolicyContract,
  hashHostPolicyContract,
  hashPalHostPolicyContract,
  projectHostPolicy,
  projectPalHostPolicy,
} from './host-policy.js'

describe('Pal host compatibility surface', () => {
  it('uses the existing bounded lifecycle host rather than a second agent loop', () => {
    expect(PalLifecycleHost).toBe(CaretakerLifecycleHost)
  })

  it('keeps Pal on the exact existing tool and authority contract', () => {
    const caretaker = getCaretakerHostPolicyContract()
    const pal = getPalHostPolicyContract()

    expect(pal).toEqual(caretaker)
    expect(hashPalHostPolicyContract()).toBe(hashHostPolicyContract())
    expect(projectPalHostPolicy(hashPalHostPolicyContract())).toEqual(
      projectHostPolicy(hashHostPolicyContract()),
    )
    expect(pal.tools.map((tool) => tool.toolId)).toEqual(caretaker.tools.map((tool) => tool.toolId))
    expect(pal.tools.some((tool) => tool.toolId === 'plans.activate')).toBe(true)
    const toolIds: readonly string[] = pal.tools.map((tool) => tool.toolId)
    expect(toolIds).not.toContain('plans.approve')
  })
})
