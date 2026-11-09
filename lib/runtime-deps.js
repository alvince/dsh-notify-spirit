/**
 * Resolve a package the *Harness installation* owns rather than this plugin.
 *
 * A bundle installed from a registry resolves its dependencies from the
 * profile's `node_modules`. A bundle installed from a workspace directory is
 * linked into the profile as a symlink, and Node resolves the real path — so
 * the profile's copy of `@deepseek-ai/schemastery` is not on this module's
 * lookup path, and a plain `import '@deepseek-ai/schemastery'` throws
 * ERR_MODULE_NOT_FOUND at activation.
 *
 * Rather than pin a copy (which would drift from the Harness's own version),
 * resolve the installed one from the Harness roots at activation time. The
 * environment of the Host process is not guaranteed to carry `DSH_PROFILE_DIR`
 * (a desktop launch may not set it), so the roots are also discovered by
 * enumerating `$DSH_HOME/profiles/*`. When nothing resolves, the caller
 * degrades to a plugin without a Config schema: `resolveConfig` passes the raw
 * row config through unchanged, so the plugin still runs — it only loses
 * settings validation and the settings page.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The `$DSH_HOME` this process uses, matching the Harness default. */
export function dshHome(env = process.env) {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Every directory directly under `parent`, or none when it cannot be read. */
function children(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => join(parent, entry.name))
  } catch {
    return []
  }
}

/**
 * Where the Harness keeps node_modules, most specific first.
 *
 * Environment hints come first (cheap and exact when present); the enumerated
 * profiles and runtimes follow, so a Host launched without them still
 * resolves. The enumerated order is stable enough for a lookup that only
 * needs *a* working copy of a Harness-owned package.
 * @param env - environment to read the hints from.
 * @returns absolute candidate roots, without duplicates.
 */
export function harnessRoots(env = process.env) {
  const home = dshHome(env)
  const roots = []
  const profileDir = env.DSH_PROFILE_DIR?.trim()
  if (profileDir) roots.push(profileDir)
  const profile = env.DSH_PROFILE?.trim()
  if (profile) roots.push(join(home, 'profiles', profile))
  roots.push(...children(join(home, 'profiles')))
  roots.push(
    join(home, 'dsh-runtimes', 'dsh-primary-runtime'),
    ...children(join(home, 'dsh-runtimes')),
  )
  return [...new Set(roots)]
}

/**
 * Import a package from one Harness root, following its `exports['.'].import`
 * entry the same way Node would for an ESM importer. The CJS entry is skipped
 * on purpose: schemastery's CJS build requires an ESM-only sibling and
 * `require()` throws ERR_REQUIRE_ESM on it.
 * @param root - directory whose node_modules holds the package.
 * @param name - package name to load.
 * @returns the module namespace, or undefined when this root cannot supply it.
 */
async function loadFrom(root, name) {
  try {
    const require = createRequire(join(root, 'noop.cjs'))
    const manifest = require.resolve(`${name}/package.json`)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const entry = pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main
    if (typeof entry !== 'string') return undefined
    const file = join(dirname(manifest), entry)
    if (!existsSync(file)) return undefined
    return await import(pathToFileURL(file).href)
  } catch {
    return undefined
  }
}

const cache = new Map()

/**
 * Load a package from the Harness installation, or `undefined`.
 * @param name - package name, e.g. `@deepseek-ai/schemastery`.
 * @returns the module's default export when it has one, else the namespace.
 */
export async function loadHarnessPackage(name) {
  if (cache.has(name)) return cache.get(name)
  let found
  for (const root of harnessRoots()) {
    const module = await loadFrom(root, name)
    if (module === undefined) continue
    const value = module.default ?? module
    if (value !== undefined && value !== null) {
      found = value
      break
    }
  }
  cache.set(name, found)
  return found
}
