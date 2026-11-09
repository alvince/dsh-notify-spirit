/**
 * Taking a pending decision away from the window — but only when the user is
 * not looking at it.
 *
 * ## Why take it at all
 *
 * `approval/request` and `user-questions/request` are waterfalls: the listener
 * that settles one owns the decision. While DSH is in front, the official card
 * is the right surface, so this module calls `next()` immediately and only
 * observes. When the user has left, the card is invisible: the turn blocks
 * with nothing on screen waiting for them. That is the case this module exists
 * for, and the menu bar is where the decision goes instead.
 *
 * ## The delay is deliberate
 *
 * A request that arrives the instant the user switches windows is not
 * abandoned — it is usually a glance at another app. So a claim holds the
 * request for `claimDelayMs`, watching for the user to come back:
 *
 *   - back within the delay → `next()`, the official card appears, nothing was
 *     ever shown in the tray and no notification was raised
 *   - still away after the delay → the claim sticks, the tray shows it, and the
 *     notification goes out
 *
 * This is exactly the "3 s counts as away, and a return inside the debounce
 * cancels the claim" rule, expressed as one timer.
 *
 * ## While a claim is held, the window is silent
 *
 * A held request never reached the renderer, so the Session shows an ordinary
 * composer with no card. That is acceptable *only* because a claim is held
 * exactly when the user is not looking; and the moment they come back,
 * {@link Claims.release} hands it over and the card appears.
 *
 * ## Every claim has an escape hatch
 *
 * A claim that is never answered would block its turn forever, so each one is
 * released after `claimMaxHoldMs` regardless. The card then appears in the
 * window, which is where a user who wandered off would look next.
 */

/** What a claim is holding. */
const KINDS = {
  approval: 'approval',
  question: 'question',
}

/**
 * @typedef {object} Claim
 * @property {string} id - stable identity, `<kind>:<sessionId>:<callId>`.
 * @property {'approval'|'question'} kind
 * @property {string} sessionId
 * @property {unknown} request - the borrowed waterfall request.
 * @property {(value: unknown) => void} settle - resolve the waterfall.
 * @property {() => void} delegate - hand the request to the listeners behind us.
 * @property {number} heldAt
 * @property {boolean} confirmed - whether the delay elapsed (the user is away).
 * @property {() => void} cancelHold - clear the pending delay timer.
 * @property {() => void} cancelExpiry - clear the max-hold timer.
 */

export class Claims {
  /**
   * @param {object} options
   * @param {() => boolean} options.shouldClaim - whether to take a request at all.
   * @param {() => number} options.delayMs - how long to hold before deciding the user left.
   * @param {() => number} options.maxHoldMs - hard cap on a held request.
   * @param {(claim: Claim) => void} options.onClaim - a request is now held.
   * @param {(claim: Claim) => void} options.onConfirm - the delay elapsed; the user is away.
   * @param {(claim: Claim) => void} options.onRelease - a hold ended for any reason.
   * @param {() => number} [options.now]
   */
  constructor({ shouldClaim, delayMs, maxHoldMs, onClaim, onConfirm, onRelease, now = () => Date.now() }) {
    this.shouldClaim = shouldClaim
    this.delayMs = delayMs
    this.maxHoldMs = maxHoldMs
    this.onClaim = onClaim
    this.onConfirm = onConfirm
    this.onRelease = onRelease
    this.now = now
    /** @type {Map<string, Claim>} */
    this.held = new Map()
  }

  get size() {
    return this.held.size
  }

  /** @returns {Claim[]} */
  list() {
    return [...this.held.values()]
  }

  /** @param {string} id */
  get(id) {
    return this.held.get(id)
  }

  /**
   * Try to take one pending request.
   *
   * The returned promise settles with the decision when the user answers from
   * this plugin, or with whatever the rest of the chain decides when the claim
   * is delegated. A request this plugin does not take returns `undefined` and
   * the caller must delegate immediately.
   *
   * @param {object} options
   * @param {'approval'|'question'} options.kind
   * @param {string} options.sessionId
   * @param {string} [options.callId]
   * @param {unknown} options.request
   * @param {() => Promise<unknown>} options.next - delegate to the rest of the chain.
   * @returns {Promise<unknown> | undefined} undefined when not claiming.
   */
  claim({ kind, sessionId, callId, request, next }) {
    if (!this.shouldClaim()) return undefined
    // One claim per call: a duplicate would answer the same decision twice.
    if (callId !== undefined) {
      for (const existing of this.held.values()) {
        if (existing.sessionId === sessionId && existing.callId === callId) return undefined
      }
    }

    const id = `${kind}:${sessionId}:${callId ?? this.now()}`
    // Not `Promise.withResolvers`: this file must also run on the Node versions
    // a user's dsh CLI may embed, and the few lines it saves are not worth a
    // hard floor on the runtime.
    let resolveSettled
    let rejectSettled
    const settled = new Promise((resolve, reject) => {
      resolveSettled = resolve
      rejectSettled = reject
    })

    let holdTimer
    let expiryTimer
    let finished = false

    /** @type {Claim} */
    const claim = {
      id,
      kind,
      sessionId,
      callId,
      request,
      heldAt: this.now(),
      confirmed: false,
      /** Set only when the user answered this from the menu. */
      answered: false,
      settle: value => {
        if (finished) return
        finish()
        resolveSettled(value)
      },
      delegate: () => {
        if (finished) return
        finish()
        // `next()` continues the waterfall; the official listeners behind us
        // then own the request and the card appears.
        Promise.resolve().then(next).then(resolveSettled, rejectSettled)
      },
      cancelHold: () => clearTimeout(holdTimer),
      cancelExpiry: () => clearTimeout(expiryTimer),
    }

    const finish = () => {
      finished = true
      clearTimeout(holdTimer)
      clearTimeout(expiryTimer)
      this.held.delete(id)
      this.onRelease?.(claim)
    }

    /** Hand the request back to the window and stop holding it. */
    const releaseToWindow = () => {
      if (finished) return
      claim.delegate()
    }

    this.held.set(id, claim)
    this.onClaim?.(claim)

    // The debounce: return inside this window and nothing was ever taken.
    holdTimer = setTimeout(() => {
      if (finished) return
      claim.confirmed = true
      this.onConfirm?.(claim)
    }, Math.max(0, this.delayMs()))
    holdTimer.unref?.()

    // The hard cap: never block a turn indefinitely.
    expiryTimer = setTimeout(() => {
      if (finished) return
      releaseToWindow()
    }, Math.max(0, this.maxHoldMs()))
    expiryTimer.unref?.()

    return settled
  }

  /**
   * Hand one claim back to the window.
   * @param {string} id
   * @returns {boolean} whether a claim was released.
   */
  release(id) {
    const claim = this.held.get(id)
    if (claim === undefined) return false
    claim.delegate()
    return true
  }

  /**
   * Hand every claim back to the window. Used when the user returns to DSH and
   * when the plugin unloads, so a held request never outlives its owner.
   * @returns {number} how many were released.
   */
  releaseAll() {
    let count = 0
    for (const claim of [...this.held.values()]) {
      if (this.release(claim.id)) count += 1
    }
    return count
  }

  /**
   * Resolve one claim with a decision the user made in the tray.
   * @param {string} id
   * @param {unknown} value
   * @returns {boolean} whether a claim was settled.
   */
  answer(id, value) {
    const claim = this.held.get(id)
    if (claim === undefined) return false
    // Marked before settling so `onRelease` can tell a menu answer apart from a
    // hand-back to the window — the two look identical from the waterfall's
    // point of view, and only one of them means the user acted without DSH.
    claim.answered = true
    claim.settle(value)
    return true
  }
}

/**
 * The actions a held request offers, in menu order.
 *
 * An approval is one decision. A question batch is answered one question at a
 * time — DSH requires every question in a single answer, so the menu walks them
 * in order and only the last step submits. Offering every question's options at
 * once would invite a click that silently skips the rest.
 *
 * @param {object} claim
 * @returns {Array<{verb: string, label: string, group?: string, groupIndex?: number, groupTotal?: number}>}
 */
export function actionsOf(claim) {
  const request = claim.request ?? {}

  if (claim.kind === 'approval') {
    return [
      { verb: 'allow', label: '允许一次' },
      { verb: 'reject', label: '拒绝' },
    ]
  }

  const questions = Array.isArray(request.questions) ? request.questions : []
  const draft = claim.draft ?? {}
  const actions = []

  for (const [index, question] of questions.entries()) {
    // Answered questions drop out, so the menu always shows the next one.
    if (draft[question.id] !== undefined) continue
    const options = Array.isArray(question.options) ? question.options : []
    const group = questions.length > 1 ? (question.header ?? question.question ?? question.id) : undefined
    for (const option of options) {
      if (typeof option?.label !== 'string') continue
      actions.push({
        verb: `a:${encodeURIComponent(question.id)}:${encodeURIComponent(option.label)}`,
        label: option.label,
        group,
        groupIndex: index + 1,
        groupTotal: questions.length,
      })
    }
    if (options.length === 0) {
      // Free text cannot be typed into a menu row; skipping is the honest
      // option, and DSH reads a skip as "continue without it".
      actions.push({
        verb: `skip:${encodeURIComponent(question.id)}`,
        label: '跳过这一题',
        group,
        groupIndex: index + 1,
        groupTotal: questions.length,
      })
    }
    break
  }

  return actions
}

/**
 * Record one answer into the claim's draft.
 *
 * @param {object} claim
 * @param {string} verb - an `a:<questionId>:<label>` or `skip:<questionId>` verb.
 * @returns {{kind: 'advanced'} | {kind: 'ready', value: {answers: object[]}} | {kind: 'error', reason: string}}
 */
export function applyAnswer(claim, verb) {
  const questions = Array.isArray(claim.request?.questions) ? claim.request.questions : []
  if (questions.length === 0) return { kind: 'error', reason: '这个请求没有问题可回答' }

  claim.draft ??= {}
  const parts = String(verb).split(':')
  if (parts[0] === 'a' && parts.length === 3) {
    claim.draft[decodeURIComponent(parts[1])] = [decodeURIComponent(parts[2])]
  } else if (parts[0] === 'skip' && parts.length === 2) {
    claim.draft[decodeURIComponent(parts[1])] = []
  } else {
    return { kind: 'error', reason: `未知的回答动作：${verb}` }
  }

  const unanswered = questions.filter(question => claim.draft[question.id] === undefined)
  if (unanswered.length > 0) return { kind: 'advanced' }

  return {
    kind: 'ready',
    value: { answers: questions.map(question => ({ id: question.id, selected: claim.draft[question.id] })) },
  }
}

/**
 * Turn one menu verb into the value the waterfall expects.
 *
 * @param {object} claim
 * @param {string} verb - an `actionsOf` verb.
 * @returns {{ok: true, value: unknown} | {ok: true, advanced: true} | {ok: false, reason: string}}
 */
export function resolveVerb(claim, verb) {
  if (claim.kind === 'approval') {
    if (verb === 'allow') return { ok: true, value: 'allowed-once' }
    if (verb === 'reject') return { ok: true, value: 'rejected' }
    return { ok: false, reason: `未知的批准动作：${verb}` }
  }

  const step = applyAnswer(claim, verb)
  if (step.kind === 'error') return { ok: false, reason: step.reason }
  if (step.kind === 'advanced') return { ok: true, advanced: true }
  return { ok: true, value: step.value }
}

export { KINDS }
