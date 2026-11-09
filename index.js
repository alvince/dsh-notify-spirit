/**
 * dsh-notify-spirit, host half.
 *
 * What this plugin is for: a Session that blocks on a human decision is
 * invisible once you leave the DSH window. This plugin keeps a coloured disc
 * in the menu bar (idle grey / running green / needs-you amber — the same
 * states DSH shows beside a Session), raises a system notification when a
 * Session finishes or needs you, and — in later phases — takes the pending
 * decision out of the window so it can be resolved from the menu bar.
 *
 * Phase status:
 *   P1 (this file) tray + completion/attention notifications
 *   P2 `lib/claims.js`  take `approval/request` away when the window is gone
 *   P3 `lib/queue.js`   the decision queue, incl. `user-questions/request`
 *   P4 `lib/routes.js`  local endpoint for one-click notifications
 *
 * Wiring rules this file follows:
 * - Every registration is an effect on this plugin's context, so unloading the
 *   plugin tears everything down (`ctx.effect`).
 * - Optional services are read with `ctx.get()`; the plugin must stay alive in
 *   a profile that has no Web carrier.
 * - Nothing here polls `agent/status` for state: `agent/status` and
 *   `session/event` are the durable feeds.
 */
import { join } from 'node:path'
import { Config } from './lib/config.js'
import { logPath, logger as fileLog } from './lib/log.js'
import { buildView } from './lib/view.js'
import { Tracker } from './lib/tracker.js'
import { DSH_BUNDLE_ID, NOTIFIER_DOCS, frontmostBundleId, notify, notifyCapability, openUrl, showApp, withdraw } from './lib/notify.js'
import { startTray, traySupported } from './lib/tray/index.js'
import { stateDir, webOrigin } from './lib/paths.js'
import { Claims, actionsOf, resolveVerb } from './lib/claims.js'

export { Config }

export const name = 'notify-spirit'

/** Required service: the live agent registry. */
export const inject = ['agents']

/** Notice kinds that ask something of the user. */
const ATTENTION = new Set(['approval', 'choice', 'input', 'plan-review'])

/** How long a completion notice waits to see whether a sibling finishes too. */
const BURST_MS = 4000

const TITLES = {
  approval: '🔐 需要你批准',
  choice: '🔘 需要你选择',
  input: '✏️ 需要你输入',
  'plan-review': '📋 计划待确认',
  completed: '✅ 任务完成',
  failed: '❌ 任务失败',
  blocked: '⛔ 会话被拦截',
}

export function apply(ctx, config) {
  const logger = fileLog

  // A durable trace for verification: the host's own log sink is not reachable
  // from here, and a silent failure in the claim path is indistinguishable from
  // "the request never arrived" without one.

  /** Volatile fields are live references; read `.get()` for the current value. */
  const read = key => {
    const value = config?.[key]
    return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  const cfg = () => ({
    tray: read('tray'),
    iconStyle: read('iconStyle'),
    showRunning: read('showRunning'),
    trayRows: read('trayRows'),
    notifyCompleted: read('notifyCompleted'),
    notifyFailed: read('notifyFailed'),
    notifyBlocked: read('notifyBlocked'),
    notifyAttention: read('notifyAttention'),
    channel: read('channel'),
    sound: read('sound'),
    burstWindowMs: read('burstWindowMs'),
    claim: read('claim'),
    claimDelayMs: read('claimDelayMs'),
    claimMaxHoldMinutes: read('claimMaxHoldMinutes'),
    claimApprovals: read('claimApprovals'),
    claimQuestions: read('claimQuestions'),
    focusPollMs: read('focusPollMs'),
    returnDebounceMs: read('returnDebounceMs'),
  })

  /** Which per-type switch governs an event. */
  const switchFor = type => {
    switch (type) {
      case 'completed': return cfg().notifyCompleted
      case 'failed': return cfg().notifyFailed
      case 'blocked': return cfg().notifyBlocked
      default: return cfg().notifyAttention
    }
  }

  const tracker = new Tracker()

  /**
   * The disc state for a summary.
   *
   * Anything waiting on the user outranks anything merely busy, so a long job
   * can never hide a blocked Session.
   */
  const iconStateOf = summary => {
    if (summary.waiting.length > 0) return 'warning'
    if (summary.running.length > 0) return 'ongoing'
    return 'idle'
  }

  // ---- tray --------------------------------------------------------------
  let tray
  let trayHidden = false
  let refreshTimer
  let view = { state: 'idle', title: '', tooltip: 'DeepSeek Harness', menu: [] }

  const render = () => {
    if (refreshTimer) return
    // Coalesce bursts (streaming updates) into one tray write.
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      try {
        // Held claims are merged into the same summary the tray already
        // renders, so a request this plugin took over shows up in exactly the
        // place a tracker-derived wait would.
        const summary = tracker.summary()
        // Every wait folded from the durable feed is owned by the window: this
        // plugin only ever takes one over by holding it, and a held request is
        // merged in below with its actions. Marking them keeps the menu from
        // offering an action it cannot perform.
        for (const wait of summary.waiting) wait.inWindow = true
        for (const claim of claims.list()) {
          // A held claim wins over the wait the tracker folded from the durable
          // feed: that copy has no actions, so keeping it would render a
          // decision row the user cannot answer — and would show the same
          // request twice, since the menu lists both sources.
          //
          // Matched by Session alone, not by kind: the tracker names a
          // question `choice`/`input`/`plan-review` while a claim is always
          // `question`, so a kind comparison never matched and both rows
          // appeared side by side.
          // Same Session and the same *request family*: an approval claim only
          // replaces the approval wait, never a question one. The tracker's
          // finer vocabulary (`choice`/`input`/`plan-review`) all belong to the
          // question family.
          const family = kind => (kind === 'approval' ? 'approval' : 'question')
          const shadowed = summary.waiting.findIndex(
            wait => wait.sessionId === claim.sessionId && family(wait.kind) === family(claim.kind),
          )
          const entry = claimEntryOf(claim)
          const row = {
            key: claim.id,
            sessionId: claim.sessionId,
            title: tracker.labelOfSession?.(claim.sessionId) ?? '会话',
            kind: claim.kind,
            text: entry.title,
            since: claim.heldAt,
            claimId: claim.id,
            // Only a held claim can be answered from the menu; the window owns
            // every other pending request.
            actions: actionsOf(claim),
            // Progress through a multi-question batch, so earlier answers stay
            // visible while the menu walks the rest.
            answered: Object.entries(claim.draft ?? {}).map(([id, selected]) => {
              const question = (claim.request?.questions ?? []).find(item => item.id === id)
              return {
                label: question?.header ?? question?.question ?? id,
                answer: selected.length > 0 ? selected.join(', ') : '已跳过',
              }
            }),
          }
          if (shadowed >= 0) {
            row.since = summary.waiting[shadowed].since ?? claim.heldAt
            summary.waiting[shadowed] = row
          } else {
            summary.waiting.push(row)
          }
        }
        view = buildView({
          state: iconStateOf(summary),
          summary,
          config: cfg(),
          now: Date.now(),
          notifyReady: notifyCapability().ok,
        })
        tray?.update(view)
      } catch (error) {
        // The tray silently staying stale is far worse than a noisy log, so
        // the failure is both recorded and surfaced.
        logger.error(`[tray] render failed: ${error && error.stack ? error.stack : error}`)
      }
    }, 120)
    refreshTimer.unref?.()
  }

  /** Keys the OS currently shows a notification of ours for. */
  const shown = new Set()

  /**
   * Show one notice.
   *
   * Only a delivery that actually reached the OS is remembered, so a later
   * withdrawal targets something real instead of firing blind. The notice
   * carries the question or approval text, because it is a pointer the user
   * reads while away — not just an alert.
   */
  const raiseNotice = async (type, sessionId, headline, detail) => {
    if (!switchFor(type)) return
    const title = TITLES[type] ?? 'DeepSeek Harness'
    const body = [headline, detail].filter(part => typeof part === 'string' && part.length > 0).join(' · ')
    const ok = await notify({
      title,
      body,
      key: sessionId,
      sound: cfg().sound,
      openUrl: webOrigin(ctx),
    })
    if (!ok) {
      logger.debug(`[notify] not delivered: ${title}`)
      shown.delete(sessionId)
      return
    }
    shown.add(sessionId)
  }

  const raise = event => raiseNotice(event.type, event.sessionId, event.title, event.body)

  /**
   * Retire the notice for one Session.
   *
   * `-remove` on a group that has nothing left is a no-op, so this runs on
   * every settle rather than only for Sessions this process remembers: a
   * notice whose delivery we never saw acknowledged still has to go.
   */
  const takeBack = async sessionId => {
    shown.delete(sessionId)
    await withdraw(sessionId)
  }

  // ---- notification dispatch -------------------------------------------
  // Completions fold into one notice per burst; anything that needs the user
  // is raised immediately, because delaying it is the one thing that must not
  // happen to a blocking Session.
  const burst = { timer: undefined, extra: [] }

  const closeBurst = () => {
    burst.timer = undefined
    const extra = burst.extra
    burst.extra = []
    if (extra.length === 0) return
    if (extra.length === 1) {
      raise(extra[0])
      return
    }
    const last = extra[extra.length - 1]
    const ok = notify({
      title: `✅ ${extra.length} 个任务完成`,
      body: extra.map(e => e.title).slice(0, 3).join('、') + (extra.length > 3 ? ' 等' : ''),
      key: last.sessionId,
      sound: cfg().sound,
      logger,
    })
    if (!ok) logger.debug('[notify] burst notice not delivered')
  }

  tracker.onEvent(event => {
    if (ATTENTION.has(event.type)) {
      raise(event)
      return
    }
    const windowMs = cfg().burstWindowMs
    if (!(windowMs > 0) || event.type === 'failed' || event.type === 'blocked') {
      raise(event)
      return
    }
    if (burst.timer !== undefined) {
      burst.extra.push(event)
      return
    }
    raise(event)
    burst.timer = setTimeout(closeBurst, windowMs)
    burst.timer.unref?.()
  })

  // A decision taken in the window settles the "needs you" notice. The same
  // sweep runs when the user comes back to DSH: the notice existed only for
  // the time they were away, and leaving it up would be the stale-notice
  // problem this plugin is meant to remove.
  tracker.onChange(() => {
    const waiting = tracker.waitingSessions()
    for (const key of [...shown]) {
      if (waiting.has(key)) continue
      takeBack(key)
    }
    render()
  })

  // ---- services ----------------------------------------------------------
  const open = () => showApp(webOrigin(ctx)).catch(() => false)

  const onAction = action => {
    if (action === 'show-app') return void open()
    if (action === 'hide-tray') {
      trayHidden = true
      return void syncTray()
    }
    if (action.startsWith('answer:')) {
      const rest = action.slice('answer:'.length)
      // `answer:<claimId>|<verb>`: a claim id and a verb both contain colons,
      // so `|` is the only safe separator.
      const split = rest.indexOf('|')
      if (split < 0) return
      const claimId = rest.slice(0, split)
      const verb = rest.slice(split + 1)
      const claim = claims.get(claimId)
      if (claim === undefined) {
        logger.warn(`[tray] answer ignored: claim ${claimId} is no longer held`)
        return
      }
      const resolved = resolveVerb(claim, verb)
      if (!resolved.ok) {
        logger.warn(`[tray] answer rejected: ${resolved.reason}`)
        return
      }
      if (resolved.advanced === true) {
        // A multi-question batch is walked one question at a time; the claim
        // stays held and the menu re-renders on the next question.
        logger.info(`[tray] step kind=${claim.kind} session=${claim.sessionId} verb=${verb}`)
        render()
        return
      }
      // Recorded before settling: this is the only place a decision comes from
      // the menu, so it is what distinguishes a tray answer from one typed in
      // the DSH window (which never reaches this handler at all).
      logger.info(
        `[tray] submit kind=${claim.kind} session=${claim.sessionId} verb=${verb}`
        + ` confirmed=${claim.confirmed} -> ${JSON.stringify(resolved.value)}`,
      )
      claims.answer(claimId, resolved.value)
      // The decision is made, so the notice for it has no reason to stay.
      takeBack(claim.sessionId)
      render()
      return
    }
    if (action === 'install-notifier') {
      // Explain, do not install: running brew on the user's behalf is not a
      // side effect an icon click should have. The README has the full note.
      void openUrl(NOTIFIER_DOCS)
      return
    }
    if (action.startsWith('open:')) {
      open()
      return
    }
  }

  const syncTray = () => {
    const wanted = Boolean(cfg().tray) && !trayHidden && traySupported()
    if (!wanted) {
      const current = tray
      tray = undefined
      current?.stop?.()
      return
    }
    if (tray !== undefined) return
    startTray({ stateDir: stateDir(), onAction, logger })
      .then(started => {
        tray = started
        render()
      })
      .catch(error => logger.warn(`[tray] start failed, notifications only: ${error && error.stack ? error.stack : error}`))
  }

  // ---- taking decisions away from the window ------------------------------
  /**
   * Whether DSH is in front right now.
   *
   * `NSWorkspace` answers this for every app with no permission prompt, and it
   * also covers the `dsh web` case where the front app is a browser. `undefined`
   * (probe failed) counts as "not looking": claiming is the safe direction,
   * because a held request is released the moment the user returns.
   */
  let focused = true
  let focusKnown = false
  const refreshFocus = async () => {
    const front = await frontmostBundleId()
    focusKnown = front !== undefined
    focused = front === DSH_BUNDLE_ID
    return focused
  }

  /**
   * Present one held claim the same way a tracker event is presented, so the
   * tray and the notification share one vocabulary.
   */
  const claimEntryOf = claim => {
    const request = claim.request ?? {}
    if (claim.kind === 'approval') {
      const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason
      return {
        title: reason ?? `工具 ${request.toolName ?? ''} 需要你批准`,
        body: request.toolName ? `工具 ${request.toolName}` : '',
      }
    }
    const questions = Array.isArray(request.questions) ? request.questions : []
    const first = questions[0] ?? {}
    const head = first.header ? `${first.header}：${first.question ?? ''}` : (first.question ?? '需要你回答')
    return {
      title: head,
      body: questions.length > 1 ? `共 ${questions.length} 项` : '',
    }
  }

  const claims = new Claims({
    // Claim only when the user is away, and only for the kinds they enabled.
    shouldClaim: () => {
      const mode = cfg().claim
      if (mode === 'never') return false
      if (mode === 'always') return true
      return focusKnown ? !focused : true
    },
    delayMs: () => cfg().claimDelayMs,
    maxHoldMs: () => cfg().claimMaxHoldMinutes * 60_000,
    onClaim: claim => {
      logger.info(`[claim] take kind=${claim.kind} session=${claim.sessionId}`)
      // Re-render immediately so the disc turns amber without waiting.
      render()
    },
    onConfirm: claim => {
      logger.info(`[claim] confirm kind=${claim.kind} session=${claim.sessionId}`)
      // The user is away and the delay elapsed: only now does the tray speak
      // for a decision, and only now does a notification go out.
      const waiting = claimEntryOf(claim)
      raiseNotice(claim.kind === 'approval' ? 'approval' : 'choice', claim.sessionId, waiting.title, waiting.body)
      render()
    },
    onRelease: claim => {
      // `answered` is set by Claims.answer(); everything else is a hand-back to
      // the window (focus returned, max hold reached, or plugin unloading).
      const outcome = claim.answered ? 'answered-by-tray' : 'handed-to-window'
      logger.info(`[claim] ${outcome} kind=${claim.kind} session=${claim.sessionId} confirmed=${claim.confirmed}`)
      render()
    },
  })

  // ---- waterfall listeners ------------------------------------------------
  // An approval is the only request where our outcome is the decision itself.
  ctx.on('approval/request', async function (req, next) {
    // Only interesting when it changes the outcome; the claim path logs its own
    // decision right after.
    logger.debug(`approval/request tool=${req.toolName} claim=${cfg().claim}`)
    if (!cfg().claimApprovals) return next()
    const sessionId = req.agent?.id
    if (sessionId === undefined) return next()
    const held = claims.claim({
      kind: 'approval',
      sessionId,
      callId: req.callId,
      request: req,
      next,
    })
    logger.info(`claim result: ${held === undefined ? 'NOT-claimed' : 'HELD'}`)
    if (held === undefined) return next()
    return held
  }, { prepend: true })

  ctx.on('user-questions/request', async function (request, next) {
    logger.debug(`user-questions/request session=${request.agent?.id ?? 'none'}`)
    if (!cfg().claimQuestions) return next()
    const sessionId = request.agent?.id
    if (sessionId === undefined) return next()
    const held = claims.claim({
      kind: 'question',
      sessionId,
      callId: request.wait?.callId,
      request,
      next,
    })
    if (held === undefined) return next()
    return held
  }, { prepend: true })

  // ---- focus tracking -----------------------------------------------------
  // The moment DSH comes back, every held request goes back to the window: the
  // card appears there and the tray/notification for it disappear.
  ctx.effect(() => {
    /**
     * Release held claims only after DSH has stayed in front for a moment.
     *
     * A single instant of focus is not a decision to look at the window: the
     * user may be alt-tabbing past it, or clicking its title bar on the way
     * somewhere else. Handing a claim back is irreversible (the waterfall runs
     * `next()` and the official card takes over for good), so it waits for the
     * focus to settle. The window is deliberately short: the longer it is, the
     * longer someone who really did come back stares at an empty Session.
     */
    let focusedSince
    const tick = async () => {
      await refreshFocus()
      if (!focused) {
        focusedSince = undefined
        return
      }
      focusedSince ??= Date.now()
      if (Date.now() - focusedSince < Math.max(0, cfg().returnDebounceMs)) return
      // Release once per considered return: `releaseAll` empties the map, so a
      // later tick finds nothing to do until a new claim appears.
      const released = claims.releaseAll()
      focusedSince = undefined
      if (released > 0) logger.info(`[claim] DSH 回到前台(稳定 ${cfg().returnDebounceMs}ms)，交还 ${released} 个待决请求`)
    }
    tick().catch(() => {})
    const timer = setInterval(() => { tick().catch(() => {}) }, cfg().focusPollMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'notify-spirit: focus')

  // ---- wiring ------------------------------------------------------------
  tracker.seed(ctx.agents.list())
  // `agent/status` and `agent/disposed` are dispatched to an agent scope and a
  // plugin-level listener never receives them (verified against the live Host),
  // so the running flag is driven by `turn/start` / `turn/end` inside the
  // session feed instead. `agent/disposed` is likewise not observable here;
  // a Session that disappears simply stops producing events, and its entry is
  // dropped when the plugin unloads.
  ctx.on('session/event', (session, event) => {
    try {
      tracker.sessionEvent(session, event)
    } catch (error) {
      logger.warn(`[tracker] event failed type=${event?.type}: ${error && error.stack ? error.stack : error}`)
    }
  })

  /**
   * Withdraw every notice once DSH is back in front.
   *
   * The notices exist for the time the user is elsewhere; the moment they
   * return, the in-window card is the better surface and a leftover banner is
   * noise that can only be dismissed.
   */
  const withdrawAllWhileFocused = async () => {
    if (!shown.size) return
    if ((await frontmostBundleId()) !== DSH_BUNDLE_ID) return
    for (const key of [...shown]) await takeBack(key)
  }

  ctx.effect(() => {
    const timer = setInterval(() => { withdrawAllWhileFocused().catch(() => {}) }, 2000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'notify-spirit: notice sweep')

  ctx.effect(() => {
    syncTray()
    render()
    // Settings are volatile; a cheap poll applies a flipped toggle without a restart.
    const timer = setInterval(() => {
      const wanted = Boolean(cfg().tray) && !trayHidden && traySupported()
      if (wanted !== (tray !== undefined)) syncTray()
    }, 2000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      clearTimeout(refreshTimer)
      clearTimeout(burst.timer)
      // Leaving a stale "needs you" notification behind would point at a
      // Session this process no longer serves.
      for (const key of shown) withdraw(key)
      shown.clear()
      const current = tray
      tray = undefined
      current?.stop?.()
    }
  }, 'notify-spirit: tray')

  const capability = notifyCapability()
  logger.info(
    `[notify-spirit] mounted · platform=${process.platform} · tray=${traySupported()}`
    + ` · notify=${capability.ok ? 'terminal-notifier' : `off (${capability.reason})`}`,
  )
}
