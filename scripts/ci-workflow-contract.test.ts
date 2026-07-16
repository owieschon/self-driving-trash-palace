import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workflowPath = resolve(import.meta.dirname, '../.github/workflows/ci.yml')

describe('CI workflow contract', () => {
  it('keeps every job on the pinned Ubuntu runner with least-privilege defaults', async () => {
    const workflow = await readFile(workflowPath, 'utf8')
    const runners = [...workflow.matchAll(/runs-on:\s*([^\n]+)/g)].map((match) => match[1]?.trim())

    expect(runners.length).toBeGreaterThanOrEqual(5)
    expect(new Set(runners)).toEqual(new Set(['ubuntu-24.04']))
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toMatch(/permissions:\s*write-all/)
    expect(workflow).toContain('persist-credentials: false')
  })

  it('pins third-party actions and the PostgreSQL service by immutable digest', async () => {
    const workflow = await readFile(workflowPath, 'utf8')
    const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1] ?? '')

    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((action) => /@[a-f0-9]{40}$/.test(action))).toBe(true)
    expect(workflow).toMatch(/image:\s*postgres:[^@\s]+@sha256:[a-f0-9]{64}/)
  })

  it('does not grant Endor OIDC to forks or Dependabot', async () => {
    const workflow = await readFile(workflowPath, 'utf8')

    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(workflow).toContain("github.event.pull_request.user.login != 'dependabot[bot]'")
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('disable_code_snippet_storage: true')
    expect(workflow).toContain('endorctl_checksum:')
  })
})
