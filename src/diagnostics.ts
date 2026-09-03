// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Copy Diagnostics": a report a user can paste into a public issue without
 * reading it first.
 *
 * The construction is an allow-list, not a redaction pass. A dump-then-blacklist
 * report leaks the first field somebody adds and forgets; here an unknown input
 * key is a thrown error, so the leak cannot be introduced silently — the build
 * fails or the test does. Nothing in here ever sees a token: credentials are
 * read in one place, never stored, and never handed to this module.
 *
 * Paths are shortened to `~`, proxy URLs lose their password, and the settings
 * snapshot is the user's own configuration, which contains no secrets by design
 * (there is no key or endpoint setting at all) — a defensive redaction is
 * applied anyway for anything that later looks like one.
 */

/** Where a `http.*` value came from — the answer to "why is this not what I set?". */
export type SettingOrigin = 'default' | 'user' | 'workspace' | 'remote'

export interface HttpSetting {
  value: unknown
  origin: SettingOrigin
}

export interface CandidateDiag {
  id: string
  ok: boolean
  ageSec: number | null
  problemKind?: string | null
  problem?: string | null
}

export interface QuotaDiag {
  source: string
  candidates: CandidateDiag[]
  /** Unix ms when the next attempt is due (backoff end), or null. */
  backoffEndsAt: number | null
  drift: string[]
}

export interface SnapshotDiag {
  /** Bucket counts by resolution, e.g. `{ h: 210, d: 380, m: 12 }`. */
  buckets: Record<string, number>
  bytes: number
  oldestDay: string | null
  newestDay: string | null
  /** Day of the first ingest, already formatted; null when nothing was read yet. */
  firstIngest: string | null
}

export interface BridgeDiag {
  installed: boolean
  shadowed: boolean
  mirrorAgeMs: number | null
}

export interface DiagnosticsInput {
  extVersion: string
  vscodeVersion: string
  platform: string
  arch: string
  node: string
  remoteName: string | null
  extensionKind: string
  /** Already `~`-shortened by the caller via `tildify`. */
  roots: string[]
  fileCount: number
  snapshot: SnapshotDiag
  retention: { hourDays: number; days: number; historyDays: number }
  historySize: { samples: number; bytes: number; oldest: string | null }
  quota: QuotaDiag[]
  consent: string
  role: 'leader' | 'follower' | 'single'
  bridge: BridgeDiag | null
  http: { proxy: HttpSetting; proxySupport: HttpSetting; proxyStrictSSL: HttpSetting }
  /** Proxy environment variables that are set, values still unmasked. */
  proxyEnv: Array<{ name: string; value: string }>
  settings: Record<string, unknown>
  partialData: boolean
  attribution: string
  /** Home directory, used to shorten paths in the settings snapshot. Never printed. */
  home: string
}

/**
 * The only keys that may appear in the report. Extending this list is a
 * deliberate act with a test behind it; adding a field to `DiagnosticsInput`
 * without touching this line makes `buildDiagnostics` throw.
 */
export const DIAGNOSTICS_FIELDS: readonly string[] = [
  'extVersion', 'vscodeVersion', 'platform', 'arch', 'node', 'remoteName', 'extensionKind',
  'roots', 'fileCount', 'snapshot', 'retention', 'historySize', 'quota', 'consent', 'role',
  'bridge', 'http', 'proxyEnv', 'settings', 'partialData', 'attribution', 'home',
]

/** Setting keys whose values are paths and are therefore shortened. */
const PATH_KEY_RE = /Dir|File|Binary|LogFile/
/** Defence in depth: no current setting matches, and none ever should. */
const SECRET_KEY_RE = /token|secret|password|apikey|api_key|bearer/i

/**
 * Replaces a home prefix with `~`. Comparison is byte-exact, so a path that
 * only differs in case (Windows) stays long rather than being wrongly shortened.
 */
export function tildify(p: string, home: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  if (typeof home !== 'string' || home.length === 0) return p
  const h = home.replace(/[\\/]+$/, '')
  if (h.length === 0) return p
  if (p === h) return '~'
  if (p.startsWith(h)) {
    const next = p.charAt(h.length)
    if (next === '/' || next === '\\') return `~${p.slice(h.length)}`
  }
  return p
}

/**
 * Replaces every occurrence of the home directory inside a free-text string
 * with `~`.
 *
 * `tildify` only shortens a path that *is* the value; the problem strings the
 * quota sources produce carry the path in the middle ("No quota file at
 * /home/jane/.cache/…"). The report promises shortened paths and invites the
 * user to paste it into a public issue, so the account name must not survive
 * anywhere in it.
 */
export function scrubHome(text: string, home: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  if (typeof home !== 'string' || home.length === 0) return text
  const h = home.replace(/[\\/]+$/, '')
  if (h.length === 0) return text
  return text.split(h).join('~')
}

/**
 * Removes the password from a proxy URL: `scheme://user:pass@host:port` becomes
 * `scheme://user:***@host:port`. A value without credentials (or without a
 * scheme, such as a NO_PROXY host list) is returned unchanged.
 */
export function maskProxyUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url
  return url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i,
    (_all, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':')
      if (colon === -1) return `${scheme}${userinfo}@`
      return `${scheme}${userinfo.slice(0, colon)}:***@`
    },
  )
}

/** The six variables Node and the editor look at; only the ones actually set. */
export const PROXY_ENV_NAMES: readonly string[] = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]

export function collectProxyEnv(
  env: Record<string, string | undefined> = process.env,
): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]
    if (typeof value === 'string' && value.length > 0) out.push({ name, value })
  }
  return out
}

// ---------------------------------------------------------------------------
// vscode glue — the module itself stays loadable without an editor
// ---------------------------------------------------------------------------

export interface InspectLike<T> {
  defaultValue?: T
  globalValue?: T
  workspaceValue?: T
  workspaceFolderValue?: T
  /** Present in remote windows; typed optional so older API versions still fit. */
  globalRemoteValue?: T
}

export interface ConfigurationLike {
  get<T>(section: string): T | undefined
  inspect<T>(section: string): InspectLike<T> | undefined
}

export interface VscodeConfigApi {
  workspace: { getConfiguration(section?: string): ConfigurationLike }
}

function originOf<T>(i: InspectLike<T> | undefined): SettingOrigin {
  if (i === undefined) return 'default'
  // Same precedence VS Code applies when it resolves the effective value.
  if (i.workspaceFolderValue !== undefined) return 'workspace'
  if (i.workspaceValue !== undefined) return 'workspace'
  if (i.globalRemoteValue !== undefined) return 'remote'
  if (i.globalValue !== undefined) return 'user'
  return 'default'
}

/** The three `http.*` settings that decide whether our one request can leave. */
export function collectHttpSettings(api: VscodeConfigApi): DiagnosticsInput['http'] {
  const c = api.workspace.getConfiguration('http')
  const one = (key: string): HttpSetting => {
    const value = c.get<unknown>(key)
    return { value, origin: originOf(c.inspect<unknown>(key)) }
  }
  return { proxy: one('proxy'), proxySupport: one('proxySupport'), proxyStrictSSL: one('proxyStrictSSL') }
}

/** The current value of every setting the extension reads, by full key. */
export function collectSettings(api: VscodeConfigApi, keys: readonly string[]): Record<string, unknown> {
  const c = api.workspace.getConfiguration()
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = c.get<unknown>(key)
  return out
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** A value can never break out of the fence it is printed in. */
function safe(s: string): string {
  return s.replace(/```/g, "'''")
}

function ageLabel(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '–'
  if (sec < 90) return `${Math.round(sec)} s`
  const min = sec / 60
  if (min < 90) return `${Math.round(min)} min`
  const h = min / 60
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`
}

function row(label: string, value: string): string {
  return `${label.padEnd(16)}${value}`
}

function settingValue(key: string, value: unknown, home: string): string {
  const short = key.startsWith('tokenPace.') ? key.slice('tokenPace.'.length) : key
  if (SECRET_KEY_RE.test(short)) return '<redacted>'
  if (value === undefined) return 'undefined'
  if (PATH_KEY_RE.test(short)) {
    if (typeof value === 'string') return JSON.stringify(tildify(value, home))
    if (Array.isArray(value)) {
      return JSON.stringify(value.map((v) => (typeof v === 'string' ? tildify(v, home) : v)))
    }
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '<unserialisable>'
  }
}

function httpLine(name: string, s: HttpSetting): string {
  const value = s.value === undefined || s.value === '' ? '–' : JSON.stringify(s.value)
  return `${name.padEnd(22)}(${s.origin}) ${value}`
}

/**
 * Renders the report. Throws when the input carries a key the allow-list does
 * not name — that is the whole point of the function.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const allowed = new Set(DIAGNOSTICS_FIELDS)
  const extras = Object.keys(input as unknown as Record<string, unknown>).filter((k) => !allowed.has(k))
  if (extras.length > 0) {
    throw new Error(`buildDiagnostics: field(s) not in the diagnostics allow-list: ${extras.join(', ')}`)
  }

  const {
    extVersion, vscodeVersion, platform, arch, node, remoteName, extensionKind, roots, fileCount,
    snapshot, retention, historySize, quota, consent, role, bridge, http, proxyEnv, settings,
    partialData, attribution, home,
  } = input

  const lines: string[] = []
  lines.push('Token Pace diagnostics')
  lines.push('Built from a field allow-list: no tokens, no transcript contents, no object dumps.')
  lines.push('')

  lines.push('## Environment')
  lines.push(row('Extension', safe(extVersion)))
  lines.push(row('VS Code', safe(vscodeVersion)))
  lines.push(row('Platform', `${safe(platform)} ${safe(arch)} · Node ${safe(node)}`))
  lines.push(row('Remote', remoteName === null || remoteName === '' ? 'none' : safe(remoteName)))
  lines.push(row('Extension kind', safe(extensionKind)))
  lines.push(row('Role', role))
  lines.push(row('Consent', safe(consent)))
  lines.push(row('Attribution', safe(attribution)))
  lines.push(row('PARTIAL_DATA', partialData ? 'yes — some figures below cover only part of the sources' : 'no'))
  lines.push('')

  lines.push('## Data')
  lines.push(row('Roots', roots.length > 0 ? roots.map(safe).join(', ') : 'none'))
  lines.push(row('Transcripts', `${fileCount} file(s)`))
  const buckets = Object.keys(snapshot.buckets)
    .map((res) => `${res}=${snapshot.buckets[res]}`)
    .join(' ')
  lines.push(row('Snapshot', `${bytesLabel(snapshot.bytes)} · buckets ${buckets || 'none'}`))
  lines.push(row('Days', `${snapshot.oldestDay ?? '–'} … ${snapshot.newestDay ?? '–'} · first ingest ${snapshot.firstIngest ?? '–'}`))
  lines.push(row('Retention', `hours ${retention.hourDays} d · days ${retention.days} d · quota history ${retention.historyDays} d`))
  lines.push(row('Quota history', `${historySize.samples} sample(s) · ${bytesLabel(historySize.bytes)} · oldest ${historySize.oldest ?? '–'}`))
  lines.push('')

  lines.push('## Quota sources')
  if (quota.length === 0) lines.push('none')
  for (const q of quota) {
    const backoff = q.backoffEndsAt === null || !Number.isFinite(q.backoffEndsAt)
      ? 'none'
      : new Date(q.backoffEndsAt).toISOString()
    lines.push(`${safe(q.source)} — backoff until ${backoff}`)
    if (q.candidates.length === 0) lines.push('  (no candidates)')
    for (const c of q.candidates) {
      const kind = c.problemKind ? ` [${safe(c.problemKind)}]` : ''
      // The problem is free text from the source cascade and regularly names an
      // absolute file, so it is scrubbed rather than trusted.
      const problem = c.problem ? ` ${safe(scrubHome(c.problem, home))}` : ''
      lines.push(`  ${c.id.padEnd(14)}${c.ok ? 'ok  ' : 'fail'} ${ageLabel(c.ageSec)}${kind}${problem}`)
    }
    if (q.drift.length > 0) lines.push(`  drift: ${q.drift.map((d) => safe(scrubHome(d, home))).join(', ')}`)
  }
  lines.push('')

  lines.push('## Status line bridge')
  if (bridge === null) {
    lines.push('not installed')
  } else {
    const age = bridge.mirrorAgeMs === null || !Number.isFinite(bridge.mirrorAgeMs)
      ? 'no mirror file'
      : `mirror ${ageLabel(bridge.mirrorAgeMs / 1000)} old`
    const shadow = bridge.shadowed ? ' · configuration-shadowed' : ''
    lines.push(`${bridge.installed ? 'installed' : 'not installed'} · ${age}${shadow}`)
  }
  lines.push('')

  lines.push('## Network setup')
  lines.push(httpLine('http.proxy', http.proxy))
  lines.push(httpLine('http.proxySupport', http.proxySupport))
  lines.push(httpLine('http.proxyStrictSSL', http.proxyStrictSSL))
  if (proxyEnv.length === 0) lines.push('no proxy environment variables set')
  for (const e of proxyEnv) lines.push(`${e.name.padEnd(22)}${safe(maskProxyUrl(e.value))}`)
  lines.push('')

  lines.push('## Settings')
  const keys = Object.keys(settings).sort()
  if (keys.length === 0) lines.push('none')
  for (const key of keys) lines.push(`${safe(key)} = ${safe(settingValue(key, settings[key], home))}`)

  return ['```text', ...lines, '```'].join('\n')
}
