'use client'

import { useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

export function RelayMark() {
  return (
    <span className="r-mark" aria-hidden="true">
      TP
    </span>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="r-shell">{children}</div>
}

export function TopNav({
  dark,
  onNewAutomation,
  onTheme,
  onReset,
}: {
  dark: boolean
  onNewAutomation: () => void
  onTheme: () => void
  onReset: () => void
}) {
  return (
    <>
      <a className="r-skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="r-top">
        <button className="r-brand" onClick={onReset}>
          <RelayMark />
          <span>TrashPal</span>
        </button>
        <div className="r-actions">
          <Button className="r-new-automation" variant="primary" onClick={onNewAutomation}>
            New automation
          </Button>
          <button
            className="r-icon"
            onClick={onTheme}
            aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
          >
            <span className={`r-theme-glyph ${dark ? 'is-dark' : 'is-light'}`} aria-hidden="true" />
          </button>
        </div>
      </header>
    </>
  )
}

export function ContextBar({
  status,
  tone,
  palaceName,
  presentation,
}: {
  status: string
  tone: Tone
  palaceName: string
  presentation: string
}) {
  return (
    <div className="r-context">
      <div>
        <span>Palaces</span>
        <span aria-hidden="true">/</span>
        <strong>{palaceName}</strong>
      </div>
      <div>
        <span>{presentation}</span>
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
  const drawerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInitial = () => closeButtonRef.current?.focus()
    const frame = requestAnimationFrame(focusInitial)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const drawer = drawerRef.current
      if (drawer === null) return
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        drawer.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused.current?.focus()
      previouslyFocused.current = null
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="r-backdrop" onClick={onClose}>
      <aside
        className="r-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        ref={drawerRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          className="r-icon r-drawer-close"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
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
