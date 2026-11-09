/**
 * The menu-bar icon driver.
 *
 * One helper process owns the status item; the host feeds it a view through an
 * atomically rewritten JSON file and receives menu clicks as JSON lines on
 * stdout. The helper watches the host pid, so a crashed host never leaves an
 * orphan icon, and it is restarted with backoff when it exits unexpectedly.
 *
 * Only darwin has a menu bar of this kind. Other platforms get an inert
 * driver so the rest of the plugin does not need to branch.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, '..', '..', 'assets', 'tray-darwin.js')
/** White-on-transparent whale; the helper tints it per state. */
const WHALE = join(HERE, '..', '..', 'assets', 'whale.png')

/** Give up restarting a helper that keeps dying this many times in a row. */
const MAX_RESTARTS = 5
/** How long a helper gets to exit on its own after `quit` before it is killed. */
const QUIT_GRACE_MS = 1500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Kill helper processes left behind by an earlier host that died without
 * unloading this plugin.
 *
 * The helper cannot probe its parent (JXA has no usable kill, NSTask is
 * blocked by the sandbox, and NSRunningApplication does not track plain Node
 * processes), so orphan cleanup is the host's job. Anything running this
 * plugin's helper script against this profile's state file but not owned by
 * the current pid is stale by definition.
 */
function reapOrphans() {
  try {
    const listed = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 })
    if (listed.status !== 0 || typeof listed.stdout !== 'string') return
    for (const line of listed.stdout.split('\n')) {
      if (!line.includes(HELPER)) continue
      const pid = Number(line.trim().split(/\s+/u)[0])
      if (!Number.isInteger(pid) || pid === process.pid) continue
      // Only the current host may own this helper; a different owner pid is stale.
      const owner = Number(line.trim().split(/\s+/u).pop())
      if (owner === process.pid) continue
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  } catch {}
}

/**
 * Replace `file` with `tmp`, retrying the transient EPERM/EBUSY a rename can
 * hit while the helper has the file open for its read.
 */
async function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
      await sleep(20 * (attempt + 1))
    }
  }
}

/** Whether this platform has a menu-bar seat at all. */
export function traySupported(platform = process.platform) {
  return platform === 'darwin'
}

/**
 * Start the status item.
 * @param {object} options
 * @param {string} options.stateDir - directory for view.json.
 * @param {(action: string) => void} options.onAction - menu click handler.
 * @param {object} [options.logger]
 * @returns {Promise<{update: (view: object) => Promise<unknown>, stop: () => Promise<void>, alive: boolean}>}
 */
export async function startTray({ stateDir, onAction, logger }) {
  if (!traySupported()) {
    return {
      alive: false,
      async update() {},
      async stop() {},
    }
  }

  const viewFile = join(stateDir, 'view.json')
  await mkdir(dirname(viewFile), { recursive: true })

  let child
  let stopped = false
  let restarts = 0
  let lastView
  let writing = Promise.resolve()

  const write = view => {
    lastView = view
    // Serialize writes so an older view never lands after a newer one.
    writing = writing
      .then(async () => {
        const tmp = `${viewFile}.tmp`
        await writeFile(tmp, JSON.stringify(lastView))
        await replaceFile(tmp, viewFile)
      })
      .catch(error => logger?.warn?.('写入托盘状态失败', error))
    return writing
  }

  const launch = () => {
    child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', HELPER, viewFile, String(process.pid), WHALE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const startedAt = Date.now()
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const { action } = JSON.parse(line)
        if (action === 'hide-tray') stopped = true
        if (typeof action === 'string') onAction(action)
      } catch {}
    })
    child.stderr.on('data', chunk => logger?.debug?.('tray helper:', String(chunk).trim()))
    child.on('error', error => {
      child = undefined
      logger?.warn?.('托盘进程启动失败', error)
    })
    // 'close' (not 'exit') fires only after stdout drained, so a final
    // {"action":"hide-tray"} line is handled before we decide to restart.
    child.on('close', code => {
      child = undefined
      if (stopped) return
      restarts = Date.now() - startedAt > 60_000 ? 1 : restarts + 1
      if (restarts > MAX_RESTARTS) {
        logger?.warn?.(`托盘进程连续退出 ${MAX_RESTARTS} 次，已停用（退出码 ${code}）`)
        return
      }
      setTimeout(() => {
        if (!stopped) launch()
      }, 1000 * restarts)
    })
  }

  await write({ state: 'idle', title: '', tooltip: 'DeepSeek Harness', menu: [] })
  reapOrphans()
  launch()

  return {
    get alive() {
      return child !== undefined
    },
    update(view) {
      return write(view)
    },
    async stop() {
      stopped = true
      const running = child
      if (!running) return
      // Ask nicely first: the helper takes its icon down and exits by itself.
      const exited = new Promise(resolve => running.once('close', resolve))
      const timer = setTimeout(() => running.kill(), QUIT_GRACE_MS)
      await write({ ...lastView, quit: true })
      await exited
      clearTimeout(timer)
    },
  }
}
