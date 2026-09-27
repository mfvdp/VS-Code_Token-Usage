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
  /**
   * Unix ms of the next attempt our own fetch wants — a backoff's end included (1.7 P4b: the
   * state's `nextAttemptAt`) — or null. Printed as `next attempt` (1.7 P7b; before, `backoff until`).
   */
  backoffEndsAt: number | null
  /**
   * 1.7 P4b: our own last failed attempt — its kind and its time (Unix ms), never its words; null or
   * absent where the last attempt succeeded or none was made. Every kind, the permanent ones too.
   */
  lastFailure?: { kind: string; at: number } | null
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

/**
 * 1.12 A (§2.1, §0a.11): the Codex app-server line — the configured mode and where the standing
 * connection is. `follower` in a window that does not lead (it keeps no child); `off` where no child
 * runs — `oneShot`, a closed gate, no binary. Counts and an age only: no pid, no path, no line of the
 * server's.
 */
export interface CodexConnectionDiag {
  mode: 'oneShot' | 'persistent'
  state: 'off' | 'starting' | 'ready' | 'restarting' | 'budgetSpent' | 'follower'
  restartsLastHour: number
  pushes: number
  lastPushAgeSec: number | null
}

/** 1.12 A: the modes and states the line may print — anything else is printed as `?`. */
const CODEX_MODES: readonly string[] = ['oneShot', 'persistent']
const CODEX_STATES: readonly string[] = ['off', 'starting', 'ready', 'restarting', 'budgetSpent', 'follower']

/**
 * 1.12 A: the manager's `appServerStatus()` as the diagnostics line takes it — a follower's state is
 * `follower` whatever its (absent) connection says, the last push as an age at `now` (ms).
 */
export function codexConnectionDiag(
  s: {
    mode: 'oneShot' | 'persistent'
    role: 'leader' | 'follower'
    state: Exclude<CodexConnectionDiag['state'], 'follower'>
    restartsLastHour: number
    pushes: number
    lastPushAt: number | null
  },
  now: number,
): CodexConnectionDiag {
  const age = s.lastPushAt === null || !Number.isFinite(s.lastPushAt) ? null : Math.max(0, (now - s.lastPushAt) / 1000)
  return {
    mode: s.mode,
    state: s.role === 'follower' ? 'follower' : s.state,
    restartsLastHour: s.restartsLastHour,
    pushes: s.pushes,
    lastPushAgeSec: age,
  }
}

/**
 * 1.12 B7 (§0a.11): where the Claude token came from and where the macOS Keychain stands — a source's name and
 * a state word, never a token, an account or an item's attribute. `source` is null before a Claude poll of
 * this window, `none` when the last one found no token.
 */
export interface CredentialsDiag {
  source: 'env' | 'keychain' | 'file' | 'secretTool' | 'none' | null
  keychain: 'off' | 'notDarwin' | 'unasked' | 'denied' | 'gateClosed' | 'allowed'
}

/** 1.12 B7: the words the credentials line may print — anything else is printed as `?`. */
const CREDENTIAL_SOURCES: readonly string[] = ['env', 'keychain', 'file', 'secretTool', 'none']
const KEYCHAIN_STATES: readonly string[] = ['off', 'notDarwin', 'unasked', 'denied', 'gateClosed', 'allowed']

/**
 * 1.12 B7: the Keychain's state for the line — `off` with `tokenPace.credentials.keychain` off, `notDarwin`
 * elsewhere than macOS, then the Keychain consent (`unasked`, `denied`), then the window's gate: `allowed`
 * while background reads may read it, `gateClosed` while only a fetch by hand may (untried or closed).
 */
export function credentialsDiag(s: {
  source: CredentialsDiag['source']
  platform: string
  setting: boolean
  consent: 'granted' | 'denied' | 'unasked'
  gate: 'untried' | 'open' | 'closed'
}): CredentialsDiag {
  const keychain: CredentialsDiag['keychain'] = !s.setting ? 'off'
    : s.platform !== 'darwin' ? 'notDarwin'
      : s.consent === 'unasked' ? 'unasked'
        : s.consent === 'denied' ? 'denied'
          : s.gate === 'open' ? 'allowed' : 'gateClosed'
  return { source: s.source, keychain }
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
  /** 1.12 A: the Codex app-server line; null where the caller has none to report. */
  codexConnection: CodexConnectionDiag | null
  /** 1.12 B7: the credentials line; null where the caller has none to report. */
  credentials: CredentialsDiag | null
  consent: string
  role: 'leader' | 'follower' | 'single'
  bridge: BridgeDiag | null
  http: { proxy: HttpSetting; proxySupport: HttpSetting; proxyStrictSSL: HttpSetting }
  /** Proxy environment variables that are set, values still unmasked. */
  proxyEnv: Array<{ name: string; value: string }>
  settings: Record<string, unknown>
  partialData: boolean
  attribution: string
  /**
   * 1.9 A: the language line — the setting (`auto` or a registry id), the language whose words are
   * shown (a registry id) and VS Code's display language, held to `[a-z0-9-]{1,20}` by the caller
   * (`vscodeLanguageTag`), '' when it is not such a tag. Held to that alphabet again here.
   */
  language: { setting: string; shown: string; vscode: string }
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
  'roots', 'fileCount', 'snapshot', 'retention', 'historySize', 'quota', 'codexConnection', 'credentials', 'consent', 'role',
  'bridge', 'http', 'proxyEnv', 'settings', 'partialData', 'attribution', 'language', 'home',
]

/** Setting keys whose values are paths and are therefore shortened. */
const PATH_KEY_RE = /Dir|File|Binary|LogFile/
/** Defence in depth: no current setting matches, and none ever should. */
const SECRET_KEY_RE = /token|secret|password|apikey|api_key|bearer/i
/**
 * 1.12 §0a.11 (Review 2 F1): the fields of the `tokenPace.notifications.*` objects that hold a host, an address, a
 * chat id or a URL — the SMTP server and account, the sender and the recipient, the Telegram chat, the ntfy
 * server. The report says whether each is set, never what it is: "paste this anywhere" holds for a reader who
 * set up a channel too. The port, the security mode, the webhook's format and the two lists stay as they are.
 */
const NOTIFY_ADDRESS_FIELDS: readonly string[] = ['host', 'user', 'from', 'to', 'chatId', 'server']

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
  let out = text.split(h).join('~')
  // A Windows home inside already-serialised JSON has every separator doubled
  // (`C:\\Users\\jane`), so the raw form above never matches it. Callers should
  // scrub before serialising; this second pass is what saves the ones that do not.
  const escaped = JSON.stringify(h).slice(1, -1)
  if (escaped !== h) out = out.split(escaped).join('~')
  return out
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

/** A language tag as the report prints it: `[a-z0-9-]{1,20}`, else `–`. */
function tagOf(v: unknown): string {
  return typeof v === 'string' && /^[a-z0-9-]{1,20}$/.test(v) ? v : '–'
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

/**
 * One setting as the report prints it.
 *
 * `tildify` handles the values that *are* a path; `scrubHome` handles everything
 * else — a home directory inside a value under a key the path pattern does not
 * match would otherwise be the one place where the report breaks its own promise.
 *
 * Both run inside the `JSON.stringify` replacer, i.e. on the raw strings and not
 * on the serialised text: on Windows serialisation doubles every separator, so a
 * scrub applied to the finished JSON would look for `C:\Users\jane` in a string
 * that by then reads `C:\\Users\\jane` and leave the account name standing.
 */
function settingValue(key: string, value: unknown, home: string): string {
  const short = key.startsWith('tokenPace.') ? key.slice('tokenPace.'.length) : key
  if (SECRET_KEY_RE.test(short)) return '<redacted>'
  if (value === undefined) return 'undefined'
  // 1.12 §0a.11 (Review 2 F1): a channel's host, address, chat id or server as set / not set.
  const shown = short.startsWith('notifications.') ? withoutAddresses(value) : value
  const isPath = PATH_KEY_RE.test(short)
  const replacer = (_k: string, v: unknown): unknown =>
    typeof v === 'string' ? scrubHome(isPath ? tildify(v, home) : v, home) : v
  try {
    return JSON.stringify(shown, replacer) ?? String(shown)
  } catch {
    return '<unserialisable>'
  }
}

/** `set` for a value that is there — a non-blank string or anything else but null —, `not set` otherwise. */
function setOrNot(v: unknown): 'set' | 'not set' {
  if (v === undefined || v === null) return 'not set'
  if (typeof v === 'string') return v.trim().length > 0 ? 'set' : 'not set'
  return 'set'
}

/**
 * 1.12 §0a.11 (Review 2 F1): a notification setting as the report may print it — each of
 * `NOTIFY_ADDRESS_FIELDS` of an object as `set` / `not set`, every other field and the lists as they are.
 * No notification setting is a bare string, so one there was typed by hand where an object belongs (an
 * address, a URL) and is printed as `set` too.
 */
function withoutAddresses(value: unknown): unknown {
  if (typeof value === 'string') return setOrNot(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = NOTIFY_ADDRESS_FIELDS.includes(k) ? setOrNot(v) : v
  }
  return out
}

/** A whole count as the report prints it; anything else is `–`. */
function countOf(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(Math.round(v)) : '–'
}

/**
 * 1.12 A: `codex connection — mode persistent · state ready · restarts 0 in the last hour · pushes 3 · last
 * push 42 s ago`. The mode and the state are held to their words, the rest to counts and an age.
 */
function codexConnectionLine(c: CodexConnectionDiag | null): string {
  if (c === null) return 'codex connection — not reported'
  const mode = CODEX_MODES.includes(c.mode) ? c.mode : '?'
  const state = CODEX_STATES.includes(c.state) ? c.state : '?'
  const last = c.lastPushAgeSec === null ? '–' : `${ageLabel(c.lastPushAgeSec)} ago`
  return `codex connection — mode ${mode} · state ${state} · restarts ${countOf(c.restartsLastHour)} in the last hour`
    + ` · pushes ${countOf(c.pushes)} · last push ${last}`
}

/**
 * 1.12 B7: `credentials — source keychain · keychain allowed`. Both held to their words; the source `–` before
 * a Claude poll of this window.
 */
function credentialsLine(c: CredentialsDiag | null): string {
  if (c === null) return 'credentials — not reported'
  const source = c.source === null ? '–' : CREDENTIAL_SOURCES.includes(c.source) ? c.source : '?'
  const keychain = KEYCHAIN_STATES.includes(c.keychain) ? c.keychain : '?'
  return `credentials — source ${source} · keychain ${keychain}`
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
    snapshot, retention, historySize, quota, codexConnection, credentials, consent, role, bridge, http, proxyEnv, settings,
    partialData, attribution, language, home,
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
  // 1.9 A (§2.4): which language the texts are in and why — the report itself stays English.
  lines.push(row('Language', `setting ${tagOf(language.setting)} · shown ${tagOf(language.shown)} · VS Code ${tagOf(language.vscode)}`))
  lines.push(row('PARTIAL_DATA', partialData ? 'yes — some figures below cover only part of the sources' : 'no'))
  lines.push('')

  lines.push('## Data')
  // The caller shortens the roots; scrubbing them again costs nothing and means the
  // promise does not depend on a caller getting it right.
  lines.push(row('Roots', roots.length > 0 ? roots.map((r) => safe(scrubHome(r, home))).join(', ') : 'none'))
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
    // 1.7 P7b: the next attempt we want, whatever holds it back until then — a backoff after a
    // failure, or a fresh reading of another source that answers the fetch until it turns old.
    const next = q.backoffEndsAt === null || !Number.isFinite(q.backoffEndsAt)
      ? 'none'
      : new Date(q.backoffEndsAt).toISOString()
    // 1.7 P4b: the kind and the time of our own last failed attempt — the kind is one of our codes,
    // held to their alphabet anyway; the reason's words are never handed to this module.
    const f = q.lastFailure
    const failed = f && typeof f.at === 'number' && Number.isFinite(f.at) && typeof f.kind === 'string'
      ? `${new Date(f.at).toISOString()} [${f.kind.replace(/[^A-Za-z]/g, '').slice(0, 32) || '?'}]`
      : 'none'
    lines.push(`${safe(q.source)} — next attempt ${next} · last failed attempt ${failed}`)
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
  // 1.12 A (§0a.11): which Codex mode is live — "the diagnostics line says which mode is live".
  lines.push(codexConnectionLine(codexConnection))
  // 1.12 B7 (§0a.11): where the Claude token came from — a source's name, never the token.
  lines.push(credentialsLine(credentials))
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
