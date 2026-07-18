import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { knowledgeCatalogResponse } from './knowledge-catalog-route.js'

describe('knowledge catalog route', () => {
  it('serves the pinned public catalog in its canonical learning order', async () => {
    const root = resolve(import.meta.dirname, '../../../..')
    const response = await knowledgeCatalogResponse(root)
    const body = (await response.json()) as {
      schemaVersion: string
      defaultTrack: string
      sections: { id: string; title: string; items: { sourceId: string; label: string }[] }[]
      learningPaths: { id: string; steps: { sourceId: string }[] }[]
      entries: {
        id: string
        audience: string[]
        task: string
        track: string
        prerequisites: string[]
        nextStep: { label: string; publicRoute: string } | null
        publicRoute: string
      }[]
      sources: {
        id: string
        canonicalUri: string
        sha256: string
        content: string
        section: { id: string; title: string }
      }[]
    }

    expect(response.status).toBe(200)
    expect(body.schemaVersion).toBe('knowledge-browser@2')
    expect(body.defaultTrack).toBe('start')
    expect(body.sections[0]).toMatchObject({
      id: 'start',
      title: 'Start using TrashPal',
    })
    expect(body.sections[0]?.items).toEqual([
      { sourceId: 'overview.trash-palace', label: 'What is TrashPal?' },
      { sourceId: 'getting-started.start-here', label: 'Set up your Palace workspace' },
      { sourceId: 'concept.missions-plans-operations', label: 'How a goal becomes an automation' },
    ])
    expect(body.learningPaths.find((path) => path.id === 'use')?.steps[0]?.sourceId).toBe(
      'overview.trash-palace',
    )
    const palEntry = body.entries.find((entry) => entry.id === 'procedure.use-caretaker')
    expect(palEntry?.track).toBe('automations')
    expect(palEntry?.audience).toContain('pal')
    expect(palEntry?.publicRoute).toBe('/help/procedure.use-caretaker')
    const developerEntry = body.entries.find((entry) => entry.id === 'procedure.build-http-mcp')
    expect(developerEntry).toMatchObject({
      track: 'developer',
      publicRoute: '/help/procedure.build-http-mcp',
    })
    expect(body.entries.some((entry) => entry.track === 'api_mcp')).toBe(true)
    const localStackEntry = body.entries.find((entry) => entry.id === 'getting-started.run-locally')
    expect(localStackEntry?.track).toBe('developer')
    expect(localStackEntry?.audience).not.toContain('customer')
    const haulerEntry = body.entries.find(
      (entry) => entry.id === 'procedure.schedule-hauler-access',
    )
    expect(haulerEntry?.audience).toContain('customer')
    expect(body.sources.every((source) => source.content.length > 0)).toBe(true)
    expect(body.sources.every((source) => !source.canonicalUri.startsWith('/'))).toBe(true)
    expect(body.sources.every((source) => !source.canonicalUri.includes('../'))).toBe(true)
    expect(body.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true)
    expect(body.sources.every((source) => source.section.title.length > 0)).toBe(true)
  })
})
