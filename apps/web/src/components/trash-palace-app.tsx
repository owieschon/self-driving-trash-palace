'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { HelpCenter } from './help-center'
import { AppShell, Button, ContextBar, Status, TopNav } from './relay'
import { FirstRunOrientation } from './first-run-orientation'
import {
  ProductApiError,
  answerClarification,
  cancelMission,
  createMission,
  createProductSession,
  decideApproval,
  getApproval,
  getClarification,
  getMissionProgress,
  getPalaceWorkspace,
  pollMissionProgress,
  pollMissionTasks,
} from '../lib/product-api'
import type {
  ProductApproval,
  ProductClarification,
  ProductMissionProgress,
  ProductSession,
  ProductWorkspace,
} from '../lib/product-api'
import {
  AUTOMATIONS,
  INITIAL_PRODUCT_STATE,
  reduceProductState,
  type AutomationDraft,
  type AutomationDraftPatch,
  type AutomationKind,
  type ChangeStatus,
  type ProductView,
} from '../lib/product-state'

const NAVIGATION: readonly ProductView[] = ['home', 'activity', 'automations', 'household', 'learn']
const VIEW_LABEL: Readonly<Record<ProductView, string>> = {
  home: 'Palace',
  activity: 'Activity',
  automations: 'Automations',
  household: 'Workspace',
  learn: 'Help',
}
const VIEW_HREF: Readonly<Record<ProductView, string>> = {
  home: '/',
  activity: '/activity',
  automations: '/automations',
  household: '/setup',
  learn: '/help',
}

type WorkspaceMode = 'loading' | 'sample' | 'connected' | 'unavailable'

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

export function TrashPalaceApp({
  initialView = 'home',
  initialAutomation = null,
  initialHelpEntry = null,
  initialPalaceId = null,
  initialMissionId = null,
}: {
  initialView?: ProductView
  initialAutomation?: AutomationKind | null
  initialHelpEntry?: string | null
  initialPalaceId?: string | null
  initialMissionId?: string | null
}) {
  const router = useRouter()
  const [state, dispatch] = useReducer(
    reduceProductState,
    { initialView, initialAutomation },
    ({ initialView: view, initialAutomation: automation }) =>
      automation === null
        ? { ...INITIAL_PRODUCT_STATE, view }
        : reduceProductState(
            { ...INITIAL_PRODUCT_STATE, view },
            { type: 'review_change', automation },
          ),
  )
  const focusTarget = useRef<HTMLElement>(null)
  // A fixture session is a browser credential, not a refresh token. Reissuing it while a
  // request is active replaces the session cookie and invalidates the CSRF token held by that
  // request. Keep the one bootstrap session until an explicit mission creation returns a newer
  // token.
  const productSession = useRef<ProductSession | null>(null)
  const productSessionBootstrap = useRef<Promise<ProductSession | null> | null>(null)
  const [workspace, setWorkspace] = useState<ProductWorkspace | null>(null)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    initialPalaceId === null ? 'sample' : 'loading',
  )
  const ensureProductSession = useCallback(async () => {
    if (productSession.current !== null) return productSession.current
    if (productSessionBootstrap.current !== null) return productSessionBootstrap.current
    const bootstrap = (async () => {
      try {
        const issued = await createProductSession()
        productSession.current = issued
        return issued
      } catch {
        // A hosted workspace has an existing product session. The local-only fixture endpoint is
        // optional, so failure to issue one must not turn a readable workspace into an error.
        return null
      } finally {
        productSessionBootstrap.current = null
      }
    })()
    productSessionBootstrap.current = bootstrap
    return bootstrap
  }, [])
  const refreshWorkspace = useCallback(
    async (palaceId: string, showLoading = false) => {
      if (showLoading) setWorkspaceMode('loading')
      try {
        // The local preview has an explicitly guarded fixture-session endpoint. Hosted product
        // authentication owns its own session, so a disabled fixture endpoint is never treated as
        // a workspace failure.
        await ensureProductSession()
        const loaded = await getPalaceWorkspace(palaceId)
        setWorkspace(loaded)
        setWorkspaceMode('connected')
      } catch {
        setWorkspace(null)
        setWorkspaceMode('unavailable')
      }
    },
    [ensureProductSession],
  )
  useEffect(() => {
    document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'
  }, [state.dark])
  useEffect(() => {
    focusTarget.current?.focus()
  }, [state.view])
  useEffect(() => {
    if (initialPalaceId === null) {
      setWorkspace(null)
      setWorkspaceMode('sample')
      return
    }
    void refreshWorkspace(initialPalaceId, true)
  }, [initialPalaceId, refreshWorkspace])
  const decisionWaiting =
    state.changeStatus === 'needs_input' || state.changeStatus === 'needs_approval'
  const navigate = (view: ProductView) => {
    dispatch({ type: 'navigate', view })
    router.push(VIEW_HREF[view])
  }
  const reviewAutomation = (automation: AutomationKind) => {
    router.push(`/automations/${automation}`)
  }
  const cancelReview = () => {
    router.push(VIEW_HREF.automations)
  }
  const loadHumanTask = async (missionId: string) => {
    const inbox = await pollMissionTasks(missionId)
    if (inbox.approval !== null) {
      dispatch({ type: 'approval_ready', approval: await getApproval(inbox.approval.id) })
      return
    }
    if (inbox.clarification !== null) {
      dispatch({
        type: 'clarification_ready',
        clarification: await getClarification(inbox.clarification.id),
      })
      return
    }
    dispatch({ type: 'task_waiting' })
  }
  useEffect(() => {
    if (initialMissionId === null) return
    void (async () => {
      try {
        const session = await ensureProductSession()
        if (session === null) {
          throw new ProductApiError(
            'A signed-in TrashPal session is required before Pal can reopen this request.',
            'failed',
          )
        }
        const progress = await getMissionProgress(initialMissionId)
        dispatch({
          type: 'mission_created',
          requestId: `resume_${initialMissionId}`,
          missionId: progress.mission.id,
          palaceId: progress.mission.palaceId,
          session,
        })
        if (progress.pendingTask === null) {
          dispatch({ type: 'progress_loaded', progress })
          return
        }
        await loadHumanTask(progress.mission.id)
      } catch (error) {
        const failure =
          error instanceof ProductApiError
            ? error
            : new ProductApiError('TrashPal could not reopen this request.', 'failed')
        dispatch({ type: 'change_failed', message: failure.message })
      }
    })()
  }, [ensureProductSession, initialMissionId])
  const openAttention = (missionId: string) => {
    void (async () => {
      try {
        const progress = await getMissionProgress(missionId)
        const automation = progress.mission.programKind
        if (automation === null) {
          router.push(VIEW_HREF.activity)
          return
        }
        router.push(`/automations/${automation}?mission=${encodeURIComponent(missionId)}`)
      } catch {
        router.push(VIEW_HREF.activity)
      }
    })()
  }
  const reconcileUnknownOutcome = (missionId: string, requestId: string) => {
    dispatch({ type: 'change_unknown', requestId })
    void (async () => {
      try {
        const progress = await pollMissionProgress(missionId)
        if (progress.pendingTask !== null) {
          await loadHumanTask(missionId)
        } else {
          dispatch({ type: 'progress_loaded', progress })
        }
        void refreshWorkspace(progress.mission.palaceId)
      } catch {
        // The result remains explicitly unknown until the server record is readable.
      }
    })()
  }
  const submitProposal = (requestId: string) => {
    void (async () => {
      const automation = state.selectedAutomation
      if (automation === null) return
      if (workspaceMode !== 'connected' || workspace === null) {
        dispatch({
          type: 'change_failed',
          message:
            workspaceMode === 'sample'
              ? 'Sample mode is inspect-only. Connect a live Palace before asking Pal to prepare a proposal.'
              : 'The Palace workspace is unavailable. Restore access before asking Pal to prepare a proposal.',
        })
        return
      }
      dispatch({ type: 'submit_change', requestId })
      try {
        const session = await ensureProductSession()
        if (session === null) {
          throw new ProductApiError(
            'A signed-in TrashPal session is required before Pal can prepare a proposal.',
            'failed',
          )
        }
        const created = await createMission(
          automation,
          requestId,
          workspace.palace.id,
          state.draft ?? undefined,
          fetch,
          session,
        )
        productSession.current = created.session
        dispatch({
          type: 'mission_created',
          requestId,
          missionId: created.mission.id,
          palaceId: created.mission.palaceId,
          session: created.session,
        })
        void refreshWorkspace(created.mission.palaceId)
        try {
          await loadHumanTask(created.mission.id)
        } catch {
          dispatch({
            type: 'progress_unavailable',
            message:
              'The request was recorded. TrashPal could not load its next step, so it remains under checking.',
          })
        }
      } catch (error) {
        const failure =
          error instanceof ProductApiError
            ? error
            : new ProductApiError('TrashPal could not start this proposal.', 'failed')
        dispatch(
          failure.outcome === 'unknown'
            ? { type: 'change_unknown', requestId }
            : { type: 'change_failed', message: failure.message },
        )
      }
    })()
  }
  const startProposal = () => {
    if (state.selectedAutomation === null) return
    const prefix = state.selectedAutomation === 'night_shift_homecoming' ? 'homecoming' : 'hauler'
    submitProposal(`${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`)
  }
  const retryUnknownProposal = () => {
    if (state.requestId === null || state.missionId !== null) return
    submitProposal(state.requestId)
  }
  const reconcileCurrentMission = () => {
    if (state.missionId === null) return
    reconcileUnknownOutcome(state.missionId, state.requestId ?? state.missionId)
  }
  const stopCurrentRequest = () => {
    void (async () => {
      if (state.missionId === null || state.session === null) return
      dispatch({ type: 'cancellation_checking' })
      try {
        await cancelMission({ missionId: state.missionId, session: state.session })
        const progress = await pollMissionProgress(state.missionId)
        dispatch({ type: 'progress_loaded', progress })
        if (state.palaceId !== null) void refreshWorkspace(state.palaceId)
      } catch (error) {
        const failure =
          error instanceof ProductApiError
            ? error
            : new ProductApiError('TrashPal could not stop this request.', 'failed')
        dispatch({
          type: 'cancellation_unavailable',
          message:
            failure.outcome === 'unknown'
              ? 'The stop response was lost. Pal is checking the existing request before reporting its state.'
              : 'TrashPal could not submit the stop request. The request remains active until Pal confirms otherwise.',
        })
      }
    })()
  }
  const approveProposal = () => {
    void (async () => {
      if (state.approval === null || state.session === null) return
      dispatch({ type: 'approval_applying' })
      try {
        const result = await decideApproval({
          approvalId: state.approval.approval.id,
          nonce: state.approval.approval.nonce,
          decision: 'approve',
          session: state.session,
        })
        if (result.decision === 'approved') {
          dispatch({ type: 'approval_checking' })
          try {
            dispatch({
              type: 'progress_loaded',
              progress: await pollMissionProgress(result.mission.id),
            })
          } catch {
            dispatch({
              type: 'progress_unavailable',
              message:
                'Approval was recorded. TrashPal could not load the latest result, so it remains under checking.',
            })
          }
          return
        }
        dispatch({ type: 'change_failed', message: 'The proposal could no longer be approved.' })
      } catch (error) {
        const failure =
          error instanceof ProductApiError
            ? error
            : new ProductApiError('TrashPal could not record this approval.', 'failed')
        if (failure.outcome === 'unknown') {
          reconcileUnknownOutcome(
            state.approval.approval.missionId,
            state.requestId ?? state.approval.approval.missionId,
          )
          return
        }
        dispatch({ type: 'change_failed', message: failure.message })
      }
    })()
  }
  const rejectProposal = (afterRejection: 'close' | 'edit' = 'close') => {
    void (async () => {
      if (state.approval === null || state.session === null) {
        if (afterRejection === 'close') dispatch({ type: 'reject_change' })
        return
      }
      dispatch({ type: 'approval_applying' })
      try {
        const result = await decideApproval({
          approvalId: state.approval.approval.id,
          nonce: state.approval.approval.nonce,
          decision: 'reject',
          session: state.session,
        })
        if (result.decision === 'rejected') {
          dispatch({ type: afterRejection === 'edit' ? 'edit_proposal' : 'reject_change' })
          return
        }
        dispatch({ type: 'change_failed', message: 'The proposal could no longer be rejected.' })
      } catch (error) {
        const failure =
          error instanceof ProductApiError
            ? error
            : new ProductApiError('TrashPal could not record this decision.', 'failed')
        if (failure.outcome === 'unknown') {
          reconcileUnknownOutcome(
            state.approval.approval.missionId,
            state.requestId ?? state.approval.approval.missionId,
          )
          return
        }
        dispatch({ type: 'change_failed', message: failure.message })
      }
    })()
  }
  const answerInput = (choiceId: string) => {
    void (async () => {
      if (state.clarification === null || state.session === null) return
      dispatch({ type: 'clarification_answered' })
      try {
        const result = await answerClarification({
          requestId: state.clarification.request.id,
          choiceId,
          expectedMissionVersion: state.clarification.mission.version,
          session: state.session,
        })
        try {
          await loadHumanTask(result.mission.id)
        } catch {
          dispatch({
            type: 'progress_unavailable',
            message:
              'The answer was recorded. TrashPal could not load the next step, so it remains under checking.',
          })
        }
      } catch (error) {
        const failure =
          error instanceof ProductApiError
            ? error
            : new ProductApiError('TrashPal could not record this answer.', 'failed')
        if (failure.outcome === 'unknown') {
          reconcileUnknownOutcome(
            state.clarification.mission.id,
            state.requestId ?? state.clarification.mission.id,
          )
          return
        }
        dispatch({ type: 'change_failed', message: failure.message })
      }
    })()
  }
  const updateDraft = (patch: AutomationDraftPatch) => dispatch({ type: 'update_draft', patch })
  const retryWorkspace = () => {
    if (initialPalaceId !== null) void refreshWorkspace(initialPalaceId, true)
  }
  const contextStatus =
    decisionWaiting ||
    workspace?.attention.some((item) => item.kind === 'approval' || item.kind === 'clarification')
      ? 'Decision waiting'
      : workspaceMode === 'loading'
        ? 'Loading workspace'
        : workspaceMode === 'unavailable'
          ? 'Workspace unavailable'
          : workspaceMode === 'sample'
            ? 'Sample workspace'
            : workspace?.attention.some(
                  (item) => item.kind === 'reconciliation' || item.kind === 'verification',
                )
              ? 'Result checking'
              : 'Nothing needs your review'
  const contextTone =
    decisionWaiting || workspaceMode === 'unavailable'
      ? 'warning'
      : workspaceMode === 'connected'
        ? 'neutral'
        : 'neutral'
  const palaceName =
    workspace?.palace.name ?? (workspaceMode === 'sample' ? 'Sample Palace' : 'Palace workspace')
  const presentation =
    workspace === null
      ? workspaceMode === 'sample'
        ? 'Sample data'
        : workspaceMode === 'loading'
          ? 'Loading'
          : 'Unavailable'
      : `Good ${workspace.presentation.dayPeriod}`

  return (
    <AppShell>
      <TopNav
        dark={state.dark}
        onNewAutomation={() => navigate('automations')}
        onTheme={() => dispatch({ type: 'toggle_theme' })}
        onReset={() => navigate('home')}
      />
      <ContextBar
        status={contextStatus}
        tone={contextTone}
        palaceName={palaceName}
        presentation={presentation}
      />
      <div className="home-shell">
        <nav className="home-nav" aria-label="Primary navigation">
          {NAVIGATION.map((item) => (
            <button
              key={item}
              className={state.view === item ? 'active' : ''}
              aria-current={state.view === item ? 'page' : undefined}
              onClick={() => navigate(item)}
            >
              {VIEW_LABEL[item]}
            </button>
          ))}
          <div className="nav-foot">
            <strong>
              {workspace === null ? 'Sample workspace' : workspace.member.displayName}
            </strong>
            <span>
              {workspaceMode === 'unavailable'
                ? 'Workspace unavailable'
                : workspaceMode === 'loading'
                  ? 'Loading Palace data'
                  : workspaceMode === 'sample'
                    ? 'Inspect-only sample'
                    : workspace?.palace.timezone}
            </span>
          </div>
        </nav>
        <main id="main-content" ref={focusTarget} className="home-main" tabIndex={-1}>
          {state.view === 'home' && (
            <Home
              workspace={workspace}
              workspaceMode={workspaceMode}
              orientationScope={workspace?.palace.id ?? initialPalaceId ?? 'sample'}
              onReview={reviewAutomation}
              onOpenAttention={openAttention}
              onStart={() => navigate('automations')}
              onOpenHelp={() => navigate('learn')}
              onRetry={retryWorkspace}
            />
          )}
          {state.view === 'activity' && (
            <Activity
              onOpenMission={openAttention}
              progress={state.progress}
              workspace={workspace}
              workspaceMode={workspaceMode}
            />
          )}
          {state.view === 'automations' && (
            <Automations
              selected={state.selectedAutomation}
              status={state.changeStatus}
              error={state.error}
              requestId={state.requestId}
              missionId={state.missionId}
              approval={state.approval}
              clarification={state.clarification}
              progress={state.progress}
              workspace={workspace}
              workspaceMode={workspaceMode}
              draft={state.draft}
              onReview={reviewAutomation}
              onStart={startProposal}
              onDraftChange={updateDraft}
              onAnswer={answerInput}
              onReject={rejectProposal}
              onCancel={cancelReview}
              onEdit={() => rejectProposal('edit')}
              onEditDraft={() => dispatch({ type: 'edit_proposal' })}
              onApprove={approveProposal}
              onReconcile={reconcileCurrentMission}
              onRetryProposal={retryUnknownProposal}
              onStop={stopCurrentRequest}
              onViewActivity={() => navigate('activity')}
              onRetry={retryWorkspace}
            />
          )}
          {state.view === 'household' && (
            <WorkspacePanel
              workspace={workspace}
              workspaceMode={workspaceMode}
              onRetry={retryWorkspace}
            />
          )}
          {state.view === 'learn' && (
            <>
              <PageHead
                title="Help"
                copy="Start with the job you have. Developer documentation and API reference stay available when you need to go deeper."
              />
              <HelpCenter
                initialSourceId={initialHelpEntry}
                onSelectSource={(sourceId) => router.push(`/help/${encodeURIComponent(sourceId)}`)}
              />
            </>
          )}
        </main>
      </div>
    </AppShell>
  )
}

function Home({
  workspace,
  workspaceMode,
  orientationScope,
  onReview,
  onOpenAttention,
  onStart,
  onOpenHelp,
  onRetry,
}: {
  workspace: ProductWorkspace | null
  workspaceMode: WorkspaceMode
  orientationScope: string
  onReview: (kind: AutomationKind) => void
  onOpenAttention: (missionId: string) => void
  onStart: () => void
  onOpenHelp: () => void
  onRetry: () => void
}) {
  const capabilityIdeas =
    workspace?.capabilityIdeas ??
    AUTOMATIONS.map((automation) => ({
      programKind: automation.kind,
      label: automation.name,
      description: automation.purpose,
      availability:
        workspaceMode === 'unavailable' ? ('needs_connection' as const) : ('ready' as const),
      requiredCapabilities: [],
    }))
  return (
    <>
      <PageHead
        title={
          workspaceMode === 'loading'
            ? 'Loading your Palace'
            : workspaceMode === 'unavailable'
              ? 'Your Palace is unavailable'
              : workspace === null
                ? 'Your Palace'
                : `Good ${workspace.presentation.dayPeriod}, ${workspace.member.displayName}`
        }
        copy={
          workspaceMode === 'loading'
            ? 'TrashPal is loading the Palace information Pal can use.'
            : workspaceMode === 'unavailable'
              ? 'TrashPal could not load this Palace. It will not guess at the current state or prepare a change until the workspace is available.'
              : workspace === null
                ? 'An inspect-only sample that shows what Pal operates, what needs a decision, and what has been verified.'
                : `Your Palace is shown in ${workspace.presentation.timezone}. Pal works within the limits you saved.`
        }
      />
      <FirstRunOrientation
        mode={workspaceMode}
        scope={orientationScope}
        onStart={onStart}
        onRetry={onRetry}
      />
      {workspaceMode === 'unavailable' && (
        <Notice
          title="Palace data is not available"
          copy="This can happen while your session or local stack is unavailable. No request will be sent until TrashPal can load the Palace again."
          tone="warning"
        />
      )}
      <div className="home-grid">
        <div className="home-primary">
          {workspace !== null && workspace.attention.length > 0 && (
            <section className="attention-queue" aria-labelledby="workspace-attention-title">
              <div className="section-head">
                <div>
                  <span className="section-label">Needs your decision</span>
                  <h2 id="workspace-attention-title">Pick up where Pal stopped</h2>
                </div>
                <Status tone="warning">Action needed</Status>
              </div>
              <p>
                Pal does not guess when a request needs your input or proof. Open a request to
                review the next decision.
              </p>
              <div className="attention-queue__list">
                {workspace.attention.map((item) => (
                  <article key={`${item.kind}-${item.missionId}`}>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{attentionActionLabel(item.kind)}</small>
                    </div>
                    <Button
                      onClick={() => onOpenAttention(item.missionId)}
                      aria-label={`${attentionActionLabel(item.kind)}: ${item.label}`}
                    >
                      {attentionActionLabel(item.kind)}
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          )}
          <section className="action-center" aria-labelledby="action-center-title">
            <div className="action-center__header">
              <span className="section-label">Suggested goals</span>
              <h2 id="action-center-title">What would you like Pal to take care of?</h2>
              <p>
                Start with a supported goal, then adjust the available settings. Pal prepares a
                proposal for your review before it makes any change.
              </p>
            </div>
            <div className="action-cards">
              {capabilityIdeas.map((idea, index) => {
                const ready = idea.availability === 'ready'
                const canReview =
                  workspaceMode === 'sample' || (workspaceMode === 'connected' && ready)
                const actionLabel =
                  workspaceMode === 'unavailable'
                    ? `Retry Palace connection for ${idea.label}`
                    : workspaceMode === 'sample'
                      ? `Inspect ${idea.label}`
                      : ready
                        ? `Review and customize ${idea.label}`
                        : `Wait for ${idea.label} to become available`
                return (
                  <article
                    className={index === 0 ? 'action-card is-recommended' : 'action-card'}
                    key={idea.programKind}
                  >
                    <div className="action-card__meta">
                      <span>{index === 0 ? 'Recommended' : 'Supported automation'}</span>
                      <Status tone={ready ? 'action' : 'warning'}>
                        {workspaceMode === 'sample'
                          ? 'Sample'
                          : ready
                            ? 'Ready to review'
                            : 'Unavailable'}
                      </Status>
                    </div>
                    <div>
                      <h3>{idea.label}</h3>
                      <p>{idea.description}</p>
                      {idea.requiredCapabilities.length > 0 && (
                        <small className="action-card__capabilities">
                          Uses {idea.requiredCapabilities.map(humanize).join(', ')}
                        </small>
                      )}
                    </div>
                    <Button
                      variant={index === 0 ? 'primary' : 'secondary'}
                      disabled={
                        workspaceMode === 'loading' ||
                        (!canReview && workspaceMode !== 'unavailable')
                      }
                      onClick={() =>
                        workspaceMode === 'unavailable' ? onRetry() : onReview(idea.programKind)
                      }
                      aria-label={actionLabel}
                    >
                      {workspaceMode === 'unavailable'
                        ? 'Retry connection'
                        : workspaceMode === 'sample'
                          ? 'Inspect workflow'
                          : ready
                            ? 'Review & customize'
                            : 'Loading Palace'}
                    </Button>
                  </article>
                )
              })}
            </div>
            <div className="action-center__footer">
              <p>Every request remains a proposal until you approve it.</p>
              <Button variant="quiet" onClick={onStart}>
                Browse all automations
              </Button>
            </div>
          </section>
          <section className="current">
            <div className="section-head">
              <div>
                <span className="section-label">How control works</span>
                <h2>Pal prepares. You decide. TrashPal checks.</h2>
              </div>
              <Status tone="neutral">
                {workspaceMode === 'sample'
                  ? 'Sample'
                  : workspaceMode === 'loading'
                    ? 'Loading'
                    : workspaceMode === 'unavailable'
                      ? 'Unavailable'
                      : 'Workspace loaded'}
              </Status>
            </div>
            <dl>
              <div>
                <dt>Before Pal acts</dt>
                <dd>
                  <b>Proposal</b>
                  <span>You see the outcome, settings, and limits.</span>
                </dd>
              </div>
              <div>
                <dt>When something is missing</dt>
                <dd>
                  <b>Clarification</b>
                  <span>Pal asks a bounded question.</span>
                </dd>
              </div>
              <div>
                <dt>After approval</dt>
                <dd>
                  <b>Checking result</b>
                  <span>TrashPal reconciles before claiming success.</span>
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <aside className="home-side">
          <section>
            <span className="section-label">About this workspace</span>
            <strong>One Palace at a time, clear boundaries</strong>
            <p>
              Each tenant has its own Palace workspace, authorized members, and approved
              automations.
            </p>
          </section>
          <section>
            <span className="section-label">Reference environment</span>
            <strong>Simulated device state</strong>
            <p>
              {workspaceMode === 'sample'
                ? 'Device state and incident history are sample data. This preview cannot change a physical home.'
                : 'This local stack uses simulated device state. Requests, decisions, and result checking use the application contracts.'}
            </p>
          </section>
          <section>
            <span className="section-label">Need help?</span>
            <strong>Start with Help</strong>
            <p>Start with Help, then open developer material when you need it.</p>
            <Button variant="quiet" onClick={onOpenHelp}>
              Open Help
            </Button>
          </section>
        </aside>
      </div>
    </>
  )
}

function Activity({
  onOpenMission,
  progress,
  workspace,
  workspaceMode,
}: {
  onOpenMission: (missionId: string) => void
  progress: ProductMissionProgress | null
  workspace: ProductWorkspace | null
  workspaceMode: WorkspaceMode
}) {
  const entriesById = new Map(
    (workspace?.activity ?? []).map((entry) => [entry.id, entry] as const),
  )
  if (progress !== null) {
    entriesById.set(progress.mission.id, {
      id: progress.mission.id,
      missionId: progress.mission.id,
      summary: progress.mission.objective,
      status: activityStatusForProgress(progress.displayState),
      occurredAt: progress.observedAt,
    })
  }
  const entries = [...entriesById.values()].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id),
  )
  return (
    <>
      <PageHead
        title="Activity"
        copy="Recent requests, their current status, and when each was last updated."
      />
      {entries.length === 0 ? (
        <Notice
          title={
            workspaceMode === 'sample'
              ? 'Sample mode has no recent requests'
              : workspaceMode === 'unavailable'
                ? 'Activity is unavailable until Palace data loads'
                : 'No recent Palace activity'
          }
          copy={
            workspaceMode === 'sample'
              ? 'The sample shows how Activity is organized without inventing a request or device result.'
              : workspaceMode === 'unavailable'
                ? 'Restore access to see recent requests and their current status.'
                : 'This Palace has no recent requests to show.'
          }
        />
      ) : (
        <div className="activity-list">
          {entries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onOpenMission(entry.missionId)}
              aria-label={`View request: ${entry.summary}`}
            >
              <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
              <span>
                <strong>{humanize(entry.status)}</strong>
                <small>{entry.summary}</small>
              </span>
              <Status tone={activityTone(entry.status)}>{humanize(entry.status)}</Status>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function activityTone(status: ChangeStatus): 'neutral' | 'warning' | 'success' | 'critical' {
  if (status === 'verified') return 'success'
  if (status === 'failed') return 'critical'
  if (
    status === 'cancelling' ||
    status === 'checking_result' ||
    status === 'needs_approval' ||
    status === 'needs_input' ||
    status === 'unknown'
  )
    return 'warning'
  return 'neutral'
}

function activityStatusForProgress(
  status: ProductMissionProgress['displayState'],
): ProductWorkspace['activity'][number]['status'] {
  if (status === 'verified' || status === 'failed' || status === 'cancelled') return status
  if (status === 'checking_result' || status === 'applying') return 'checking_result'
  return 'working'
}

function attentionActionLabel(kind: ProductWorkspace['attention'][number]['kind']): string {
  switch (kind) {
    case 'approval':
      return 'Review proposal'
    case 'clarification':
      return 'Answer question'
    case 'reconciliation':
      return 'View result checking'
    case 'verification':
      return 'View result checking'
  }
}

function Automations(props: {
  selected: AutomationKind | null
  status: ChangeStatus
  error: string | null
  requestId: string | null
  missionId: string | null
  approval: ProductApproval | null
  clarification: ProductClarification | null
  progress: ProductMissionProgress | null
  workspace: ProductWorkspace | null
  workspaceMode: WorkspaceMode
  draft: AutomationDraft | null
  onReview: (kind: AutomationKind) => void
  onStart: () => void
  onDraftChange: (patch: AutomationDraftPatch) => void
  onAnswer: (choiceId: string) => void
  onApprove: () => void
  onReject: () => void
  onCancel: () => void
  onEdit: () => void
  onEditDraft: () => void
  onReconcile: () => void
  onRetryProposal: () => void
  onStop: () => void
  onViewActivity: () => void
  onRetry: () => void
}) {
  const selected = AUTOMATIONS.find((item) => item.kind === props.selected)
  const activeAutomation = props.workspace?.activeAutomations.find(
    (automation) => automation.programKind === props.selected,
  )
  const capabilities =
    props.workspace?.capabilityIdeas ??
    AUTOMATIONS.map((automation) => ({
      programKind: automation.kind,
      label: automation.name,
      description: automation.purpose,
      availability:
        props.workspaceMode === 'sample' ? ('ready' as const) : ('needs_connection' as const),
      requiredCapabilities: [],
    }))
  const verificationSummary = props.progress?.verification?.summary
  const canRetryUnknownProposal = props.missionId === null && props.requestId !== null
  const canStop =
    props.missionId !== null &&
    ['working', 'needs_input', 'needs_approval', 'applying', 'checking_result', 'unknown'].includes(
      props.status,
    )
  const canRetryStop =
    props.missionId !== null && props.status === 'cancelling' && props.error !== null
  if (!selected)
    return (
      <>
        <PageHead
          title="Automations"
          copy="Recurring outcomes TrashPal pursues within the limits you set."
        />
        <div className="automation-list" aria-label="Supported automations">
          {capabilities.map((item) => {
            const active = props.workspace?.activeAutomations.find(
              (automation) => automation.programKind === item.programKind,
            )
            const available = item.availability === 'ready'
            const retryConnection = props.workspaceMode === 'unavailable'
            return (
              <article className="automation-card" key={item.programKind}>
                <div>
                  <div className="automation-card__meta">
                    <span>
                      {active === undefined ? 'Supported automation' : 'Active automation'}
                    </span>
                    <Status
                      tone={active !== undefined ? 'success' : available ? 'action' : 'warning'}
                    >
                      {active !== undefined
                        ? 'Active'
                        : props.workspaceMode === 'loading'
                          ? 'Loading'
                          : props.workspaceMode === 'sample'
                            ? 'Sample'
                            : retryConnection
                              ? 'Connection needed'
                              : available
                                ? 'Ready to review'
                                : 'Unavailable'}
                    </Status>
                  </div>
                  <h2>{item.label}</h2>
                  <p>{item.description}</p>
                  {active !== undefined && (
                    <small>
                      Revision {active.version} is active. Start a separate proposal to change it;
                      the current revision stays in place until you approve the new one.
                    </small>
                  )}
                </div>
                <Button
                  variant={active === undefined ? 'primary' : 'secondary'}
                  disabled={
                    props.workspaceMode === 'loading' ||
                    (!available && active === undefined && !retryConnection)
                  }
                  onClick={() =>
                    retryConnection ? props.onRetry() : props.onReview(item.programKind)
                  }
                  aria-label={
                    retryConnection
                      ? `Retry Palace connection for ${item.label}`
                      : props.workspaceMode === 'sample'
                        ? `Inspect ${item.label}`
                        : active === undefined
                          ? `Review and customize ${item.label}`
                          : `Propose changes to ${item.label}`
                  }
                >
                  {retryConnection
                    ? 'Retry connection'
                    : props.workspaceMode === 'sample'
                      ? 'Inspect workflow'
                      : active === undefined
                        ? 'Review & customize'
                        : 'Propose changes'}
                </Button>
              </article>
            )
          })}
        </div>
      </>
    )
  return (
    <>
      <PageHead
        title={selected.name}
        copy={selected.purpose}
        action={<Button onClick={props.onCancel}>Back to automations</Button>}
      />
      <section className={`change-review is-${props.status}`} aria-live="polite">
        <span className="section-label">Pal automation</span>
        <h2>Choose the outcome. Review the plan before Pal acts.</h2>
        {activeAutomation !== undefined && (
          <Notice
            title="Current automation"
            copy={`${activeAutomation.name} is active at revision ${activeAutomation.version}. This form starts a separate, bounded proposal; it does not edit the active revision in place.`}
          />
        )}
        {props.status === 'reviewing' && (
          <>
            <Notice
              title={
                props.workspaceMode === 'sample'
                  ? 'Inspect the automation model'
                  : props.workspaceMode === 'connected'
                    ? 'Ask Pal to prepare a proposal'
                    : 'Palace access is required'
              }
              copy={
                props.workspaceMode === 'sample'
                  ? 'This sample shows the supported settings, limits, and review boundary. It will not send a request or change a physical home.'
                  : props.workspaceMode === 'connected'
                    ? 'Adjust the supported settings, then Pal will inspect this automation and present any question or plan that needs your decision. Nothing changes yet.'
                    : 'TrashPal cannot prepare a proposal until it can read this Palace. It will not guess at connected-device state.'
              }
            />
            {props.draft !== null && (
              <AutomationDraftForm
                draft={props.draft}
                disabled={props.workspaceMode !== 'connected'}
                preview={props.workspaceMode === 'sample'}
                onChange={props.onDraftChange}
              />
            )}
            <div className="change-actions">
              {props.workspaceMode === 'connected' ? (
                <Button
                  variant="primary"
                  disabled={!draftIsReady(props.draft)}
                  onClick={props.onStart}
                >
                  Prepare proposal
                </Button>
              ) : null}
              <Button variant="quiet" onClick={props.onCancel}>
                {props.workspaceMode === 'connected' ? 'Cancel' : 'View all automations'}
              </Button>
            </div>
          </>
        )}
        {props.status === 'submitting' && (
          <Notice
            title="Starting proposal request"
            copy="Pal is creating one durable request. It has not applied a change."
          />
        )}
        {props.status === 'working' && (
          <>
            <Notice
              title="Pal is preparing the proposal"
              copy={`The request is waiting for its next task${props.requestId ? ` (${props.requestId})` : ''}. No change has been approved.`}
            />
            <div className="change-actions">
              {props.missionId !== null && (
                <Button variant="primary" onClick={props.onReconcile}>
                  Check request
                </Button>
              )}
              <Button variant="quiet" onClick={props.onViewActivity}>
                View activity
              </Button>
            </div>
          </>
        )}
        {props.status === 'needs_input' && props.clarification !== null && (
          <>
            <Notice
              title="Pal needs one decision"
              copy={props.clarification.request.question}
              tone="warning"
            />
            <div className="change-actions">
              {props.clarification.request.choices.map((choice) => (
                <Button key={choice.id} variant="primary" onClick={() => props.onAnswer(choice.id)}>
                  {choice.label}
                </Button>
              ))}
            </div>
            {props.clarification.request.choices.map((choice) => (
              <p key={`${choice.id}-description`}>{choice.description}</p>
            ))}
          </>
        )}
        {props.status === 'needs_approval' && props.approval !== null && (
          <>
            <ProposalDetails approval={props.approval} />
            <div className="change-actions">
              <Button variant="primary" onClick={props.onApprove}>
                Approve proposal
              </Button>
              <Button onClick={props.onReject}>Reject proposal</Button>
              <Button variant="quiet" onClick={props.onEdit}>
                Reject proposal and edit settings
              </Button>
              <Button variant="quiet" onClick={props.onCancel}>
                Close
              </Button>
            </div>
          </>
        )}
        {props.status === 'applying' && (
          <Notice
            title="Recording your decision"
            copy="Pal is recording this approval once. The automation is not yet verified."
          />
        )}
        {props.status === 'cancelling' && (
          <>
            <Notice
              title={props.error === null ? 'Stopping request' : 'Stop request needs confirmation'}
              copy={
                props.error ??
                'Pal is stopping new work and checking whether an operation was already in flight.'
              }
              tone="warning"
            />
            <div className="change-actions">
              {props.missionId !== null && (
                <Button variant="primary" onClick={props.onReconcile}>
                  Check request
                </Button>
              )}
              <Button variant="quiet" onClick={props.onViewActivity}>
                View activity
              </Button>
            </div>
          </>
        )}
        {props.status === 'checking_result' && (
          <>
            <Notice
              title="Approval recorded. Checking the result."
              copy={
                props.error ??
                'Pal will reconcile the operation before it says the requested outcome was achieved.'
              }
              tone="warning"
            />
            <div className="change-actions">
              {props.missionId !== null && (
                <Button variant="primary" onClick={props.onReconcile}>
                  Check result
                </Button>
              )}
              <Button variant="quiet" onClick={props.onViewActivity}>
                View activity
              </Button>
            </div>
          </>
        )}
        {props.status === 'verified' && verificationSummary !== undefined && (
          <>
            <Notice title="Result verified" copy={verificationSummary} tone="success" />
            <div className="change-actions">
              <Button variant="primary" onClick={props.onViewActivity}>
                View activity
              </Button>
              <Button variant="quiet" onClick={props.onCancel}>
                Create another automation
              </Button>
            </div>
          </>
        )}
        {props.status === 'unknown' && (
          <>
            <Notice
              title="Outcome unknown"
              copy={
                canRetryUnknownProposal
                  ? 'The proposal response was lost. Retry only with the same request ID so TrashPal can find or create one durable request.'
                  : props.missionId === null
                    ? 'TrashPal could not match this response to a durable request. Do not repeat the action yet.'
                    : 'The decision response was lost. Pal is checking the existing request before it offers another decision.'
              }
              tone="warning"
            />
            <div className="change-actions">
              {canRetryUnknownProposal ? (
                <Button variant="primary" onClick={props.onRetryProposal}>
                  Retry the same request
                </Button>
              ) : props.missionId !== null ? (
                <Button variant="primary" onClick={props.onReconcile}>
                  Check the current request
                </Button>
              ) : null}
            </div>
          </>
        )}
        {props.status === 'failed' && (
          <>
            <Notice
              title="Proposal could not continue"
              copy={props.error ?? 'The existing automation remains active.'}
              tone="critical"
            />
            <div className="change-actions">
              <Button variant="primary" onClick={props.onEditDraft}>
                Edit settings
              </Button>
              <Button variant="quiet" onClick={props.onCancel}>
                Back to automations
              </Button>
            </div>
          </>
        )}
        {props.status === 'rejected' && (
          <>
            <Notice
              title="Proposal rejected"
              copy="Nothing was changed. The current automation remains active."
            />
            <div className="change-actions">
              <Button variant="primary" onClick={props.onEditDraft}>
                Edit settings
              </Button>
              <Button variant="quiet" onClick={props.onCancel}>
                Back to automations
              </Button>
            </div>
          </>
        )}
        {props.status === 'cancelled' && (
          <>
            <Notice title="Proposal cancelled" copy="No new automation was applied." />
            <div className="change-actions">
              <Button variant="primary" onClick={props.onEditDraft}>
                Edit settings
              </Button>
              <Button variant="quiet" onClick={props.onCancel}>
                Back to automations
              </Button>
            </div>
          </>
        )}
        {(canStop || canRetryStop) && (
          <div className="change-actions change-actions-stop">
            <Button variant="danger" onClick={props.onStop}>
              {canRetryStop ? 'Try stop again' : 'Stop this request'}
            </Button>
            <p>
              Pal stops new work, then checks any operation already in flight before reporting the
              final state.
            </p>
          </div>
        )}
      </section>
    </>
  )
}

function AutomationDraftForm({
  draft,
  disabled,
  preview,
  onChange,
}: {
  draft: AutomationDraft
  disabled: boolean
  preview: boolean
  onChange: (patch: AutomationDraftPatch) => void
}) {
  if (draft.kind === 'night_shift_homecoming') {
    return (
      <fieldset className="automation-draft" disabled={disabled}>
        <legend>{preview ? 'Supported settings' : 'Adjust the supported settings'}</legend>
        <p>
          {preview
            ? 'This sample shows the bounds that shape a proposal. It cannot save or send a request.'
            : 'These settings shape one Homecoming proposal. Pal cannot remove the verified-identity rule or turn on the pathway before arrival.'}
        </p>
        <div className="automation-draft__fields">
          <label>
            <span>Have the Palace ready by</span>
            <input
              type="time"
              value={draft.preheatBy}
              onChange={(event) =>
                onChange({ kind: 'night_shift_homecoming', preheatBy: event.target.value })
              }
            />
          </label>
          <label>
            <span>Maximum projected battery use</span>
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              value={draft.projectedBatteryUseMaxPercentagePoints}
              onChange={(event) => {
                const value = Number(event.target.value)
                onChange({
                  kind: 'night_shift_homecoming',
                  projectedBatteryUseMaxPercentagePoints: Number.isFinite(value) ? value : -1,
                })
              }}
            />
            <small>Percentage points</small>
          </label>
        </div>
      </fieldset>
    )
  }
  const sameWindow = draft.accessWindowStart === draft.accessWindowEnd
  return (
    <fieldset className="automation-draft" disabled={disabled}>
      <legend>{preview ? 'Supported settings' : 'Adjust the supported settings'}</legend>
      <p>
        {preview
          ? 'This sample shows the bounds that shape a proposal. It cannot save or send a request.'
          : 'These settings shape one Hauler Access proposal. Pal keeps access limited to the assigned hauler, the service hatch, and a locked final state.'}
      </p>
      <div className="automation-draft__fields">
        <label>
          <span>Access starts</span>
          <input
            type="time"
            value={draft.accessWindowStart}
            onChange={(event) =>
              onChange({ kind: 'scheduled_hauler_access', accessWindowStart: event.target.value })
            }
          />
        </label>
        <label>
          <span>Access ends</span>
          <input
            type="time"
            value={draft.accessWindowEnd}
            onChange={(event) =>
              onChange({ kind: 'scheduled_hauler_access', accessWindowEnd: event.target.value })
            }
          />
        </label>
      </div>
      {sameWindow && (
        <p className="automation-draft__error">Choose different start and end times.</p>
      )}
    </fieldset>
  )
}

function draftIsReady(draft: AutomationDraft | null): boolean {
  if (draft === null) return false
  const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  if (draft.kind === 'night_shift_homecoming') {
    return (
      validTime(draft.preheatBy) &&
      Number.isFinite(draft.projectedBatteryUseMaxPercentagePoints) &&
      draft.projectedBatteryUseMaxPercentagePoints >= 0 &&
      draft.projectedBatteryUseMaxPercentagePoints <= 100
    )
  }
  return (
    validTime(draft.accessWindowStart) &&
    validTime(draft.accessWindowEnd) &&
    draft.accessWindowStart !== draft.accessWindowEnd
  )
}

function ProposalDetails({ approval }: { approval: ProductApproval }) {
  const { plan } = approval
  const constraints = Object.entries(plan.constraints)
  return (
    <div className="diff-grid">
      <div>
        <small>Requested outcome</small>
        <strong>{plan.objective}</strong>
        <dl>
          {constraints.map(([name, value]) => (
            <div key={name}>
              <dt>{humanize(name)}</dt>
              <dd>{formatPlanValue(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <span aria-hidden="true">→</span>
      <div>
        <small>Pal must preserve</small>
        <strong>Approval boundaries</strong>
        <dl>
          <dt>Protected resources</dt>
          <dd>{approval.approval.protectedResources.join(', ') || 'None declared'}</dd>
          <dt>Success checks</dt>
          <dd>{plan.successCriteriaIds.map(humanize).join(', ')}</dd>
          <dt>Plan revision</dt>
          <dd>{plan.revision}</dd>
        </dl>
      </div>
    </div>
  )
}

function humanize(value: string): string {
  return value
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatPlanValue(value: unknown): string {
  if (typeof value === 'string') return humanize(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
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

function WorkspacePanel({
  workspace,
  workspaceMode,
  onRetry,
}: {
  workspace: ProductWorkspace | null
  workspaceMode: WorkspaceMode
  onRetry: () => void
}) {
  if (workspace !== null) {
    const sections = [
      ['Member', [workspace.member.displayName, workspace.member.role]],
      ['Palace', [workspace.palace.name, workspace.palace.timezone]],
      [
        'Available automations',
        workspace.capabilityIdeas.map((idea) =>
          idea.availability === 'ready'
            ? idea.label
            : `${idea.label} · needs ${idea.requiredCapabilities.join(', ')}`,
        ),
      ],
      [
        'Active automations',
        workspace.activeAutomations.length === 0
          ? ['No active automations']
          : workspace.activeAutomations.map(
              (automation) => `${automation.name} · revision ${automation.version}`,
            ),
      ],
    ] as const
    return (
      <>
        <PageHead
          title="Workspace"
          copy="Review the Palace data Pal can use. Connected-device setup and member management are outside this reference build."
        />
        <p className="section-label">Current workspace information</p>
        <div className="house-sections">
          {sections.map(([name, items]) => (
            <section key={name}>
              <header>
                <h2>{name}</h2>
                <span>{items.length}</span>
              </header>
              {items.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </section>
          ))}
        </div>
      </>
    )
  }
  if (workspaceMode === 'loading' || workspaceMode === 'unavailable') {
    return (
      <>
        <PageHead
          title={workspaceMode === 'loading' ? 'Loading workspace' : 'Workspace is unavailable'}
          copy={
            workspaceMode === 'loading'
              ? 'TrashPal is loading the Palace information Pal can use.'
              : 'TrashPal cannot show members, devices, or limits until it can load this Palace.'
          }
        />
        <Notice
          title={
            workspaceMode === 'loading'
              ? 'Loading Palace configuration'
              : 'No configuration was changed'
          }
          copy={
            workspaceMode === 'loading'
              ? 'This screen will show Palace data when the workspace is ready.'
              : 'Restore access and try again. TrashPal has not inferred device state or sent a request.'
          }
          {...(workspaceMode === 'unavailable' ? { tone: 'warning' as const } : {})}
        />
        {workspaceMode === 'unavailable' && (
          <div className="change-actions">
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </>
    )
  }
  const sections = [
    ['Members', '1', ['Sample member · arrival identity verified']],
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
        'Verified member entry',
        'Service-hatch-only access',
        'Provider outcome reconciliation',
      ],
    ],
  ] as const
  return (
    <>
      <PageHead
        title="Workspace"
        copy="Review the sample members, places, connected devices, and safety limits Pal can use."
      />
      <p className="section-label">Sample configuration</p>
      <div className="house-sections">
        {sections.map(([name, count, items]) => (
          <section key={name}>
            <header>
              <h2>{name}</h2>
              <span>{count}</span>
            </header>
            {items.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </section>
        ))}
      </div>
    </>
  )
}
