/**
 * Session state, folded from the durable event feed.
 *
 * The tracker answers the three questions the menu bar and the notifications
 * both need: what is running, what is blocked on the user, and what finished
 * recently. It is pure logic over plain objects so it can be unit-tested
 * without a Harness.
 *
 * State vocabulary mirrors what DSH itself shows next to a Session:
 *   idle     nothing running, nothing pending
 *   ongoing  the agent is working
 *   warning  the agent is blocked on a human decision
 * (an error pose is deliberately not part of the icon contract: the contract
 * is idle / ongoing / warning, and everything else falls back to idle.)
 */

/** Question tool name used by `dsh-tool-ask-user`. */
const ASK_TOOL = 'ask_user_question'

/** Body excerpt cap so notifications stay compact. */
const BODY_MAX = 90

/** Flatten whitespace and cap the length of a one-line excerpt. */
export function clip(text, max = BODY_MAX) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Top-level Sessions only: a subagent child never owns the user's attention
 * and must never raise a notification or move the tray icon.
 */
export function isTopLevel(session) {
  const header = session?.header
  if (header === undefined) return true
  return !(header.delegationDepth > 0) && header.origin !== 'subagent'
}

/**
 * Read the `ask_user_question` arguments into a question batch.
 * @param {string} argumentsJson - raw recorded tool arguments.
 * @returns {{questions: Array<object>} | undefined} the batch, or undefined when unreadable.
 */
export function parseQuestions(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson)
    const questions = parsed?.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    return { questions }
  } catch {
    return undefined
  }
}

/**
 * Classify a batch: approval-framed questions carry `intent`, plan reviews
 * carry a plan-review intent, and a plain batch may still be a choice if any
 * question offers options.
 * @param {Array<object>} questions - the parsed batch.
 * @returns {'plan-review' | 'choice' | 'input'} the kind the tray shows.
 */
export function classifyQuestions(questions) {
  if (questions.some(q => q?.intent?.kind === 'plan-review')) return 'plan-review'
  if (questions.some(q => Array.isArray(q?.options) && q.options.length > 0)) return 'choice'
  return 'input'
}

/** A short human line for a question batch, used in the notification body. */
export function questionHeadline(questions) {
  const first = questions[0] ?? {}
  const head = first.header ? `${first.header}：${first.question ?? ''}` : (first.question ?? '')
  const suffix = questions.length > 1 ? `（共 ${questions.length} 项）` : ''
  return clip(`${head}${suffix}`)
}

/** Map a TurnEndReason onto the outcome the user cares about, or undefined to stay silent. */
export function outcomeOf(reason) {
  switch (reason?.kind) {
    case 'completed': return { kind: 'completed' }
    case 'error': return { kind: 'failed', detail: reason.error?.message ?? '' }
    case 'max-tokens': return { kind: 'failed', detail: '输出达到长度上限' }
    case 'blocked': return { kind: 'blocked', detail: '被拦截' }
    default: return undefined // aborted / forked / interrupted are not user-facing outcomes
  }
}

export class Tracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    /** @type {Map<string, any>} */
    this.sessions = new Map()
    this.eventListeners = new Set()
    this.changeListeners = new Set()
  }

  onEvent(listener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onChange(listener) {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  emit(type, entry, body) {
    const event = {
      type,
      sessionId: entry.id,
      title: this.labelOf(entry),
      body: clip(body),
      at: this.now(),
    }
    for (const listener of this.eventListeners) listener(event)
  }

  changed() {
    for (const listener of this.changeListeners) listener()
  }

  entry(id, session) {
    let found = this.sessions.get(id)
    if (found === undefined) {
      found = {
        id,
        title: undefined,
        cwd: session?.header?.cwd,
        running: false,
        since: undefined,
        tool: undefined,
        /** Open human-blocking waits, keyed `approval:<id>` / `question:<callId>`. */
        pending: new Map(),
        last: undefined,
      }
      this.sessions.set(id, found)
    }
    return found
  }

  /** The display label of one Session by id, when it is known. */
  labelOfSession(id) {
    const found = this.sessions.get(id)
    return found === undefined ? undefined : this.labelOf(found)
  }

  labelOf(entry) {
    if (entry.title) return entry.title
    if (entry.cwd) return entry.cwd.split(/[\\/]/u).filter(Boolean).pop() ?? entry.cwd
    return '会话'
  }

  /** Seed from agents already alive when the plugin starts. */
  seed(agents) {
    for (const agent of agents) {
      const session = agent.session
      if (!isTopLevel(session)) continue
      const found = this.entry(agent.id, session)
      // `agent.status` is readable here even though the event is not routable.
      found.running = agent.status === 'running'
      if (found.running) found.since = this.now()
    }
    this.changed()
  }

  /**
   * Set the running flag for one Session.
   *
   * This is driven by `turn/start` / `turn/end` rather than `agent/status`:
   * `agent/status` is dispatched to an agent scope and a plugin-level listener
   * never receives it (verified), so relying on it would leave the flag stuck
   * at whatever the seed set. The turn boundaries in the session log are the
   * authoritative, observable equivalent.
   * @param {string} id - Session id.
   * @param {object} session - the Session, for the header and cwd.
   * @param {boolean} running - whether a turn is open.
   */
  setRunning(id, session, running) {
    if (!isTopLevel(session)) return
    const found = this.entry(id, session)
    if (running && !found.running) found.since = this.now()
    found.running = running
    if (!running) {
      // The "what am I doing" hint expires with the turn. A pending wait is NOT
      // cleared here: an approval can outlive the turn's own boundary, and
      // clearing it would silently drop the state this plugin exists to show.
      found.tool = undefined
    }
    this.changed()
  }

  agentDisposed(agent) {
    if (this.sessions.delete(agent.id)) this.changed()
  }

  sessionEvent(session, event) {
    if (!isTopLevel(session)) return
    const found = this.entry(session.id, session)
    const data = event.data ?? {}

    switch (event.type) {
      case 'session/title':
        found.title = data.title
        return

      case 'turn/start':
        // A turn opening is the only reliable "is working" signal available to
        // a plugin-level listener; see setRunning().
        if (!found.running) {
          found.running = true
          found.since = this.now()
          this.changed()
        }
        return

      case 'approval/asked': {
        const body = data.reason || `工具 ${data.toolName} 需要你批准`
        found.pending.set(`approval:${data.id}`, {
          kind: 'approval',
          text: body,
          since: this.now(),
          callId: data.callId,
          toolName: data.toolName,
        })
        this.emit('approval', found, body)
        break
      }

      case 'approval/decided':
        found.pending.delete(`approval:${data.id}`)
        break

      case 'tool/call': {
        found.tool = data.name
        if (data.name !== ASK_TOOL) break
        const batch = parseQuestions(data.arguments)
        if (batch === undefined) break
        const kind = classifyQuestions(batch.questions)
        found.pending.set(`question:${data.callId}`, {
          kind,
          text: questionHeadline(batch.questions),
          questions: batch.questions,
          since: this.now(),
          callId: data.callId,
        })
        this.emit(kind === 'input' ? 'input' : 'choice', found, questionHeadline(batch.questions))
        break
      }

      case 'tool/result': {
        // A ToolResultMessage names the call it answers in `toolCallId`.
        const callId = data.message?.toolCallId ?? data.message?.source?.callId
        if (callId === undefined) return
        let cleared = found.pending.delete(`question:${callId}`)
        // An approval for this call is settled once the call has a result,
        // even if the `approval/decided` event was missed.
        for (const [key, wait] of found.pending) {
          if (wait.callId === callId) cleared = found.pending.delete(key) || cleared
        }
        if (!cleared) return
        break
      }

      case 'turn/end': {
        const outcome = outcomeOf(data.reason)
        found.running = false
        found.pending.clear()
        found.tool = undefined
        if (outcome === undefined) break
        found.last = { kind: outcome.kind, at: this.now(), detail: outcome.detail }
        this.emit(outcome.kind, found, outcome.detail || (outcome.kind === 'completed' ? '任务已完成' : '任务失败'))
        break
      }

      default:
        return
    }

    this.changed()
  }

  /** Aggregate view used by the tray and the notification layer. */
  summary() {
    const running = []
    const waiting = []
    for (const found of this.sessions.values()) {
      if (found.running) {
        running.push({ sessionId: found.id, title: this.labelOf(found), since: found.since, tool: found.tool })
      }
      for (const [key, wait] of found.pending) {
        waiting.push({
          key,
          sessionId: found.id,
          title: this.labelOf(found),
          kind: wait.kind,
          text: clip(wait.text, 60),
          since: wait.since,
        })
      }
    }
    waiting.sort((a, b) => a.since - b.since)
    running.sort((a, b) => (a.since ?? 0) - (b.since ?? 0))
    return { running, waiting }
  }

  /**
   * The single state the menu-bar disc shows.
   *
   * Precedence is fixed and deliberate: anything that needs the user outranks
   * anything that is merely busy, so "needs you" can never be hidden behind a
   * long-running job.
   * @returns {'idle' | 'ongoing' | 'warning'}
   */
  iconState() {
    const { running, waiting } = this.summary()
    if (waiting.length > 0) return 'warning'
    if (running.length > 0) return 'ongoing'
    return 'idle'
  }

  /** Session ids that wait on the user right now. */
  waitingSessions() {
    const ids = new Set()
    for (const found of this.sessions.values()) if (found.pending.size > 0) ids.add(found.id)
    return ids
  }
}
