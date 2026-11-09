/**
 * Where this plugin keeps its runtime files.
 *
 * `$DSH_HOME` is the same variable the Harness itself uses; without it the
 * default is `~/.dsh`. The directory is namespaced per plugin so removing the
 * plugin leaves an obvious, self-contained folder behind.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The `$DSH_HOME` this process uses. */
export function dshHome(env = process.env) {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** This plugin's private state directory. */
export function stateDir(env = process.env) {
  return join(dshHome(env), 'storages', 'dsh-notify-spirit')
}

/** The Web GUI origin, when this Host serves one. */
export function webOrigin(ctx) {
  try {
    return ctx.get('webApp')?.getAdvertisedUrl?.()
  } catch {
    return undefined
  }
}
