import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('product provenance boundary', () => {
  it('keeps the public text corpus free of audience-targeted provenance', () => {
    const textExtensions = /\.(?:md|mdx|json|ya?ml|toml|[cm]?[jt]sx?)$/u
    const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => textExtensions.test(path))
      .filter((path) => path !== 'scripts/product-provenance.test.ts')
    const positioning = paths.map(read).join('\n')

    expect(positioning).not.toMatch(/PostHog-(?:shaped|informed)/u)
    expect(positioning).not.toContain('The design adapts these PostHog sources')
    expect(positioning).not.toMatch(/(?:fake|clone of|inspired by) PostHog|PostHog clone/iu)
    expect(positioning).not.toMatch(
      /PostHog (?:house style|voice|conventions|culture|reviewer|team direction)/iu,
    )
    expect(positioning).not.toMatch(/posthog\.com\/handbook\/wizard-and-docs/u)
    expect(positioning).not.toMatch(/newsletter\.posthog\.com/u)
  })

  it('retains named product terms where the repository implements the integration', () => {
    const adapter = read('packages/observability/src/posthog-export.ts')
    const operatorGuide = read('knowledge/posthog-ai/export-agent-evidence-to-posthog.md')

    expect(adapter).toContain('PostHogEvidenceExporter')
    expect(operatorGuide).toContain('PostHog')
  })
})
