/**
 * System notifications.
 *
 * A notification here is a *pointer with context*, not a decision surface:
 * clicking it brings DSH forward, where the real card lives. That keeps one
 * decision surface (the tray menu plus the in-window card) instead of three.
 *
 * Delivery is strict: only `terminal-notifier` is used, because it is the only
 * macOS notifier available to a Node process that can both group notifications
 * and take them back again. `osascript display notification` can do neither,
 * and a notification carrying question text that cannot be withdrawn becomes a
 * dead end sitting in Notification Center — exactly the failure this plugin
 * exists to prevent. When `terminal-notifier` is absent the plugin stays
 * silent: the menu-bar disc already turns amber, and opening the menu shows the
 * pending question and its options. Silence is better than a stale notice.
 *
 * Grouping is what makes this robust even if a withdrawal is missed: every
 * notification for one Session shares a group, and a new one replaces the old
 * in place, so a Session can never accumulate more than one.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'



/** Run one child process to completion, resolving whether it succeeded. */
function run(file, args) {
  return new Promise(resolve => {
    try {
      const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('exit', code => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

let cached
/**
 * `terminal-notifier` when installed.
 *
 * Homebrew installs into different prefixes per architecture, and a GUI-launched
 * app does not inherit a login shell's PATH, so the usual binary directories are
 * probed explicitly rather than trusting `PATH` alone.
 * @returns {string | undefined}
 */
export function terminalNotifier(env = process.env) {
  if (env === process.env && cached !== undefined) return cached || undefined
  const usable = file => {
    try {
      return existsSync(file)
    } catch {
      return false
    }
  }
  // Only a copy the user installed themselves is used. The plugin does not
  // ship one: notifications here are a courtesy (every decision is taken in the
  // menu bar), so a third-party binary should not ride along by default.
  const found = [
    ...String(env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
    .filter(Boolean)
    .map(dir => join(dir, 'terminal-notifier'))
    .find(usable)

  if (env === process.env) cached = found ?? ''
  return found
}

/** POSIX shell single-quoted literal. */
const sh = text => `'${String(text).replace(/'/gu, "'\\''")}'`

/** Group name for one Session: its notifications replace each other. */
export const notifierGroup = key => `dsh-notify-spirit.${String(key).replace(/[^\w.-]/gu, '')}`

/** Whether this platform has a notification channel at all. */
export function notifySupported(platform = process.platform) {
  return platform === 'darwin'
}

/**
 * Whether notifications can be delivered *and* withdrawn on this machine.
 * @returns {{ok: boolean, reason?: string}}
 */
export function notifyCapability() {
  if (!notifySupported()) return { ok: false, reason: `通知暂不支持 ${process.platform}` }
  if (terminalNotifier() === undefined) {
    return { ok: false, reason: '未安装 terminal-notifier；状态栏仍会提示' }
  }
  return { ok: true }
}

/** The identifier DSH's desktop app registers. */
export const DSH_BUNDLE_ID = 'com.deepseek.dsh'

/**
 * The deep link that raises DSH and selects one Session.
 *
 * Verified against the desktop app: `dsh://session/<id>` activates the app and
 * lands on that Session, where `open -b com.deepseek.dsh` only raises whatever
 * window was last used. `open dsh://` also works but carries no Session, which
 * is the difference between "DSH is in front" and "the thing that needs you is
 * in front".
 * @param {string} sessionId
 */
export function sessionUrl(sessionId) {
  return `dsh://session/${encodeURIComponent(sessionId)}`
}

/**
 * Every notification this plugin raises carries this subtitle.
 *
 * `terminal-notifier` notifications all appear under one sending app, and a
 * coexisting notifier plugin uses the same title wording ("任务完成"), so
 * without this the two are indistinguishable in Notification Center.
 */
export const SUBTITLE = '通知影子'

/**
 * Show one notification for a Session.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {string} options.key - the Session id; also the notification group.
 * @param {boolean} [options.sound]
 * @returns {Promise<boolean>} whether the notification was actually shown.
 */
export async function notify({ title, body, key, sound = true, subtitle = SUBTITLE }) {
  const capability = notifyCapability()
  if (!capability.ok) return false

  // The group keeps one Session to one notification; the subtitle distinguishes
  // this plugin's notices from another notifier's, which would otherwise share
  // both the sending app (`terminal-notifier`) and the title wording.
  const args = ['-title', title, '-subtitle', subtitle, '-message', body, '-group', notifierGroup(key)]
  if (sound) args.push('-sound', 'Glass')
  // Clicking lands on the Session that needs the user, not merely on DSH. The
  // link is opened through `/usr/bin/open` because `-open` treats the argument
  // as an http(s) URL and would hand a custom scheme to the browser (that is
  // exactly the "clicking opened localhost" bug this replaces).
  args.push('-execute', `/usr/bin/open ${sh(sessionUrl(key))}`)

  return run(terminalNotifier(), args)
}

/**
 * Take back the notification shown for `key`.
 *
 * Safe to call for a Session that never had one: `terminal-notifier -remove`
 * on an empty group is a no-op.
 * @param {string} key - the same key passed to {@link notify}.
 * @returns {Promise<boolean>}
 */
export async function withdraw(key) {
  const capability = notifyCapability()
  if (!capability.ok) return false
  return run(terminalNotifier(), ['-remove', notifierGroup(key)])
}

/** URL for a click that should explain the optional dependency. */
export const NOTIFIER_DOCS = 'https://github.com/julienXX/terminal-notifier#download'

/**
 * Open an https URL in the default browser.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function openUrl(url) {
  if (!/^https?:\/\//u.test(url)) return Promise.resolve(false)
  if (process.platform === 'darwin') return run('/usr/bin/open', [url])
  return Promise.resolve(false)
}

/**
 * Bring DSH to the front.
 * @param {string} [origin] - the Web GUI origin, used when the desktop app is absent.
 */
export async function showApp(origin) {
  if (process.platform === 'darwin') {
    if (await run('/usr/bin/open', ['-b', 'com.deepseek.dsh'])) return true
  }
  if (origin && /^https?:\/\//u.test(origin)) return run('/usr/bin/open', [origin])
  return false
}

/**
 * The bundle identifier of the application in front right now.
 *
 * Used to decide whether the user is actually looking at DSH: `NSWorkspace`
 * knows this for every application, with no permission prompt and no client
 * cooperation, and it sees the desktop app even when the Web GUI is served
 * into a browser (where the frontmost app is the browser, not DSH).
 * @returns {Promise<string | undefined>}
 */
export async function frontmostBundleId() {
  if (process.platform !== 'darwin') return undefined
  return new Promise(resolve => {
    try {
      const child = spawn(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e',
          'ObjC.import("Cocoa");' +
          'var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;' +
          'a && !a.isNil() ? ObjC.unwrap(a.bundleIdentifier) : ""'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', () => resolve(undefined))
      child.on('exit', () => resolve(out.trim() || undefined))
      setTimeout(() => {
        child.kill()
        resolve(undefined)
      }, 2000).unref?.()
    } catch {
      resolve(undefined)
    }
  })
}
