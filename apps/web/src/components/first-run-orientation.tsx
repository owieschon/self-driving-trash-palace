'use client'

import { useEffect, useState } from 'react'

import { Button } from './relay'

type OrientationMode = 'loading' | 'sample' | 'connected' | 'unavailable'

export function FirstRunOrientation({
  mode,
  scope,
  onStart,
  onRetry,
}: {
  mode: OrientationMode
  scope: string
  onStart: () => void
  onRetry: () => void
}) {
  const [open, setOpen] = useState(false)
  const orientationKey = `trashpal.orientation.seen@3:${scope}`

  useEffect(() => {
    setOpen(window.localStorage.getItem(orientationKey) !== 'true')
  }, [orientationKey])

  const dismiss = () => {
    window.localStorage.setItem(orientationKey, 'true')
    setOpen(false)
  }
  const start = () => {
    dismiss()
    onStart()
  }

  if (!open) {
    return (
      <button className="orientation-trigger" onClick={() => setOpen(true)}>
        How TrashPal works
      </button>
    )
  }

  if (mode === 'loading') {
    return (
      <section className="product-intro" aria-labelledby="orientation-title">
        <span className="section-label">Opening your workspace</span>
        <h2 id="orientation-title">Loading the Palace data Pal can use</h2>
        <p>TrashPal will show Palace information only after the workspace is available.</p>
      </section>
    )
  }

  if (mode === 'unavailable') {
    return (
      <section className="product-intro" aria-labelledby="orientation-title">
        <span className="section-label">Connection needed</span>
        <h2 id="orientation-title">TrashPal cannot reach this Palace yet</h2>
        <p>
          Pal does not make a guess when it cannot load the current workspace. Restore access, then
          try again.
        </p>
        <div className="change-actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="quiet" onClick={dismiss}>
            I’ll return later
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="orientation-card" aria-labelledby="orientation-title">
      <div>
        <span className="section-label">Start here</span>
        <h2 id="orientation-title">Welcome to TrashPal</h2>
        <p>
          A Palace is one connected home. Tell Pal what outcome matters, review the proposed
          settings, then approve, change, or stop the request.{' '}
          {mode === 'sample'
            ? 'This sample is inspect-only, so it cannot change a physical home.'
            : 'Pal only works within the limits and connected capabilities available to this Palace.'}
        </p>
      </div>
      <ol className="orientation-card__steps">
        <li>
          <b>Choose a goal</b>
          <span>Start from a supported automation.</span>
        </li>
        <li>
          <b>Review the proposal</b>
          <span>Change supported settings before Pal acts.</span>
        </li>
        <li>
          <b>Stay in control</b>
          <span>Approve, reject, or stop a request at any point.</span>
        </li>
      </ol>
      <div className="change-actions">
        <Button variant="primary" onClick={start}>
          {mode === 'sample' ? 'Explore automations' : 'Choose a goal'}
        </Button>
        <Button variant="quiet" onClick={dismiss}>
          I’ll look around first
        </Button>
      </div>
    </section>
  )
}
