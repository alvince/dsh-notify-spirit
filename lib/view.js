/**
 * The tray view model: what the helper renders for one snapshot of state.
 *
 * The menu is the decision surface, so its shape follows one rule: anything
 * that needs the user is reachable in at most two clicks, and the options for
 * a pending question are the rows themselves. A menu that merely says "1 item
 * waiting" would just be a slower way to open the window.
 *
 * Kept free of Harness imports so the shape can be unit-tested directly.
 */

/** Menu-row label cap: menu items do not wrap, they truncate. */
const ROW_MAX = 52
/** Submenu rows are narrower, since submenus open toward the screen edge. */
const SUB_MAX = 40

const trim = (text, max = ROW_MAX) => {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The glyph and wording for one kind of pending decision. */
const KIND = {
  approval: { icon: '🔐', label: '批准' },
  choice: { icon: '🔘', label: '选择' },
  input: { icon: '✏️', label: '输入' },
  'plan-review': { icon: '📋', label: '计划' },
  question: { icon: '🔘', label: '选择' },
}

/** Title text beside the disc. */
export function titleOf(state, summary, style) {
  if (style === 'icon') return ''
  const waiting = summary.waiting.length
  const running = summary.running.length
  if (style === 'count') {
    if (waiting > 0) return String(waiting)
    if (running > 0) return String(running)
    return ''
  }
  if (waiting > 0) return `待决 ${waiting}`
  if (running > 0) return `运行中 ${running}`
  return ''
}

/** One line explaining the current pose, for the hover tooltip. */
export function tooltipOf(state, summary) {
  const waiting = summary.waiting.length
  const running = summary.running.length
  if (state === 'warning') {
    const first = summary.waiting[0]
    return first ? `需要你：${trim(first.text, 60)}` : '有事项需要你处理'
  }
  if (state === 'ongoing') {
    const first = summary.running[0]
    const tail = running > 1 ? ` 等 ${running} 个会话` : ''
    return first ? `运行中：${trim(first.title, 40)}${tail}` : `运行中 ${running} 个会话`
  }
  return 'DeepSeek Harness 空闲'
}

/** "刚开始" / "3 分钟" / "1 小时 20 分". */
export function elapsed(since, now) {
  if (since === undefined) return ''
  const minutes = Math.floor((now - since) / 60_000)
  if (minutes < 1) return '刚开始'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/**
 * Rows for one pending decision.
 *
 * A claim this plugin holds carries `actions` (the exact options the request
 * offered) and becomes an actionable submenu. A wait the tracker merely
 * observed has no actions — the window owns that request — so it only offers a
 * jump to the Session.
 * @param {object} wait
 * @returns {object[]} menu rows for the submenu.
 */
function decisionRows(wait) {
  const rows = []
  const actions = Array.isArray(wait.actions) ? wait.actions : []

  // A wait the window owns (never claimed, or handed back to it) offers no
  // actions here. Saying so is the honest thing: the row looks clickable but
  // nothing on it would do anything, which is what made an earlier build look
  // like a dead menu.
  if (actions.length === 0 && wait.inWindow === true) {
    rows.push({ label: '在 DSH 窗口中处理', enabled: false })
    rows.push({ separator: true })
    rows.push({ label: '打开会话', action: `open:${wait.sessionId}` })
    return rows
  }
  const grouped = actions.some(action => action.group !== undefined)

  if (!grouped && wait.text) rows.push({ label: trim(wait.text, SUB_MAX), enabled: false })

  if (actions.length > 0) {
    if (rows.length > 0 && !grouped) rows.push({ separator: true })
    let lastGroup
    for (const action of actions) {
      if (grouped) {
        // One section per question, since the batch is answered in order.
        if (action.group !== lastGroup) {
          if (lastGroup !== undefined) rows.push({ separator: true })
          lastGroup = action.group
          // Already-answered questions stay visible as a progress line: without
          // it the menu looks like it lost the earlier answers.
          for (const done of wait.answered ?? []) {
            rows.push({ label: trim(`✓ ${done.label}：${done.answer}`, SUB_MAX), enabled: false })
          }
          if ((wait.answered ?? []).length > 0) rows.push({ separator: true })
          rows.push({
            label: trim(`${action.groupIndex}/${action.groupTotal} ${action.group ?? ''}`, SUB_MAX),
            enabled: false,
          })
        }
      }
      rows.push({
        label: trim(`· ${action.label}`, SUB_MAX),
        // `|` separates the pieces: neither a claim id nor a verb may contain
        // it, unlike `:` which both use internally.
        action: `answer:${wait.claimId}|${action.verb}`,
      })
    }
  }

  if (rows.length > 0) rows.push({ separator: true })
  rows.push({ label: '打开会话', action: `open:${wait.sessionId}` })
  return rows
}

/**
 * Build the menu rows.
 * @param {object} options
 * @param {object} options.summary - `{waiting, running}` from the tracker plus held claims.
 * @param {number} options.now
 * @param {number} options.rows - how many pending decisions to list inline.
 * @param {boolean} options.showRunning - list running Sessions.
 * @param {string[]} [options.workspaces] - workspace labels, for grouping.
 * @returns {object[]} rows for the helper.
 */
export function menuOf({ summary, now, rows = 3, showRunning = true, notifyReady = true }) {
  const menu = []

  // Anything blocked on the user comes first, always. A long-running job must
  // never push a decision below the fold.
  const waiting = summary.waiting
  for (const wait of waiting.slice(0, rows)) {
    const kind = KIND[wait.kind] ?? KIND.question
    menu.push({
      label: trim(`${kind.icon} ${kind.label} · ${wait.title}`, ROW_MAX),
      children: decisionRows(wait),
    })
  }

  if (waiting.length > rows) {
    const rest = waiting.slice(rows)
    menu.push({
      label: `还有 ${rest.length} 项待你处理…`,
      children: rest.map(wait => {
        const kind = KIND[wait.kind] ?? KIND.question
        return {
          label: trim(`${kind.icon} ${kind.label} · ${wait.title}`, SUB_MAX),
          children: decisionRows(wait),
        }
      }),
    })
  }

  const running = showRunning ? summary.running : []
  if (waiting.length > 0 && running.length > 0) menu.push({ separator: true })

  if (running.length > 0) {
    // Grouped by workspace so several Sessions of one project read together.
    const groups = new Map()
    for (const run of running) {
      const key = run.workspace ?? ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(run)
    }
    for (const [workspace, items] of groups) {
      const rowFor = run => {
        const age = elapsed(run.since, now)
        const tool = run.tool ? ` · ${run.tool}` : ''
        return {
          label: trim(`⏳ ${run.title}${tool}${age ? `（${age}）` : ''}`, ROW_MAX),
          action: `open:${run.sessionId}`,
        }
      }
      if (workspace) {
        menu.push({
          label: trim(`📁 ${workspace}（${items.length}）`, ROW_MAX),
          children: items.slice(0, 8).map(rowFor),
        })
      } else {
        menu.push(...items.slice(0, 8).map(rowFor))
      }
    }
  }

  if (menu.length === 0) {
    menu.push({ label: '没有进行中的会话', enabled: false })
  }

  if (!notifyReady) {
    // Not silence: the user should be able to fix it from here. Notifications
    // are optional in this plugin, so the row explains rather than alarms.
    menu.push({ separator: true })
    menu.push({ label: '系统通知需要 terminal-notifier', enabled: false })
    menu.push({ label: '点击查看安装方法…', action: 'install-notifier' })
  }

  menu.push({ separator: true })
  menu.push({ label: '隐藏图标', action: 'hide-tray' })
  return menu
}

/**
 * Build the whole view the helper polls.
 * @param {object} options
 * @param {'idle'|'ongoing'|'warning'} options.state
 * @param {object} options.summary
 * @param {object} options.config - live config values.
 * @param {number} options.now
 */
export function buildView({ state, summary, config, now, notifyReady = true }) {
  return {
    state,
    title: titleOf(state, summary, config.iconStyle),
    tooltip: tooltipOf(state, summary),
    menu: menuOf({ summary, now, rows: config.trayRows, showRunning: config.showRunning, notifyReady }),
  }
}
