/**
 * A file-backed log.
 *
 * The host's own logger is not reachable from a browser-less plugin (nothing
 * prints it during a normal session), which made every verification round here
 * a guess: a silent failure looked exactly like "nothing happened". This writes
 * to the plugin's state directory and falls back to the package tree, so a
 * trace exists regardless of how the host was launched.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDir } from './paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Kept small: this is a diagnostic aid, not a history. */
const MAX_BYTES = 512 * 1024

/** Candidate sinks, most useful first. */
const SINKS = [
  join(stateDir(), 'notify-spirit.log'),
  join(HERE, '..', 'notify-spirit.log'),
]

let resolved

function sink() {
  if (resolved !== undefined) return resolved
  for (const file of SINKS) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, '')
      resolved = file
      return file
    } catch {}
  }
  resolved = null
  return null
}

/**
 * Append one line.
 * @param {string} level - short tag, e.g. `warn`.
 * @param {string} message
 */
export function log(level, message) {
  const file = sink()
  if (file === null) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`)
  } catch {}
}

export const logger = {
  debug: message => log('debug', message),
  info: message => log('info', message),
  warn: message => log('warn', String(message && message.stack ? message.stack : message)),
  error: message => log('error', String(message && message.stack ? message.stack : message)),
}

/** Where this log ended up, for the startup banner. */
export const logPath = () => sink() ?? '(unwritable)'
