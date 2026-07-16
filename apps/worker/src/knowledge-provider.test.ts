import { resolve } from 'node:path'

import { TOOL_REGISTRY_HASH } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { FilesystemCaretakerKnowledgeProvider } from './knowledge-provider.js'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')

describe('filesystem Caretaker knowledge provider', () => {
  it('loads a hash-verified, public-only repository snapshot', async () => {
    const provider = await FilesystemCaretakerKnowledgeProvider.create({
      repositoryRoot: REPOSITORY_ROOT,
      applicationVersion: '0.0.0',
    })
    const snapshot = await provider.load({ signal: new AbortController().signal })

    expect(snapshot.publicOnly).toBe(true)
    expect(snapshot.optionalSourceIds).toEqual([])
    expect(snapshot.manifest.toolRegistry.sha256).toBe(TOOL_REGISTRY_HASH)
    expect(Object.keys(snapshot.sourceContents)).toHaveLength(snapshot.catalog.sources.length)
    expect(snapshot.catalog.sources.every((source) => source.visibility === 'public')).toBe(true)
  })

  it('observes an already-aborted load without returning retained content', async () => {
    const provider = await FilesystemCaretakerKnowledgeProvider.create({
      repositoryRoot: REPOSITORY_ROOT,
      applicationVersion: '0.0.0',
    })
    const abort = new AbortController()
    abort.abort(new Error('shutdown'))

    await expect(provider.load({ signal: abort.signal })).rejects.toThrow('shutdown')
  })
})
