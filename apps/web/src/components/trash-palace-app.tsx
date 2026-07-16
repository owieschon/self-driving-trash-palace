'use client'

import { useEffect, useReducer, useRef } from 'react'
import { AppShell, Button, ContextBar, Drawer, Status, TopNav } from './relay'
import { activateAutomation, ProductApiError } from '../lib/product-api'
import {
  AUTOMATIONS,
  INITIAL_PRODUCT_STATE,
  reduceProductState,
  type AutomationKind,
  type ActivitySummary,
  type ChangeStatus,
  type ProductView,
} from '../lib/product-state'

const NAVIGATION: readonly ProductView[] = ['home', 'activity', 'automations', 'household', 'learn']
const nameOf = (value: string) => `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`

function PageHead({
  title,
  copy,
  action,
}: {
  title: string
  copy: string
  action?: React.ReactNode
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  )
}

export function TrashPalaceApp() {
  const [state, dispatch] = useReducer(reduceProductState, INITIAL_PRODUCT_STATE)
  const focusTarget = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'
  }, [state.dark])
  useEffect(() => {
    focusTarget.current?.focus()
  }, [state.view])
  const decisionWaiting = !state.homecomingDecisionResolved
  const navigate = (view: ProductView) => dispatch({ type: 'navigate', view })

  return (
    <AppShell>
      <TopNav
        dark={state.dark}
        onTheme={() => dispatch({ type: 'toggle_theme' })}
        onReset={() => navigate('home')}
      />
      <ContextBar
        status={decisionWaiting ? '1 decision waiting' : 'No decisions waiting'}
        tone={decisionWaiting ? 'warning' : 'success'}
      />
      <div className="home-shell">
        <aside className="home-nav" aria-label="Primary navigation">
          {NAVIGATION.map((item) => (
            <button
              key={item}
              className={state.view === item ? 'active' : ''}
              aria-current={state.view === item ? 'page' : undefined}
              onClick={() => navigate(item)}
            >
              {nameOf(item)}
              {item === 'activity' && <span>{state.recentActivity === null ? 6 : 7}</span>}
            </button>
          ))}
          <div className="nav-foot">
            <strong>Home is calm</strong>
            <span>5 devices online</span>
          </div>
        </aside>
        <main className="home-main" tabIndex={-1}>
          <h1 ref={focusTarget} className="sr-only" tabIndex={-1}>
            {nameOf(state.view)}
          </h1>
          {state.view === 'home' && (
            <Home
              decisionResolved={state.homecomingDecisionResolved}
              onReview={(automation) => dispatch({ type: 'review_change', automation })}
              onEvidence={() => dispatch({ type: 'toggle_evidence' })}
            />
          )}
          {state.view === 'activity' && <Activity recent={state.recentActivity} />}
          {state.view === 'automations' && (
            <Automations
              selected={state.selectedAutomation}
              status={state.changeStatus}
              error={state.error}
              requestId={state.requestId}
              onReview={(automation) => dispatch({ type: 'review_change', automation })}
              onReject={() => dispatch({ type: 'reject_change' })}
              onCancel={() => dispatch({ type: 'cancel_change' })}
              onApprove={() => {
                void (async () => {
                  const automation = state.selectedAutomation
                  if (automation === null) return
                  const prefix = automation === 'night_shift_homecoming' ? 'homecoming' : 'hauler'
                  const requestId = `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
                  dispatch({ type: 'submit_change', requestId })
                  try {
                    await activateAutomation(automation, requestId)
                    dispatch({ type: 'change_active', requestId })
                  } catch (error) {
                    const failure =
                      error instanceof ProductApiError
                        ? error
                        : new ProductApiError('TrashPal could not apply this change.', 'failed')
                    dispatch(
                      failure.outcome === 'unknown'
                        ? { type: 'change_unknown', requestId }
                        : { type: 'change_failed', message: failure.message },
                    )
                  }
                })()
              }}
            />
          )}
          {state.view === 'household' && <Household />}
          {state.view === 'learn' && <Learn />}
        </main>
      </div>
      <Drawer
        open={state.evidenceOpen}
        title="Why Caretaker asked"
        onClose={() => dispatch({ type: 'toggle_evidence' })}
      >
        <Evidence />
      </Drawer>
    </AppShell>
  )
}

function Home({
  decisionResolved,
  onReview,
  onEvidence,
}: {
  decisionResolved: boolean
  onReview: (kind: AutomationKind) => void
  onEvidence: () => void
}) {
  return (
    <>
      <PageHead
        title="Good evening, Rocky"
        copy="TrashPal looks after recurring jobs at Sacred Dumpster Palace and asks when a preference conflicts with a hard limit."
      />
      <section className="product-intro" aria-labelledby="product-intro-title">
        <span className="section-label">Your home, on repeat</span>
        <h2 id="product-intro-title">Set the outcome once. Keep the limits visible.</h2>
        <p>
          TrashPal coordinates access, comfort, lighting, and energy for connected raccoon homes.
          Caretaker can propose a safe change, but the application keeps authority, execution, and
          proof separate.
        </p>
      </section>
      <section className="pulse" aria-label="Household timeline">
        <div>
          <span>01:42</span>
          <strong>Checked</strong>
          <p>All five devices responded.</p>
        </div>
        <div className="now">
          <span>Now</span>
          <strong>Decision waiting</strong>
          <p>Reserve and comfort conflict.</p>
        </div>
        <div>
          <span>01:58</span>
          <strong>Expected</strong>
          <p>Rocky arrives home.</p>
        </div>
        <div>
          <span>Wed 08:00</span>
          <strong>Scheduled</strong>
          <p>Hauler uses the service hatch.</p>
        </div>
      </section>
      <div className="home-grid">
        <div className="home-primary">
          <section className={`decision${decisionResolved ? ' resolved' : ''}`}>
            {decisionResolved ? (
              <>
                <span className="section-label">Resolved</span>
                <h2>Tonight’s priority is set</h2>
                <p>
                  The approved Night Shift Homecoming change preserves the morning reserve. Its
                  durable workflow now appears in Activity.
                </p>
              </>
            ) : (
              <>
                <span className="section-label">Needs your input</span>
                <h2>Choose tonight’s priority</h2>
                <p>
                  Rocky’s 22°C preference would take the battery below the morning reserve while the
                  pathway is lit. Caretaker will not silently weaken the reserve.
                </p>
                <div className="choice-table">
                  <button
                    className="recommended"
                    onClick={() => onReview('night_shift_homecoming')}
                  >
                    <span>
                      <b>Preserve the reserve</b>
                      <small>20°C nest · 40% pathway</small>
                    </span>
                    <strong>13.2 points</strong>
                    <em>Recommended</em>
                  </button>
                  <button onClick={() => onReview('night_shift_homecoming')}>
                    <span>
                      <b>Keep Rocky’s preference</b>
                      <small>22°C nest · 60% pathway</small>
                    </span>
                    <strong>18.4 points</strong>
                    <em>Changes a hard limit</em>
                  </button>
                </div>
                <button className="why" onClick={onEvidence}>
                  Why did Caretaker ask?
                </button>
              </>
            )}
          </section>
          <section className="current">
            <div className="section-head">
              <div>
                <span className="section-label">Happening now</span>
                <h2>TrashPal is watching the palace</h2>
              </div>
              <Status tone="neutral">In progress</Status>
            </div>
            <dl>
              <div>
                <dt>Nest thermostat</dt>
                <dd>
                  <b>18°C</b>
                  <span>Target 20°C</span>
                </dd>
              </div>
              <div>
                <dt>Pathway lights</dt>
                <dd>
                  <b>25%</b>
                  <span>Waiting for arrival</span>
                </dd>
              </div>
              <div>
                <dt>Front hatch</dt>
                <dd>
                  <b>Locked</b>
                  <span>Identity required</span>
                </dd>
              </div>
              <div>
                <dt>Service hatch</dt>
                <dd>
                  <b>Locked</b>
                  <span>Hauler window Wednesday</span>
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <aside className="home-side">
          <section>
            <span className="section-label">At home</span>
            <div className="resident">
              <i>R</i>
              <div>
                <strong>Rocky</strong>
                <span>Expected 01:58</span>
              </div>
            </div>
          </section>
          <section>
            <span className="section-label">Energy</span>
            <strong className="large-value">62%</strong>
            <p>Enough for tonight and the morning reserve.</p>
          </section>
          <section>
            <span className="section-label">Next service</span>
            <strong>Neighborhood Compost Co.</strong>
            <p>Wednesday at 08:00</p>
          </section>
        </aside>
      </div>
    </>
  )
}

function Activity({ recent }: { recent: ActivitySummary | null }) {
  const rows: readonly ActivitySummary[] = [
    ...(recent === null ? [] : [recent]),
    {
      time: '01:42',
      label: 'Caretaker requested a decision',
      detail: 'Comfort conflicts with the morning reserve',
      tone: 'warning',
    },
    {
      time: '01:40',
      label: 'Front hatch verified',
      detail: 'The resident hatch is locked',
      tone: 'neutral',
    },
    {
      time: '23:00',
      label: 'Battery reserve protected',
      detail: 'Overnight charging was adjusted',
      tone: 'neutral',
    },
    {
      time: 'Wed',
      label: 'Hauler access verified',
      detail: 'Service hatch relocked at 08:14',
      tone: 'success',
    },
    {
      time: 'Tue',
      label: 'Unknown provider outcome reconciled',
      detail: 'One change retained; no duplicate command',
      tone: 'success',
    },
    {
      time: 'Mon',
      label: 'Unverified visitor refused',
      detail: 'Residential hatch remained locked',
      tone: 'neutral',
    },
  ]
  return (
    <>
      <PageHead title="Activity" copy="What TrashPal did, why it did it, and what was verified." />
      <div className="activity-list">
        {rows.map((row) => (
          <button key={`${row.time}-${row.label}`}>
            <time>{row.time}</time>
            <span>
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </span>
            <Status tone={row.tone}>
              {row.tone === 'warning' ? 'Review' : row.tone === 'success' ? 'Verified' : 'Handled'}
            </Status>
          </button>
        ))}
      </div>
    </>
  )
}

function Automations(props: {
  selected: AutomationKind | null
  status: ChangeStatus
  error: string | null
  requestId: string | null
  onReview: (kind: AutomationKind) => void
  onApprove: () => void
  onReject: () => void
  onCancel: () => void
}) {
  const selected = AUTOMATIONS.find((item) => item.kind === props.selected)
  if (!selected)
    return (
      <>
        <PageHead
          title="Automations"
          copy="Recurring outcomes TrashPal pursues within the limits you set."
        />
        <div className="automation-list">
          {AUTOMATIONS.map((item) => (
            <button key={item.kind} onClick={() => props.onReview(item.kind)}>
              <span>
                <strong>{item.name}</strong>
                <small>{item.schedule}</small>
              </span>
              <span>{item.owner}</span>
              <Status tone={item.status === 'needs_review' ? 'warning' : 'success'}>
                {item.status === 'needs_review' ? 'Review' : 'Active'}
              </Status>
            </button>
          ))}
        </div>
      </>
    )
  return (
    <>
      <PageHead
        title={selected.name}
        copy={selected.purpose}
        action={<Button onClick={props.onCancel}>Close</Button>}
      />
      <section className={`change-review is-${props.status}`} aria-live="polite">
        <span className="section-label">Proposed change</span>
        <h2>Review the exact effect before TrashPal acts</h2>
        {selected.kind === 'scheduled_hauler_access' ? <HaulerDiff /> : <HomecomingDiff />}
        {props.status === 'reviewing' && (
          <div className="change-actions">
            <Button variant="primary" onClick={props.onApprove}>
              Approve change
            </Button>
            <Button onClick={props.onReject}>Reject</Button>
            <Button variant="quiet" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        )}
        {props.status === 'submitting' && (
          <Notice
            title="Applying approved change"
            copy="TrashPal is recording one logical operation. Controls remain disabled until the result is known."
          />
        )}
        {props.status === 'active' && (
          <Notice
            title="Change recorded"
            copy={`The automation entered the durable workflow. Request ${props.requestId ?? 'recorded'}.`}
            tone="success"
          />
        )}
        {props.status === 'unknown' && (
          <Notice
            title="Outcome unknown"
            copy="The provider response was lost. TrashPal will inspect the original operation before any retry."
            tone="warning"
          />
        )}
        {props.status === 'failed' && (
          <Notice
            title="Change not applied"
            copy={props.error ?? 'The existing automation remains active.'}
            tone="critical"
          />
        )}
        {props.status === 'rejected' && (
          <Notice
            title="Change rejected"
            copy="Nothing was changed. The current automation remains active."
          />
        )}
      </section>
    </>
  )
}

function HomecomingDiff() {
  return (
    <div className="diff-grid">
      <div>
        <small>Current</small>
        <strong>Midnight Entry v3</strong>
        <dl>
          <dt>Nest</dt>
          <dd>18°C</dd>
          <dt>Pathway</dt>
          <dd>25%</dd>
          <dt>Reserve</dt>
          <dd>15 points</dd>
        </dl>
      </div>
      <span aria-hidden="true">→</span>
      <div>
        <small>Proposed</small>
        <strong>Night Shift Homecoming</strong>
        <dl>
          <dt>Nest</dt>
          <dd>20°C</dd>
          <dt>Pathway</dt>
          <dd>40% after verified arrival</dd>
          <dt>Reserve</dt>
          <dd>Still 15 points</dd>
        </dl>
      </div>
    </div>
  )
}
function HaulerDiff() {
  return (
    <div className="diff-grid">
      <div>
        <small>Current</small>
        <strong>Manual service access</strong>
        <dl>
          <dt>Window</dt>
          <dd>On request</dd>
          <dt>Identity</dt>
          <dd>Resident approval</dd>
          <dt>Relock</dt>
          <dd>Manual check</dd>
        </dl>
      </div>
      <span aria-hidden="true">→</span>
      <div>
        <small>Proposed</small>
        <strong>Scheduled Hauler Access</strong>
        <dl>
          <dt>Window</dt>
          <dd>Wed 08:00–08:20</dd>
          <dt>Identity</dt>
          <dd>Assigned hauler tag</dd>
          <dt>Relock</dt>
          <dd>Required and verified</dd>
        </dl>
      </div>
    </div>
  )
}
function Notice({
  title,
  copy,
  tone,
}: {
  title: string
  copy: string
  tone?: 'success' | 'warning' | 'critical'
}) {
  return (
    <div className={`change-notice ${tone ? `is-${tone}` : ''}`}>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  )
}

function Household() {
  const sections = [
    ['Residents', '1', ['Rocky · arrival identity verified']],
    ['Places', '4', ['Nest', 'Entry path', 'Utility bay', 'Service bay']],
    [
      'Devices',
      '5',
      [
        'Nest thermostat · 18°C',
        'Pathway · 25%',
        'Front hatch · Locked',
        'Service hatch · Locked',
        'Battery · 62%',
      ],
    ],
    [
      'Policies',
      '4',
      [
        'Morning energy reserve',
        'Verified resident entry',
        'Service-hatch-only access',
        'Provider outcome reconciliation',
      ],
    ],
  ] as const
  return (
    <>
      <PageHead
        title="Household"
        copy="The residents, places, devices, and hard limits TrashPal understands."
      />
      <div className="house-sections">
        {sections.map(([name, count, items]) => (
          <section key={name}>
            <header>
              <h2>{name}</h2>
              <span>{count}</span>
            </header>
            {items.map((item) => (
              <button key={item}>
                {item}
                <span>›</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </>
  )
}

function Learn() {
  return (
    <>
      <PageHead
        title="Learn"
        copy="Set up TrashPal, understand decisions, and diagnose a home in the order you need."
      />
      <div className="learn-layout">
        <aside aria-label="Knowledge sections">
          {[
            'Start here',
            'Connect a home',
            'Create an automation',
            'Review a decision',
            'Recover uncertain changes',
            'Privacy and security',
            'Device reference',
          ].map((item, index) => (
            <div className={index === 0 ? 'active' : ''} key={item}>
              {item}
            </div>
          ))}
        </aside>
        <article>
          <span className="section-label">Start here · 1 of 5</span>
          <h2>Give TrashPal a job, not unlimited control</h2>
          <p className="lead">
            TrashPal works best when an automation names the outcome, the hard limits that must
            never move, and the preferences it may trade off.
          </p>
          <h3>1. Connect one home</h3>
          <p>
            Add the devices TrashPal may read. Device control stays off until you choose an
            automation and approve its authority.
          </p>
          <h3>2. State the recurring outcome</h3>
          <p>
            “Let the assigned hauler use the service hatch on Wednesday” is an outcome. The time
            window, identity, hatch scope, and final locked state are limits.
          </p>
          <h3>3. Review the proposed authority</h3>
          <p>
            Before approval, compare the current behavior with the exact proposed behavior. A
            preference may change. A hard limit may not.
          </p>
        </article>
      </div>
    </>
  )
}
function Evidence() {
  return (
    <>
      <section className="evidence-section">
        <h3>Decision summary</h3>
        <p>
          Caretaker preserved the morning reserve while keeping the nest within 2°C of Rocky’s
          preference.
        </p>
      </section>
      <section className="evidence-section">
        <h3>Information used</h3>
        <dl>
          <dt>Rocky’s preference</dt>
          <dd>22°C</dd>
          <dt>Morning reserve</dt>
          <dd>15 points</dd>
          <dt>Current battery</dt>
          <dd>62%</dd>
          <dt>Expected arrival</dt>
          <dd>01:58</dd>
        </dl>
      </section>
      <section className="evidence-section">
        <h3>Authority boundary</h3>
        <p>
          Caretaker may propose a temperature adjustment of up to 2°C. TrashPal owns approval,
          device commands, reconciliation, and verification.
        </p>
      </section>
    </>
  )
}
