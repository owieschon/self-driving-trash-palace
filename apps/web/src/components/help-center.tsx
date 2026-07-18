'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Button } from './relay'

/**
 * The reader-facing projection of the canonical knowledge catalog. The catalog
 * remains the source of truth for content, order, routes, and search labels.
 */
export function HelpCenter({
  initialSourceId,
  onSelectSource,
}: {
  initialSourceId: string | null
  onSelectSource: (sourceId: string) => void
}) {
  const [catalog, setCatalog] = useState<KnowledgeBrowser | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [expandedSectionIds, setExpandedSectionIds] = useState<readonly string[]>([])
  const loadSequence = useRef(0)

  const loadCatalog = useCallback(async () => {
    const sequence = loadSequence.current + 1
    loadSequence.current = sequence
    setError(null)
    setIsLoading(true)

    try {
      const response = await fetch('/api/v1/knowledge')
      if (!response.ok) throw new Error('Knowledge catalog unavailable')
      const value = (await response.json()) as KnowledgeBrowser
      if (sequence !== loadSequence.current) return

      const defaultSection =
        value.sections.find((section) => section.id === value.defaultTrack) ?? value.sections[0]
      const nextSelectedId = initialSourceId ?? defaultSection?.items[0]?.sourceId ?? null
      const selectedSection = value.sections.find((section) =>
        section.items.some((item) => item.sourceId === nextSelectedId),
      )
      setCatalog(value)
      setSelectedId(nextSelectedId)
      setExpandedSectionIds(selectedSection === undefined ? [] : [selectedSection.id])
    } catch {
      if (sequence !== loadSequence.current) return
      setError('Help could not load the current guide catalog. Try again shortly.')
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false)
    }
  }, [initialSourceId])

  useEffect(() => {
    void loadCatalog()
    return () => {
      loadSequence.current += 1
    }
  }, [loadCatalog])

  const source = catalog?.sources.find((candidate) => candidate.id === selectedId) ?? null
  const entry = catalog?.entries.find((candidate) => candidate.id === selectedId) ?? null
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleSections = useMemo(
    () =>
      catalog?.sections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => {
            if (normalizedQuery.length === 0) return true
            const entry = catalog.entries.find((entry) => entry.id === item.sourceId)
            const source = catalog.sources.find((source) => source.id === item.sourceId)
            return `${item.label} ${entry?.searchLabel ?? ''} ${source?.content ?? ''}`
              .toLocaleLowerCase()
              .includes(normalizedQuery)
          }),
        }))
        .filter((section) => section.items.length > 0) ?? [],
    [catalog, normalizedQuery],
  )
  const visibleItemCount = visibleSections.reduce(
    (total, section) => total + section.items.length,
    0,
  )
  const defaultSourceId =
    catalog?.sections.find((section) => section.id === catalog.defaultTrack)?.items[0]?.sourceId ??
    catalog?.sections[0]?.items[0]?.sourceId ??
    null

  const selectSource = (sourceId: string) => {
    setSelectedId(sourceId)
    const section = catalog?.sections.find((candidate) =>
      candidate.items.some((item) => item.sourceId === sourceId),
    )
    if (section !== undefined) {
      setExpandedSectionIds((current) =>
        current.includes(section.id) ? current : [...current, section.id],
      )
    }
    onSelectSource(sourceId)
  }

  const toggleSection = (sectionId: string, open: boolean) => {
    setExpandedSectionIds((current) => {
      if (open) return current.includes(sectionId) ? current : [...current, sectionId]
      return current.filter((candidate) => candidate !== sectionId)
    })
  }

  return (
    <section className="help-center" aria-label="Help center">
      <aside className="help-center__browse" aria-label="Knowledge sections">
        <label className="help-center__search">
          <span>Search Help</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a guide"
          />
        </label>
        {normalizedQuery.length > 0 && catalog !== null && (
          <p className="help-center__result-count" aria-live="polite">
            {visibleItemCount === 1 ? '1 guide found' : `${visibleItemCount} guides found`}
          </p>
        )}
        <div className="help-center__sections">
          {visibleSections.map((section) => {
            const isOpen = normalizedQuery.length > 0 || expandedSectionIds.includes(section.id)
            return (
              <details
                className="help-center__section"
                key={section.id}
                open={isOpen}
                onToggle={(event) => toggleSection(section.id, event.currentTarget.open)}
              >
                <summary>
                  <span>{section.title}</span>
                  <small>{section.items.length}</small>
                </summary>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.sourceId}>
                      <button
                        type="button"
                        className={selectedId === item.sourceId ? 'is-selected' : ''}
                        aria-current={selectedId === item.sourceId ? 'page' : undefined}
                        onClick={() => selectSource(item.sourceId)}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )
          })}
        </div>
        {catalog === null && error === null && isLoading && (
          <p className="help-center__status">Loading Help…</p>
        )}
        {catalog !== null && visibleSections.length === 0 && (
          <p className="help-center__status">No Help guides match that search.</p>
        )}
      </aside>
      <article className="help-center__article" aria-live="polite">
        {catalog === null && error === null && isLoading && (
          <p className="help-center__status">Loading the selected guide…</p>
        )}
        {error !== null && (
          <div role="alert">
            <p>{error}</p>
            <Button variant="secondary" onClick={() => void loadCatalog()} disabled={isLoading}>
              Retry
            </Button>
          </div>
        )}
        {catalog !== null && source === null && error === null && (
          <div className="help-center__unavailable">
            <span className="section-label">Help</span>
            <h2>This Help page is unavailable</h2>
            <p>
              The guide may have moved or is no longer part of the current catalog. Browse the
              available Help topics instead.
            </p>
            {defaultSourceId !== null && (
              <Button variant="secondary" onClick={() => selectSource(defaultSourceId)}>
                Browse Help
              </Button>
            )}
          </div>
        )}
        {catalog !== null && source !== null && (
          <>
            <span className="section-label">{source.section.title}</span>
            <MarkdownDocument
              content={source.content}
              source={source}
              sources={catalog.sources}
              onSelect={selectSource}
            />
            {entry?.nextStep !== null && entry?.nextStep !== undefined && (
              <div className="help-center__next-step">
                <span>Next</span>
                <Button
                  variant="quiet"
                  onClick={() => {
                    const nextEntry = catalog.entries.find(
                      (candidate) => candidate.publicRoute === entry.nextStep?.publicRoute,
                    )
                    if (nextEntry !== undefined) selectSource(nextEntry.id)
                  }}
                >
                  {entry.nextStep.label}
                </Button>
              </div>
            )}
            <details className="help-center__source-details">
              <summary>Source details</summary>
              <span>
                {source.section.title} · version {source.version} · catalog {catalog.catalogVersion}{' '}
                · sha256 {source.sha256.slice(0, 12)}…
              </span>
              {source.claimIds.length > 0 && <span>Claims: {source.claimIds.join(', ')}</span>}
            </details>
          </>
        )}
      </article>
    </section>
  )
}

interface KnowledgeBrowser {
  readonly schemaVersion: 'knowledge-browser@2'
  readonly catalogVersion: string
  readonly defaultTrack: string
  readonly sections: readonly {
    id: string
    title: string
    items: readonly { sourceId: string; label: string }[]
  }[]
  readonly entries: readonly {
    id: string
    nextStep: { label: string; publicRoute: string } | null
    publicRoute: string
    searchLabel: string
  }[]
  readonly sources: readonly {
    id: string
    label: string
    section: { id: string; title: string }
    version: string
    canonicalUri: string
    sha256: string
    claimIds: readonly string[]
    content: string
  }[]
}

function MarkdownDocument({
  content,
  source,
  sources,
  onSelect,
}: {
  content: string
  source: KnowledgeBrowser['sources'][number]
  sources: KnowledgeBrowser['sources']
  onSelect: (sourceId: string) => void
}) {
  return (
    <div className="knowledge-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const target =
              href === undefined
                ? undefined
                : sources.find(
                    (candidate) =>
                      candidate.canonicalUri === resolveRepositoryPath(source.canonicalUri, href),
                  )
            if (target === undefined) return <a href={href}>{children}</a>
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault()
                  onSelect(target.id)
                }}
              >
                {children}
              </a>
            )
          },
          img: ({ src, alt }) => {
            const publicSource = resolvePublicKnowledgeAsset(
              source.canonicalUri,
              typeof src === 'string' ? src : undefined,
            )
            return publicSource === null ? null : (
              <img src={publicSource} alt={alt ?? ''} loading="lazy" />
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function resolveRepositoryPath(currentUri: string, href: string): string | null {
  const [path] = href.split(/[?#]/, 1)
  if (
    path === undefined ||
    path.length === 0 ||
    path.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  )
    return null

  const parts = currentUri.split('/').slice(0, -1)
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

function resolvePublicKnowledgeAsset(currentUri: string, src: string | undefined): string | null {
  if (src === undefined) return null
  if (/^https:\/\//i.test(src)) return src
  const repositoryPath = resolveRepositoryPath(currentUri, src)
  const publicPrefix = 'apps/web/public/'
  return repositoryPath?.startsWith(publicPrefix)
    ? `/${repositoryPath.slice(publicPrefix.length)}`
    : null
}
