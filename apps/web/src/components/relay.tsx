'use client'

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

export function RelayMark() {
  return (
    <span className="r-mark" aria-hidden="true">
      TP
    </span>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return <main className="r-shell">{children}</main>
}

export function TopNav({
  dark,
  onTheme,
  onReset,
}: {
  dark: boolean
  onTheme: () => void
  onReset: () => void
}) {
  return (
    <header className="r-top">
      <button className="r-brand" onClick={onReset}>
        <RelayMark />
        <span>TrashPal</span>
      </button>
      <div className="r-actions">
        <button className="r-search" aria-label="Search TrashPal">
          ⌕ <span>Search</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className="r-icon"
          onClick={onTheme}
          aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
        >
          <span className={`r-theme-glyph ${dark ? 'is-dark' : 'is-light'}`} aria-hidden="true" />
        </button>
        <button className="r-avatar" aria-label="Rocky account">
          Rocky
        </button>
      </div>
    </header>
  )
}

export function ContextBar({ status, tone }: { status: string; tone: Tone }) {
  return (
    <div className="r-context">
      <div>
        <span>Palaces</span>
        <span aria-hidden="true">/</span>
        <strong>Sacred Dumpster Palace</strong>
      </div>
      <div>
        <span>Updated 12 sec ago</span>
        <Status tone={tone}>{status}</Status>
      </div>
    </div>
  )
}

type Tone = 'neutral' | 'action' | 'success' | 'warning' | 'critical'
export function Status({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`r-status is-${tone}`}>
      <i />
      {children}
    </span>
  )
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
}) {
  return <button className={`r-button is-${variant} ${className}`} {...props} />
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <header className="r-page-head">
      <div>
        <span className="r-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  )
}

export function Surface({ className = '', children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`r-surface ${className}`} {...props}>
      {children}
    </section>
  )
}
export function SurfaceHeader({
  label,
  detail,
  end,
}: {
  label: string
  detail?: string
  end?: ReactNode
}) {
  return (
    <header className="r-surface-head">
      <div>
        <h2>{label}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {end}
    </header>
  )
}

export function Metric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail: string
  tone?: Tone
}) {
  return (
    <article className="r-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={`is-${tone}`}>{detail}</small>
    </article>
  )
}

export function ActivityList({
  items,
  tone,
}: {
  items: { label: string; detail: string; time: string }[]
  tone: Tone
}) {
  return (
    <ol className="r-activity">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`}>
          <Status tone={index === items.length - 1 ? tone : 'neutral'}>
            <span className="sr-only">Recorded</span>
          </Status>
          <div>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </div>
          <time>{item.time}</time>
        </li>
      ))}
    </ol>
  )
}

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="r-backdrop" onClick={onClose}>
      <aside
        className="r-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="r-icon r-drawer-close" onClick={onClose} aria-label="Close evidence">
          ×
        </button>
        <span className="r-eyebrow">Safe local evidence</span>
        <h2 id="drawer-title">{title}</h2>
        {children}
      </aside>
    </div>
  )
}

export function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div className="r-progress" aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i <= current ? 'active' : ''} />
      ))}
    </div>
  )
}
