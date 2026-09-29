// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard webview.
 *
 * Three things this file is careful about. Everything it renders comes from the view model —
 * no number is computed here, so the webview cannot drift away from the QuickPick and the
 * markdown view. Everything the webview sends back goes through `parseWebviewMessage`: it is
 * the only untrusted input the extension has, and it may ask for a range, a fold, the
 * settings of one named section or one of twelve named commands, never for a path or a
 * setting id of its own. And updates are per section, so a one-second refresh cannot reset
 * a sort order or throw away the scroll position.
 *
 * No external resource of any kind: the CSP allows exactly the nonced inline style and
 * script this file writes — the style below, and src/webview/main.ts, built to text at build
 * time. The chart, the heatmap and the sparklines are CSS and inline SVG.
 *
 * The page's words are this file's business too: the script cannot import the localisation
 * seam, so every string it shows is translated here and written in front of it as one
 * dictionary — see `webviewWords()` at the bottom.
 */

import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import script from 'webview:script'
import { SOURCES, SOURCE_TITLE } from './adapters'
import { MAX_GROUP_CHILDREN, MAX_MORE_PAGES, SILENT_AFTER_MS } from './agentTree'
import { FLAG_SVG } from './flags'
import { dir, lang, locale, t } from './i18n'
import type { TextDirection } from './languages'
import { WebviewMessage, parseWebviewMessage } from './viewModel'
import type { CacheWatchCard, QuotaCard, ViewModel } from './viewModel'

/**
 * What a section is rebuilt from. A field of the UI state may be named as `ui.<field>`: the
 * fragment then still carries the whole `ui` object — the webview merges a payload field by
 * field — but the section is only rebuilt when that one field changes. Listing the whole
 * `ui` where a single switch is meant replaced the body on every sort, drill and fold, and
 * with it the sideways scroll position of the tables inside it.
 */
type SectionField = keyof ViewModel | `ui.${keyof ViewModel['ui']}`

/**
 * Section keys the webview renders, in the order `dashboard.sections` gives them. Exported for the
 * test that holds a provider switch to exactly the fragments whose fields it changed (1.7 F1).
 */
export const SECTION_FIELDS: Readonly<Record<string, SectionField[]>> = {
  summary: ['digest'],
  quota: ['quotas', 'projectFilterIgnoredBy'],
  // The running list and the tree, and the pieces of view state that decide what of it is open:
  // the nodes the reader opened, the node whose details are shown and under which of its rows
  // (1.6 N2), how many of an open node's children the reader asked to see (1.6 D3), and whether
  // the 7-day block is open (1.6 L3). 1.7 F1: and the provider switch — while it excludes Claude
  // the section is not drawn, `claudeOnly` saying why — so a switch pushes its going and its
  // return as the fragments they are.
  agents: ['agents', 'ui.agentsExpanded', 'ui.agentSelected', 'ui.agentSelectedIn', 'ui.agentsMore', 'ui.agentsWeekOpen', 'provider', 'claudeOnly',
    'projectFilterIgnoredBy'],
  context: ['context', 'provider', 'claudeOnly', 'projectFilterIgnoredBy'],
  kpis: ['kpis'],
  // The cache switch above the composition bars decides which parts are drawn, so the
  // section follows it — and nothing else the reader may do to the view state.
  tokens: ['totals', 'composition', 'cacheEconomy', 'calendar', 'planFactor', 'ui.compositionCache', 'projectFilterIgnoredBy'],
  chart: ['chart'],
  models: ['models'],
  heatmap: ['heatmap'],
  hours: ['hours'],
  records: ['records'],
  tools: ['tools', 'projectFilterIgnoredBy'],
  budget: ['budgets', 'projectFilterIgnoredBy'],
  history: ['retro', 'projectFilterIgnoredBy'],
  projects: ['projects'],
  sessions: ['sessions'],
  dataQuality: ['dataQuality', 'projectFilterIgnoredBy'],
  // 1.10 A: the reader's prompt list — the intro, the target line, the flash, the entries (P3, P4); the page draws
  // it since P5, and keeps its open fields across every push of it. 1.14 A5 rule 4: every section the project filter
  // does not reach — and the Tokens section, which it does reach from above the bar — draws a line about it while a
  // project chip is pressed, so each is rebuilt when the list of those sections comes or goes (`projectFilterIgnoredBy`);
  // the bar is rebuilt from its chips (`projectFilter`).
  prompts: ['prompts', 'projectFilterIgnoredBy'],
  drill: ['drill'],
  // Chrome that is always present. `footer` carries the generated-at line, which changes on
  // every tick — keeping it in its own node is what stops a full re-render every minute.
  // 1.7 F1: the provider switch, the page's first block. 1.9 A3: the block is the page's top row — the
  // switch and the language picker beside it —, so it is drawn from both.
  provider: ['provider', 'language'],
  notices: ['firstRun', 'preview'],
  controls: ['range', 'ui', 'models', 'projectFilter'],
  footer: ['footnotes', 'pricing', 'generatedAt'],
}

/**
 * 1.8 L-1: the sections whose body the page leaves out while the view excludes Claude — the page's
 * `CLAUDE_ONLY_SECTIONS` (1.7 F1, §7a Q7). Under such a view their fields are still built whole —
 * the host reads the tree for the agent poll and the status bar — but the page drops every fragment
 * of them after the one that took the section out (`placeSection`), unread.
 */
const CLAUDE_ONLY_KEYS: readonly string[] = ['agents', 'context']

/** 1.8 L-1: what of such a section decides whether the page has it — the view and the reason it is left out. */
const CLAUDE_ONLY_VIEW: SectionField[] = ['provider', 'claudeOnly']

/**
 * 1.8 L-3: the view-model fields no push carries — the host's own. `allBudgets` (1.7 F1) is every
 * budget whatever the switch shows, for the status bar's budget item and the budget alerts
 * (extension.ts); no view prints it, the page never reads it, and under All it is the `budgets` rows
 * a second time. No section is built from one of them (`SECTION_FIELDS`), so a fragment never
 * carries one either. Exported for the tests that hold every push to it.
 */
export const HOST_ONLY_FIELDS = ['allBudgets'] as const satisfies readonly (keyof ViewModel)[]

/**
 * 1.8 P10 (§7c wave 2 fact 10): the parts of a quota card's prompt-cache block no push carries —
 * `all` (every watched session, warm ones too, at most ten) and `allMoreText` are the markdown
 * document's, which the host builds from its own view model; the page draws `lines` and `moreText`
 * only. The bar and the text views keep reading them in the host. Exported for the tests.
 */
export const HOST_ONLY_CACHE_FIELDS = ['all', 'allMoreText'] as const satisfies readonly (keyof CacheWatchCard)[]

/** A quota card's prompt-cache block as the page gets it. */
export type PageCacheWatch = Omit<CacheWatchCard, typeof HOST_ONLY_CACHE_FIELDS[number]>
/** A quota card as the page gets it — its block without the host's parts. */
export type PageQuotaCard = Omit<QuotaCard, 'cacheWatch'> & { cacheWatch: PageCacheWatch | null }
/** The view model as the page gets it. */
export type PageViewModel = Omit<ViewModel, typeof HOST_ONLY_FIELDS[number] | 'quotas'> & { quotas: PageQuotaCard[] }

/** 1.8 P10: the quota cards as the page gets them — each block without HOST_ONLY_CACHE_FIELDS. */
export function pageQuotas(quotas: readonly QuotaCard[]): PageQuotaCard[] {
  if (!Array.isArray(quotas)) return quotas as unknown as PageQuotaCard[]
  return quotas.map((q) => {
    const cw = q && q.cacheWatch
    if (!cw || typeof cw !== 'object') return q as PageQuotaCard
    const block: Record<string, unknown> = { ...cw }
    for (const f of HOST_ONLY_CACHE_FIELDS) delete block[f]
    return { ...q, cacheWatch: block as unknown as PageCacheWatch }
  })
}

/**
 * 1.8 L-3: the view model as the page gets it — every field but HOST_ONLY_FIELDS; 1.8 P10: and every
 * quota card's block without HOST_ONLY_CACHE_FIELDS.
 */
export function pagePayload(vm: ViewModel): PageViewModel {
  const o: Record<string, unknown> = { ...vm }
  for (const f of HOST_ONLY_FIELDS) delete o[f]
  o.quotas = pageQuotas(vm.quotas)
  return o as PageViewModel
}

/**
 * 1.9 A3.4: the page's words as a whole push carries them after a switch — the words' language (the
 * page's `lang`), the Intl tag its own numbers use, and exactly the dictionary `webviewDictionary()`
 * writes into a new page, every value HTML-escaped (the markup rule holds on the push path too).
 * 1.13 A2 rule 1 (§0a.1): and the words' direction (the page's `dir`) — the words' language's, never VS Code's
 * (`i18n.ts` `dir()`), so a switch at run time turns the page without a reload.
 */
export interface PageWords {
  lang: string
  locale: string
  dir: TextDirection
  dict: Record<string, string>
}

/** 1.9 A3.4: the words of now, for a whole push. */
export function pageWords(): PageWords {
  return { lang: lang(), locale: locale(), dir: htmlDir(), dict: webviewDictionaryObject() }
}

/** A field of the view model as a push carries it: the quota cards without the host's parts (1.8 P10). */
function pageField(vm: ViewModel, f: keyof ViewModel): unknown {
  return f === 'quotas' ? pageQuotas(vm.quotas) : vm[f]
}

/**
 * The page's language, for the browser and for a screen reader: the language its words are in
 * (`lang()`, 1.9 A3.5) — `en`, `de`, `pt-BR`, `zh-CN`, `zh-TW`. A page whose words are German but
 * whose markup claims English is read out in the wrong accent, hyphenated by the wrong rules and
 * quoted with the wrong marks. Until 1.8 this was the primary subtag of the formatters' locale, so
 * an English page under VS Code's `hu` claimed Hungarian, and both Chinese pages would have claimed
 * `zh` — a browser picks Han glyph forms and fonts by `lang`, so the region stays now.
 */
function htmlLang(): string {
  return lang()
}

/**
 * 1.13 A2 rule 1 (§0a.1): the page's direction — the words' language's (`dir()`, set by `applyLanguage` from the
 * registry's `languageDir`), exactly 'ltr' or 'rtl': the allow-list the page's `applyWords` holds a push to as well.
 * Never `auto` on the root — the words' language is known — and never VS Code's tag: an English page under VS Code's
 * `ar` without the Arabic bundle is left to right.
 */
function htmlDir(): TextDirection {
  return dir() === 'rtl' ? 'rtl' : 'ltr'
}

function nonceOf(): string {
  // The nonce is the page's whole script and style allow-list, so it comes from the platform's
  // cryptographic generator, not from Math.random, whose state a page could reconstruct. Hex
  // keeps every bit of the 128 (no modulo, no bias) and is valid nonce syntax: 32 characters
  // of [0-9a-f].
  return randomBytes(16).toString('hex')
}

/** HTML text: the four characters that could open markup or end an attribute. */
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
}

/**
 * A value written into the page's own <script>: JSON, with `<` escaped so no string inside it
 * can end the element early (`\u003c` is an ordinary JSON escape; the value read back is the
 * same). Every constant the shell writes in front of the module goes through this one door.
 */
function inline(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}

/**
 * The least time between two pushes of one section, for the sections that need one. A running
 * agent writes a line into its transcript every 0.6 s at the median, and every push rewrites
 * the whole tree; two seconds keeps it live without redrawing it under the reader's pointer
 * twice a second. A section not listed here is pushed the moment it changes, and a section held
 * back holds back nothing else.
 */
export const SECTION_MIN_INTERVAL_MS: Readonly<Partial<Record<string, number>>> = { agents: 2000 }

/** A section's own interval, or 0 for one that is pushed as soon as it changes. */
function minIntervalOf(key: string): number {
  const ms = Object.prototype.hasOwnProperty.call(SECTION_MIN_INTERVAL_MS, key)
    ? SECTION_MIN_INTERVAL_MS[key] : undefined
  return typeof ms === 'number' && ms > 0 ? ms : 0
}

/**
 * What the throttle reads the time from and waits with. The provider takes the system's; a test
 * hands in a clock it can move and a timer it can fire.
 */
export interface FlushClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const SYSTEM_CLOCK: FlushClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'tokenPace.dashboard'
  private view?: vscode.WebviewView
  private latest?: ViewModel
  private sent = new Map<string, string>()
  /** Serialised layout fields of the last push; a change forces a full re-render. */
  private layout?: string
  /** An unparsable message is logged once — a loop of them would be its own denial of service. */
  private warned = false
  /**
   * Size of the page the last resolved view was given; 0 until one resolves. Only the
   * extension API reads it (see `TokenPaceApi.dashboardHtmlLength`): revealing the view is
   * not the same as resolving it, and a provider that throws is swallowed by the workbench,
   * so the smoke test needs something the page itself sets.
   */
  private htmlLength = 0
  /** Pages the webview reported having rendered from a payload (see `renderedCount`). */
  private renders = 0
  /** 1.10 P5: the sections the last acknowledged whole render drew (see `renderedSections`). */
  private drawn: readonly string[] = []
  /** When each section with an interval of its own was last pushed, by `clock`. */
  private pushedAt = new Map<string, number>()
  /**
   * The view-state part of each such section as it was last pushed. A change there is the
   * reader's own fold or selection, and a click is answered at once whatever the interval
   * says: the interval bounds how often live data redraws a section, not how fast it answers.
   */
  private sentUi = new Map<string, string>()
  /**
   * 1.8 L-1: the view part (`CLAUDE_ONLY_VIEW`) of each Claude Code–only section as it was last
   * pushed — by a fragment or by the whole page. While the view leaves the section out and this
   * part is the one the page already has, the page has taken the section out, and a fragment of it
   * would be dropped unread.
   */
  private sentView = new Map<string, string>()
  /** The one timer a held-back section waits on, and when it fires; null while nothing waits. */
  private deferred: { handle: unknown; at: number } | null = null
  /**
   * 1.9 A3.4: the language (`lang()`) whose words the page's document holds — set by html() and by every
   * push that carries words. With `wordsLocale`, the tag its own numbers are formatted with (`LOCALE`):
   * a switch that keeps the words' language but moves the formats (`auto` under VS Code's `hu` → `en`)
   * has to reach the page too. Undefined while no document was written. 1.13 A2 rule 1: with `wordsDir`, the
   * direction the document is laid out in (its root's `dir`) — the words' language's, so it moves with `wordsLang`;
   * held apart all the same, so that no switch can leave a page in the other direction.
   */
  private wordsLang: string | undefined
  private wordsLocale: string | undefined
  private wordsDir: TextDirection | undefined

  constructor(
    private readonly onMessage: (m: WebviewMessage) => void,
    private readonly log: (m: string) => void = () => {},
    private readonly clock: FlushClock = SYSTEM_CLOCK,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    // A resolved view is a brand-new document: whatever it was sent before is gone.
    this.sent.clear()
    this.layout = undefined
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    const html = this.html()
    view.webview.html = html
    this.htmlLength = html.length
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const m = parseWebviewMessage(raw)
      if (m && m.type === 'rendered') { this.renders++; this.drawn = m.drawn; return }
      if (!m) {
        if (!this.warned) {
          this.warned = true
          this.log('dashboard: ignored a message that did not match the allow-list')
        }
        return
      }
      this.onMessage(m)
    })
    // postMessage to a hidden webview is dropped, and the view is rebuilt from scratch when
    // it comes back — so the next push after a visibility change has to be a full one.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.sent.clear()
        this.flush()
      }
    })
    view.onDidDispose(() => {
      this.view = undefined
      this.sent.clear()
      this.layout = undefined
      // A section held back for a view that is gone has nowhere to go.
      this.cancelDeferred()
    })
    this.flush()
  }

  /**
   * 1.9 A2 rule 4, A3.4: the host switched the language (`tokenPace.language`). The next flush is a
   * whole push, and it carries the page's words (`words`, beside the payload): the page's dictionary
   * and locale are constants of its script, and a switch must not reload the document — re-setting
   * `webview.html` would lose the scroll position, the open explanations and the keyboard focus. Only
   * `sent` is cleared: the host's `render(true)` that follows hands over the view model built in the
   * new language, and a hidden view gets the words with the flush that shows it again, because
   * `wordsLang` still differs then.
   */
  languageChanged(): void {
    this.sent.clear()
  }

  /** How long the page of the last resolved view is; 0 while no view has resolved. */
  renderedHtmlLength(): number {
    return this.htmlLength
  }

  /**
   * How many times the webview reported a page rendered from a payload. Unlike the html
   * length, this proves the message channel end to end: the payload reached the frame, passed
   * the page's origin rule and was drawn — the smoke test waits for it to move off 0.
   */
  renderedCount(): number {
    return this.renders
  }

  /**
   * 1.10 P5 (Review 1b F7): the sections the page drew in its last acknowledged whole render — each a `<section>`
   * with something in its body. Not the listed ones: a section the page has no renderer for is not drawn, so the
   * smoke test can tell a section the page draws from one it only lists.
   */
  renderedSections(): readonly string[] {
    return this.drawn
  }

  update(vm: ViewModel): void {
    this.latest = vm
    this.flush()
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true)
      return
    }
    void vscode.commands.executeCommand(`${DashboardProvider.viewType}.focus`)
  }

  /**
   * The extension is going. A section held back has nowhere to go any more, and without a view
   * no flush can arm the timer again: nothing of the provider outlives the extension.
   */
  dispose(): void {
    this.cancelDeferred()
    this.view = undefined
    this.latest = undefined
  }

  private flush(): void {
    const vm = this.latest
    const view = this.view
    if (!vm || !view || !view.visible) return
    const now = this.clock.now()
    // `sections` and `showCost` govern the layout of every section at once: which ones exist
    // and whether the cost columns are drawn. A per-section fragment cannot express that, so a
    // change to either forces the next push to be a full one.
    const layout = layoutKey(vm)
    if (this.layout !== undefined && this.layout !== layout) this.sent.clear()
    this.layout = layout
    if (this.sent.size === 0) {
      for (const [key, fields] of Object.entries(SECTION_FIELDS)) {
        this.sent.set(key, serialise(vm, fields))
        this.notePushed(key, vm, fields, now)
      }
      // The whole page is on its way: nothing is left for a held-back section to wait for.
      this.cancelDeferred()
      // 1.8 L-3: without the host's own fields — the page never reads them. 1.9 A3.4: and with the
      // page's words when its document holds another language's (a switch), never otherwise.
      const message: { type: 'data'; payload: PageViewModel; words?: PageWords } = { type: 'data', payload: pagePayload(vm) }
      const wordsDue = this.wordsLang !== lang() || this.wordsLocale !== locale() || this.wordsDir !== htmlDir()
      if (wordsDue) {
        message.words = pageWords()
        this.wordsLang = lang()
        this.wordsLocale = locale()
        this.wordsDir = htmlDir()
      }
      const delivered: unknown = view.webview.postMessage(message)
      // A post VS Code reports as not delivered leaves the document in its old words: the next whole
      // push carries them again.
      if (wordsDue && delivered && typeof (delivered as PromiseLike<boolean>).then === 'function') {
        const words = message.words as PageWords
        ;(delivered as PromiseLike<boolean>).then((ok) => {
          if (ok === false && this.wordsLang === words.lang && this.wordsLocale === words.locale) this.wordsLang = undefined
        }, () => { this.wordsLang = undefined })
      }
      return
    }
    // Only what the page shows. A section that is not on it has no body to write into, and a
    // fragment for it used to make the page rewrite itself whole — every scroll position lost
    // to a change nobody could see. Adding it to the list changes the layout, and that push is
    // a full one.
    const shown = shownSections(vm)
    let wait = Infinity
    for (const [key, fields] of Object.entries(SECTION_FIELDS)) {
      if (!shown.has(key)) continue
      const next = serialise(vm, fields)
      if (this.sent.get(key) === next) continue
      // 1.8 L-1: a section the page has already taken out is not pushed while the view leaves it
      // out — under Codex a running agent changed the tree every build, and the page dropped each
      // of those fragments (33.8–101 KB each, 1.7 Review 2) unread. Not pushed and not noted:
      // `sent` keeps what the page has, so the switch back pushes the section whole, with the
      // newest tree. The fragment that takes it out still goes — its view part differs from the
      // one last pushed.
      if (this.alreadyLeftOut(key, vm)) continue
      // Held back, not dropped: `sent` still holds what the page has, so the flush the timer
      // makes compares against it again and pushes whatever the latest view model says.
      const hold = this.holdFor(key, vm, fields, now)
      if (hold > 0) {
        wait = Math.min(wait, hold)
        continue
      }
      this.sent.set(key, next)
      this.notePushed(key, vm, fields, now)
      void view.webview.postMessage({ type: 'section', key, payload: payloadOf(vm, fields) })
    }
    if (wait !== Infinity) this.deferFor(wait, now)
  }

  /**
   * How much longer a changed section has to wait before it may be pushed; 0 when it may go
   * now. Only a section with an interval of its own ever waits, never for a change to the view
   * state it follows, and never because the clock went backwards.
   */
  private holdFor(key: string, vm: ViewModel, fields: SectionField[], now: number): number {
    const min = minIntervalOf(key)
    const last = this.pushedAt.get(key)
    if (min === 0 || last === undefined || now < last) return 0
    const left = last + min - now
    if (left <= 0) return 0
    return serialise(vm, uiFieldsOf(fields)) === this.sentUi.get(key) ? left : 0
  }

  /**
   * 1.8 L-1: whether the page has already taken this Claude Code–only section out — the view leaves
   * it out (the page's own `leftOut` rule: `claudeOnly` a non-empty string) and the last push of the
   * section carried this very view. A section the page shows, or one whose view has just changed, is
   * compared as every other section is.
   */
  private alreadyLeftOut(key: string, vm: ViewModel): boolean {
    if (!CLAUDE_ONLY_KEYS.includes(key)) return false
    const reason: unknown = vm.claudeOnly
    if (typeof reason !== 'string' || reason === '') return false
    return this.sentView.get(key) === serialise(vm, CLAUDE_ONLY_VIEW)
  }

  /**
   * Notes a push of a section: for one with an interval, when it went and the view state it carried;
   * for a Claude Code–only one (1.8 L-1), the view it carried.
   */
  private notePushed(key: string, vm: ViewModel, fields: SectionField[], now: number): void {
    if (CLAUDE_ONLY_KEYS.includes(key)) this.sentView.set(key, serialise(vm, CLAUDE_ONLY_VIEW))
    if (minIntervalOf(key) === 0) return
    this.pushedAt.set(key, now)
    this.sentUi.set(key, serialise(vm, uiFieldsOf(fields)))
  }

  /**
   * One timer for everything held back. It flushes again when the first held section is due,
   * and a flush that still finds one early arms it anew; a need that falls due earlier moves
   * it forward, a later one waits for it.
   */
  private deferFor(ms: number, now: number): void {
    const at = now + ms
    if (this.deferred !== null) {
      if (this.deferred.at <= at) return
      this.clock.clearTimeout(this.deferred.handle)
    }
    const handle = this.clock.setTimeout(() => {
      this.deferred = null
      this.flush()
    }, ms)
    this.deferred = { handle, at }
  }

  private cancelDeferred(): void {
    if (this.deferred === null) return
    this.clock.clearTimeout(this.deferred.handle)
    this.deferred = null
  }

  private html(): string {
    const nonce = nonceOf()
    // 1.9 A3.4: the document is written in the words of now — a push carries words only after a switch.
    this.wordsLang = lang()
    this.wordsLocale = locale()
    this.wordsDir = htmlDir()
    return `<!DOCTYPE html>
<html lang="${htmlLang().replace(/[^A-Za-z0-9-]/g, '')}" dir="${htmlDir()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div id="root"><p class="empty">${escHtml(t('Loading…'))}</p></div>
<script nonce="${nonce}">${scriptText()}</script>
</body>
</html>`
  }
}

/**
 * The fields no fragment carries: they decide which sections exist (`sections`) and whether
 * the cost columns are drawn (`showCost`), so the webview has to re-render as a whole when
 * one of them changes.
 */
export function layoutKey(vm: ViewModel): string {
  return serialise(vm, LAYOUT_FIELDS)
}

const LAYOUT_FIELDS: SectionField[] = ['sections', 'showCost']

/**
 * The pieces of the page that are always there, whatever `dashboard.sections` lists. 1.7 F1: the
 * provider switch first; a page without its block (a build before 1.7 P7) has no body for the
 * fragment, and `renderSection` leaves it at the model.
 */
const CHROME_SECTIONS = ['provider', 'notices', 'controls', 'footer', 'drill']

/** The keys a section push may carry: the listed sections and the chrome around them. */
export function shownSections(vm: ViewModel): Set<string> {
  const listed = Array.isArray(vm.sections) ? vm.sections.map(String) : []
  return new Set([...listed, ...CHROME_SECTIONS])
}

const UI_FIELD = 'ui.'

/** The one field of the UI state a `ui.<field>` dependency names. */
function uiField(f: SectionField): string {
  return f.slice(UI_FIELD.length)
}

/**
 * View-model fields that are the reader's own click as much as a `ui.<field>` is: the provider
 * switch (1.7 F1) is `ui.providers` in the form the sections are built from.
 */
const VIEW_STATE_FIELDS: readonly SectionField[] = ['provider']

/**
 * The view-state dependencies of a section — its `ui.<field>`s and the provider switch: what only
 * the reader's own clicks change, and what a held-back section answers at once.
 */
function uiFieldsOf(fields: SectionField[]): SectionField[] {
  return fields.filter((f) => f.startsWith(UI_FIELD) || VIEW_STATE_FIELDS.includes(f))
}

/**
 * What a section's fragment carries. A `ui.<field>` dependency ships the whole `ui` object:
 * the webview assigns a payload's fields onto its view model, so half a `ui` there would
 * throw the stored provider list and the model filter away.
 */
function payloadOf(vm: ViewModel, fields: SectionField[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.startsWith(UI_FIELD)) o.ui = vm.ui
    else o[f] = pageField(vm, f as keyof ViewModel)
  }
  return o
}

/**
 * What a section is compared by: a `ui.<field>` dependency compares that one field. The page's form of
 * a field (1.8 P10: the quota cards without the host's parts), so that a change the page would not see
 * pushes nothing.
 */
function serialise(vm: ViewModel, fields: SectionField[]): string {
  const o: Record<string, unknown> = {}
  for (const f of fields) {
    o[f] = f.startsWith(UI_FIELD)
      // A payload from a build that had no UI state is a view like any other here: the
      // provider states an absence, it does not throw the panel away over one field.
      ? (vm.ui as unknown as Record<string, unknown> | undefined)?.[uiField(f)]
      : pageField(vm, f as keyof ViewModel)
  }
  return JSON.stringify(o)
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --ok: var(--vscode-charts-green);
  --warn: var(--vscode-charts-yellow);
  --warn2: var(--vscode-charts-orange, var(--vscode-charts-yellow));
  --error: var(--vscode-charts-red);
  --claude: var(--vscode-charts-blue);
  --codex: var(--vscode-charts-purple);
  /* Mixed from the foreground, not taken from a theme colour: editorWidget.background is the
     sidebar background itself in the light themes, and a track that equals the page is no
     track at all. A share of the foreground contrasts by construction in either theme. */
  --track: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  /* The same reasoning for the hairlines: panel.border is #e5e5e5 on white. */
  --rule: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  --line: var(--vscode-panel-border, rgba(127,127,127,.3));
  --dim: var(--vscode-descriptionForeground);
  --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, transparent));
  /* 1.7 F4: an agent's state in the colour of its name — the semantic token, mixed with the foreground
     so that it reads as text (at least 4.5:1) on light and dark themes alike: the plain tokens do not on
     a light theme (charts.yellow on Light Modern is 2.93:1). The list's own warning and error text
     colours where the workbench has them; the chart tokens where it has not. */
  --ag-c-done: color-mix(in srgb, var(--ok) 60%, var(--vscode-foreground));
  --ag-c-unknown: color-mix(in srgb, var(--vscode-list-warningForeground, var(--warn)) 60%, var(--vscode-foreground));
  --ag-c-failed: color-mix(in srgb, var(--vscode-list-errorForeground, var(--error)) 60%, var(--vscode-foreground));
  --ag-c-running: color-mix(in srgb, var(--claude) 60%, var(--vscode-foreground));
}
body {
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); padding: 10px 12px 24px; margin: 0;
  /* A path or an id with no break opportunity ("~/.cache/codex-usage/state.json") must break
     rather than widen the page: the real host showed a sidebar scrolling sideways by the width
     of one such token in the data-quality list. Only tokens that would overflow are affected. */
  overflow-wrap: anywhere;
}
/* 1.9 P19: Korean writes a space between its words, and a line ends there — as Korean is set, and as VS Code's own
   Korean interface breaks. Chrome's default ends a line between any two Hangul syllables ("적습" | "니다"); keep-all
   keeps a Korean word whole, and a word too long for its box still breaks (overflow-wrap, above). Japanese and
   Chinese keep the default, a break between any two characters; an element in another language inside a Korean page
   (the picker’s native names) takes it back. A page in any other language draws as before: normal is the initial
   value, and nothing else on the page sets word-break. */
:lang(ko) { word-break: keep-all; }
[lang]:not(:lang(ko)) { word-break: normal; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim);
     margin: 20px 0 8px; font-weight: 600; }
h2:first-child { margin-top: 0; }
/* The page's rhythm lives on the sections, not on the headings inside them: a hairline and a
   fixed gap above every section, which is also the gap a folded one keeps — the sections used
   to run into each other, and a folded Summary glued itself to the filter bar. */
section { margin-top: 22px; padding-top: 10px; border-top: 1px solid var(--line); }
/* A section head is a <summary>: the fold is the browser's, which means it is keyboard
   reachable and announced as expandable without a word of ARIA from us. It is a flex row of
   its own so the chevron, the heading and the gear at its right end sit on one centre line
   and the row keeps a hand-sized height whatever the heading says. */
summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px;
          min-height: 24px; }
summary::-webkit-details-marker { display: none; }
summary h2 { display: flex; align-items: center; gap: 6px; margin: 0; flex: 1 1 auto; }
/* Only while the body is there: a folded section's own margin is the whole gap. */
details[open] summary { margin-bottom: 8px; }
/* The twisty is drawn, not typed: a glyph in the markup would end up in the copied text. 1.13 A2 rule 2: a closed one
   points to the inline end — ▸ left to right, ◂ right to left (--tp-closed, the one [dir="rtl"] rule below the tree's
   rows turns it for the three closed disclosures of the page), as Chromium's own disclosure-closed marker turns. */
:root { --tp-closed: "▸"; }
summary h2::before { content: "▾"; font-size: 9px; line-height: 1; opacity: .7; }
details:not([open]) summary h2::before { content: var(--tp-closed); }
summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
/* The gear at the end of a section header: quiet until it is wanted, and never a reason for
   the header to grow. 24 x 24 of target around the 16 px icon, because the whole summary row
   is the fold and a click three pixels off the gear would close the section instead of
   opening its settings; the negative margin keeps the header at its own height. */
.gear { background: none; border: none; padding: 4px; margin: -4px -2px; line-height: 0;
        color: inherit; opacity: .6; flex: none; }
.gear:hover, .gear:focus-visible { opacity: 1; background: none; }
.gear svg { display: block; }
p { margin: 6px 0; }
.empty { color: var(--dim); font-style: italic; }
.dim { color: var(--dim); }
.meta { color: var(--dim); font-size: 11px; }
.meta.warn { color: var(--warn); }
/* 1.8 A5, A6: the quota cards' prompt-cache lines — a session's state line (pc-line) with its cost line
   right under it (pc-cost), the count of the rest (pc-more), the Codex card's line (pc-codex). The dim tone
   of .meta and no colour of their own: the phase is said in words. A little air above each state line, so
   that two sessions read as two, and above the lines that close a card. 1.8 B2: a keep-warm note (pc-note)
   sits right under the entry it concerns, as its cost line does; today's keep-warm accounting (pc-today)
   closes the block with the same air as the count. */
.pc-line, .pc-more, .pc-codex, .pc-today { margin-top: 4px; }
.card { margin-bottom: 14px; }
/* The two provider cards ran into one another; a hairline says where one ends. Scoped to the
   quota body, because a "card" elsewhere on the page is a row of a list that needs no rule. */
[data-body="quota"] .card + .card { border-top: 1px solid var(--line); padding-top: 10px; }
.name { font-weight: 600; }
/* A provider's name never breaks inside the word: at 300 px with a long German meta text the
   row used to split a five-letter name across two lines; the meta beside it is what wraps.
   Only in the quota cards: the same row elsewhere (the Records card's peak day) carries a
   name long enough to push the card past a 260 px sidebar when it may not wrap. */
[data-body="quota"] .row > .name { white-space: nowrap; }
.row { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
.wrap { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
/* 1.14 B4 (R-P7b-113-chips): a chip beside a row's text keeps its words whole. The row is flex, and the body's
   overflow-wrap: anywhere gave each chip a min-content of one character, so at 260–320 px the row shrank the chips
   below their words ("usa|ge", "Verbrauch", "الاستخ|دام"). A chip is one line of its own: at least as wide as its label,
   the chips stack in their .wrap, and the text beside them — the stats line, first — wraps. nowrap rather than
   overflow-wrap: normal, which still let a Japanese or Chinese chip break between its characters ("使用|量", "コス|ト"). */
.row > .wrap > button { white-space: nowrap; }
button, select, input {
  font-family: inherit; font-size: 11px; color: var(--vscode-foreground);
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--line); border-radius: 3px; padding: 2px 7px; cursor: pointer;
}
button:hover, select:hover { background: var(--vscode-toolbar-hoverBackground, var(--track)); }
button:focus-visible, select:focus-visible, input:focus-visible, [tabindex]:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
}
/* The popup of a <select> is drawn by the browser, not by this page, and it took its colours
   from the system rather than from the theme: light option text on a light system menu, which
   is a dropdown nobody could read. The options are given the theme's own dropdown colours, and
   the colour scheme is declared as well — that is the one thing the browser reads when it
   paints the popup's chrome. VS Code stamps the theme kind on the body; the high-contrast
   light class comes second on purpose, because the host sets it next to vscode-high-contrast
   and the later rule is the one that wins. */
body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, var(--line));
}
select option {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
}
button[aria-pressed="true"] {
  background: var(--vscode-button-background, var(--track));
  color: var(--vscode-button-foreground, inherit);
  border-color: var(--vscode-button-background, var(--line));
}
input[type=date] { cursor: text; }
/* The filter bar is a labelled grid: one column for the row labels, one for the chips, so the
   chips of all three rows start at the same x and the bar reads as three lines rather than as
   a paragraph of buttons. A tinted block with a hairline around it, because it governs the
   sections below it instead of belonging to any one of them. */
.bar { display: grid; grid-template-columns: minmax(62px, max-content) 1fr auto;
       gap: 6px 8px; align-items: center; margin: 10px 0; padding: 8px;
       background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
       border: 1px solid var(--line); border-radius: 4px; }
/* A row with nothing in the third column takes the width the refresh button leaves. */
.bar .span2 { grid-column: 2 / 4; }
/* The date fields are a line of their own, directly under the range they belong to. */
.bar .full { grid-column: 1 / 4; }
/* 1.7 F1: the provider switch, the page's first block — the page's own chips (the pressed one in
   the pressed-chip colours, and in a forced-colours theme in the highlight colours, by the rules
   every chip follows), on one line: the registry's titles and All fit the narrowest sidebar,
   260 px, with room to spare. Each button at least 24 px square (WCAG 2.5.8). */
.pv { display: flex; flex-wrap: nowrap; gap: 4px; align-items: center; }
.pv button { min-height: 24px; min-width: 24px; white-space: nowrap; }
/* 1.9 A3: the page's top row — the provider switch, and the language picker at the row's end. The row wraps
   when it has to (a long "All" at 260 px may push the picker onto a line of its own, still at the end); the
   switch's buttons never wrap inside their group. */
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.lng { position: relative; margin-inline-start: auto; }
/* The button: the shown language's flag and a caret that says a list opens here — at least 24 × 24 px
   (WCAG 2.5.8), a stop of the Tab key with the page's focus ring. */
.lng-btn { display: flex; align-items: center; gap: 4px; min-width: 24px; min-height: 24px; padding: 2px 5px;
           box-sizing: border-box; }
.lng-caret { font-size: 9px; line-height: 1; opacity: .7; }
/* A flag is a picture in one 3:2 box, decoration beside a name (aria-hidden): a hairline keeps the edge of a
   white field on a white menu. The globe of Automatic is drawn in the text colour and needs none. */
.flag { display: block; flex: none; width: 21px; height: 14px;
        outline: 1px solid color-mix(in srgb, var(--vscode-foreground) 22%, transparent); }
.flag.flag-auto { outline: none; }
/* The open list, under the button and aligned to its end: the menu's own colours, the page's tokens where a
   theme has none; never wider than the view (no sideways page scroll at 260 px), at most min(70vh, 440px)
   tall — the list scrolls inside, the two lines under it stay. */
.lng-pop { position: absolute; top: 100%; inset-inline-end: 0; z-index: 20; margin-top: 4px; box-sizing: border-box;
           width: min(320px, calc(100vw - 16px)); max-height: min(70vh, 440px);
           display: flex; flex-direction: column; padding: 4px 0 6px; border-radius: 4px;
           background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
           color: var(--vscode-menu-foreground, var(--vscode-foreground));
           border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, var(--line)));
           box-shadow: 0 2px 8px rgba(0, 0, 0, .3); }
.lng-pop ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
/* An item: at least 24 px tall, its words wrapping between words; the focused one in the menu's selection
   colours. The ✓ of the checked one is text, not colour. */
.lng-pop li { display: flex; align-items: center; gap: 8px; min-height: 24px; padding: 3px 10px;
              box-sizing: border-box; cursor: pointer; }
.lng-pop li:hover { background: var(--vscode-toolbar-hoverBackground, var(--track)); }
.lng-pop li:focus { outline: none;
                    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, var(--track)));
                    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, inherit)); }
.lng-pop li:focus .meta { color: inherit; }
.lng-pop li:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.lng-text { flex: 1 1 auto; min-width: 0; }
/* The comma between a language's own name and the reader's name is for a screen reader alone: text of the line
   at no size, read where it stands ("Deutsch, German") — the technique of the ⚠'s words (1.7 D-A); a box placed
   apart (.sr) is read by Chrome as a block of its own, "Deutsch , German". The space after it is the eye's — one
   inside it would collapse with it and take the gap to no size too. */
.lng-sep { font-size: 0; }
.lng-check { flex: none; }
.lng-note { margin: 6px 10px 0; flex: none; }
/* The caption ends the range row; a little air keeps it apart from the last chip. */
.bar .cap { margin-inline-start: 2px; }
.icon { display: inline-flex; align-items: center; justify-content: center; line-height: 0;
        padding: 3px 5px; justify-self: end; }
.icon svg { display: block; }
.track { position: relative; height: 8px; border-radius: 4px; background: var(--track); }
.fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
.fill.ok { background: var(--ok); }
.fill.warn { background: var(--warn); }
.fill.warn2 { background: var(--warn2); }
.fill.error { background: var(--error); }
.fill.extra { background: var(--claude); }
.fill.neutral { background: var(--dim); }
/* The pace gap, drawn into the bar itself. The elapsed marker stays where it is; what changes
   is the paint on either side of it. Fill beyond the marker is consumption ahead of the clock
   and wears the level's colour darkened, so the excess reads as a band even where the marker
   is hard to make out; track between the end of the fill and the marker is time the window
   still has in hand and is a stronger grey than the rest of the track — more foreground mixed
   in, which reads lighter on a dark theme and darker on a light one. */
/* 1.13 A2 rule 7 (§7a Q3): the bar is mirrored in a right-to-left page — the parts drawn from the inline start (the
   script sets their inset-inline-start from data-x, applyStyles), the rounded end at the inline end. */
.fill.over { position: absolute; top: 0; inset-inline-start: 0; border-radius: 0; border-start-end-radius: 4px;
             border-end-end-radius: 4px; }
.fill.over.ok { background: color-mix(in srgb, var(--ok) 65%, black); }
.fill.over.warn { background: color-mix(in srgb, var(--warn) 65%, black); }
.fill.over.warn2 { background: color-mix(in srgb, var(--warn2) 65%, black); }
.fill.over.error { background: color-mix(in srgb, var(--error) 65%, black); }
.slack { position: absolute; top: 0; inset-inline-start: 0; height: 100%; border-radius: 0; border-start-end-radius: 4px;
         border-end-end-radius: 4px;
         background: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
.mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-inline-start: -1px;
        background: var(--vscode-foreground); opacity: .6; border-radius: 1px; }
.mark.fc { background: var(--warn); opacity: .9; border-radius: 0; width: 2px;
           border-top: 2px solid var(--vscode-foreground); }
/* A window label is one word to the reader: "7 d" must not be broken between the number and
   the unit, and neither must the provider in front of it. The only break left in a heading
   like "Claude Code · 7 d" is the separator itself. */
.nobr { white-space: nowrap; }
/* 1.13 A3 rule 3 (the page's half, §7a Q5): a figure, a day, a clock, a money figure or an identifier inside a right-to-left
   line is a unit of its own (a span.fig laid out left to right by its own dir attribute, which isolates it —
   isolateFigures) and keeps to one line as a word does, the whole unit moving to the next line; a unit longer than
   FIGURE_WHOLE_MAX (.long — an agent's id, a long path) breaks where the text around it may, so it never widens the page.
   Only a right-to-left page has one. */
.fig:not(.long) { white-space: nowrap; }
/* Positioned for the same reason the KPI card is: the window block is the containing block of
   its own explanation, so the popover hangs under the bar it explains. */
.win { margin-top: 8px; position: relative; }
/* Label and reset on the left, the verdict beside them, the figure on the right — one row
   above the bar, so the card spends no line of its own on the verdict. A narrow sidebar wraps
   the row onto a second line; nothing in it is ever cut. */
.win-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
           gap: 0 8px; font-size: 11px; color: var(--dim); margin-bottom: 3px; }
/* The label wraps rather than clips: "GPT-5.3-Codex-Spark 5 h · resets 4h59m" cut to "…4h5" in a
   narrow sidebar loses the countdown, which is the one thing the header is for. */
.win-top span { min-width: 0; }
.win-top b { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; flex: none;
             margin-inline-start: auto; }
.verdict { color: var(--dim); overflow-wrap: anywhere; }
/* 1.10 B5 rule 1 (row 13): a window's figure never stands alone on a line, in any language. The label takes the
   room the row has and wraps inside itself; the verdict and the figure are one box that wraps as a whole — on a
   narrow sidebar both go to the next line, at its right end, the figure on the verdict's last line. A row without a
   verdict (.solo) does not wrap at all: the label wraps inside itself and the figure keeps to its last line. */
.win-top > span:first-child { flex: 1 1 auto; }
/* Never shrunk by the row (flex: none) — its width is its content's, at most the row's (max-width), so a verdict longer
   than the row wraps inside the box and the figure stays whole beside its last line. */
.vf { display: inline-flex; flex: none; flex-wrap: nowrap; align-items: last baseline; gap: 0 8px; margin-inline-start: auto;
      min-width: 0; max-width: 100%; }
.vf .verdict { min-width: 0; }
.vf b { flex: none; }
.win-top.solo { flex-wrap: nowrap; align-items: last baseline; }
.verdict.warn, .verdict.warn2 { color: var(--warn); }
.verdict.error { color: var(--error); }
.scroll { overflow-x: auto; }
/* Only ever shown when the browser has measured a table wider than its box — a hint about
   columns that are all visible would be a lie. */
.scrollhint { margin: 2px 0 6px; }
table { border-collapse: collapse; width: 100%; font-size: 11px; font-variant-numeric: tabular-nums; }
/* 1.13 A2 rule 3 (§7a Q4): the columns follow the direction — the text column at the inline start, the figures at the
   inline end (at the left edge in a right-to-left table, as right-to-left spreadsheets put them). */
th { text-align: end; font-weight: 500; color: var(--dim); padding: 3px 0; padding-inline-start: 8px;
     white-space: nowrap; border-bottom: 1px solid var(--line); }
th.sortable { cursor: pointer; }
th[aria-sort="ascending"]::after { content: " ▲"; }
th[aria-sort="descending"]::after { content: " ▼"; }
th:first-child, td:first-child { text-align: start; padding-inline-start: 0; }
td { text-align: end; padding: 3px 0; padding-inline-start: 8px; white-space: nowrap; }
tr.more td { color: var(--dim); font-style: italic; text-align: start; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px;
        margin-bottom: 8px; }
/* The card is the popover's containing block, so the explanation hangs under the very figure
   it explains. No z-index here on purpose: a stacking context on the card would trap the
   popover behind the cards that follow it in the grid. */
.kpi { border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; position: relative; }
.kpi .v { font-size: 15px; font-variant-numeric: tabular-nums; }
.kpi .l { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
/* Deltas are coloured from the figure's polarity, never from the arrow: more usage and more
   money are warnings, a higher cache hit rate is good, and a count of days is neither. A red
   arrow that means "you worked on more days" is a judgement nobody asked for. */
.kpi .d.good { color: var(--ok); }
.kpi .d.bad { color: var(--warn); }
.kpi .d.neutral { color: var(--dim); }
/* What the figure counts, on hover and on focus. A native title would give one line after a
   delay, could not be reached by keyboard and would be unreadable in a screen reader; this is
   a real element, so the card can point at it with aria-describedby.
   The width is capped against the viewport as well as at 320 px: absolutely positioned
   overflow still widens the page, and a 320 px card in a 260 px sidebar is a sideways
   scrollbar over the whole dashboard. */
.pop { position: absolute; top: 100%; left: 0; z-index: 5; margin-top: 4px;
       min-width: 220px; max-width: min(320px, 90vw); padding: 6px 8px; font-size: 11px;
       line-height: 1.5; text-transform: none; letter-spacing: normal; white-space: normal;
       border-radius: 4px;
       background: var(--vscode-editorHoverWidget-background,
                   var(--vscode-editorWidget-background, var(--vscode-editor-background)));
       color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
       border: 1px solid var(--vscode-editorHoverWidget-border,
               var(--vscode-editorWidget-border, var(--line)));
       box-shadow: 0 2px 8px rgba(0, 0, 0, .3); }
/* Measured at open time: a card in the right half would push its explanation off the page. */
.pop.right { left: auto; right: 0; }
.pop b { color: var(--dim); font-weight: 600; }
.pop div + div { margin-top: 2px; }
.spark { width: 100%; height: 18px; display: block; }
/* The quota sparkline is seven days in 15-minute slots and a little taller than the KPI ones,
   so the pace colours along it can be told apart. */
.spark.q { height: 22px; }
.spark polyline { fill: none; stroke: var(--claude); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
/* Each segment wears the pace level the bar showed at its later point; a point with no clock
   keeps the provider colour, and so does the vertical drop into a reading the window turned
   over before — that drop is the window turning over, and colouring it would judge a pace
   nobody kept. A stretch without readings is drawn straight across, from the last reading
   before it to the first one after. */
.spark polyline.ok, .spark path.pt.ok { stroke: var(--ok); }
.spark polyline.warn, .spark path.pt.warn { stroke: var(--warn); }
.spark polyline.warn2, .spark path.pt.warn2 { stroke: var(--warn2); }
.spark polyline.error, .spark path.pt.error { stroke: var(--error); }
/* A single reading is drawn as a hair-length stroke with a round cap: the
   viewBox is stretched to the card width, and any shape with a geometric size would be
   stretched with it — a 5 px dash that reads as a line where there is a single point. */
.spark path.pt { fill: none; stroke: var(--claude); stroke-width: 3; stroke-linecap: round;
                 vector-effect: non-scaling-stroke; }
/* The reading under the pointer, or the one stepped to with the arrow keys: the same
   round-capped hairline as a lone reading, only heavier and in the hover widget's text colour
   — a circle element would be stretched with the viewBox into an ellipse. */
.spark path.hov { fill: none; stroke: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
                  stroke-width: 5; stroke-linecap: round; vector-effect: non-scaling-stroke;
                  pointer-events: none; }
/* The hit area. A polyline with no fill is a hairline to the pointer; the transparent
   rectangle over the whole box takes the pointer for it, so any x along the line finds the
   nearest reading. */
.spark rect.ov { fill: transparent; pointer-events: all; }
/* The quota sparkline's hover label hangs under the reading it names, in the box the KPI
   explanation uses. Sized to its one line, and its anchor slides from the left edge to the
   right one with the reading — a box hung from the reading's x alone would leave the card
   on the right half of the axis. */
/* 1.10 B5 rule 5 (forLead 5 g): the sparkline's top edge stands clear of the line above it — a stretch at the window's
   top is drawn at the svg's edge, and with no gap it touched the descenders of the share line in Polish, Czech and
   Russian. */
.sparkbox { position: relative; margin-top: 3px; }
.sparkbox .pop { min-width: 0; white-space: nowrap; }
/* The plot keeps a gutter on its right for the tick labels. Inside the plot they either hide
   behind the newest bars or, opaque, cut them into pieces that read as gaps in the data —
   and the newest days are the ones worth reading. Because those labels sit outside the box,
   the plot must not hide its overflow: an overflow rule here would cut every one of them off.
   240 px rather than the 120 px this started at — split six ways, a 120 px column turns every
   model but the largest into a hairline.
   1.13 A2 rule 1 (§7a Q1): the charts are boxes kept left to right — a dir of ltr in their markup (the plot, its day axis,
   the sparkline, the year strip, the hour strip, its hours and the weekday grid) —, so the physical sides of their own
   rules below are the box's, the same in either direction; their words carry the page's direction (pageDir). */
.plot { position: relative; height: 240px; margin-top: 6px; margin-right: 38px;
        border-bottom: 1px solid var(--rule); }
.grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--rule); z-index: 2;
        pointer-events: none; }
.grid span { position: absolute; left: 100%; top: 1px; margin-left: 4px; font-size: 9px;
             color: var(--dim); white-space: nowrap; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 100%; position: relative; }
.col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column;
       justify-content: flex-end; cursor: pointer; }
/* Positioned, so a label that spills into the neighbouring column is painted above that
   column's bar instead of behind it. Centred by a flex container rather than by text-align:
   a label wider than its column overflows to both sides that way, where text-align lets it
   start at the left edge and paint itself over the next column instead. */
.col .vlabel { font-size: 8px; color: var(--dim); white-space: nowrap;
               display: flex; justify-content: center;
               position: relative; text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg); }
/* An explicit display beats the browser's [hidden] rule, which is how fitChart thins. */
.col .vlabel[hidden] { display: none; }
.col .vlabel i { font-style: normal; }
.seg:first-of-type { border-radius: 2px 2px 0 0; }
/* A band is its provider's hue — Claude blue, Codex purple, the two colours the rest of the
   page uses — varied by the model's rank within that provider, so a column says "how much of
   each provider" at a glance and "which model" on a second look. A colour per model name would
   need a palette as long as the model list and would repeat itself the moment it ran out.
   The pattern style keeps the hue at 35 % as the ground and draws the rank as strokes in the
   full hue; the shade style steps the lightness instead; both draws the strokes over the
   shaded ground. The stroke pitch is 4 px in CSS pixels (2 on, 2 off) whatever the band's
   size, so a hairline band and a wide one hatch alike. The script's bandStyle() hands these
   classes out; nothing else picks a chart colour, and a legend swatch wears exactly the
   classes of its band. */
.hue-claude { --hue: var(--claude); }
.hue-codex { --hue: var(--codex); }
.r0 { --mix: 100%; }
.r1 { --mix: 78%; }
.r2 { --mix: 58%; }
.r3 { --mix: 42%; }
.r4 { --mix: 30%; }
.rother { --mix: 22%; }
/* Shade has no strokes to fall back on — the fill is the whole message — so it takes a ramp
   of its own instead of the ground the patterned styles hatch over, which is why these six
   rules override the ones above for that style alone.
   Measured in a browser on the band-size demo — bands of exactly 4, 8 and 16 px, both themes,
   both hues, 120 neighbouring pairs. The shared ramp leaves its closest pair ΔE 5.0 apart in
   the fill, and the 1 px hue outline that used to prop that end up costs a 4 px band half of
   its height: over the whole band the closest pair falls to ΔE 0.8, and the ladder turns
   round eight times — rank 3 paints LIGHTER than rank 2 at 4 px — so the outline, not the
   shade, is the only thing left to read.
   These six mixes leave no pair closer than ΔE 9.8 in either theme or for either hue, no pair
   out of order, and the faintest band ΔE 20 clear of the page. That is what lets the outline
   go, and a fill that carries itself paints a 4 px band as it paints a 16 px one. The
   steps narrow towards the faint end because a point of mix buys less lightness beside the
   full hue than beside the track. r0 only names the anchor: the plain-hue rule below paints
   it. Changing a number here changes the shade style and nothing else. */
.st-shade.r0 { --mix: 100%; }
.st-shade.r1 { --mix: 82%; }
.st-shade.r2 { --mix: 65%; }
.st-shade.r3 { --mix: 49%; }
.st-shade.r4 { --mix: 33%; }
.st-shade.rother { --mix: 18%; }
.st-pattern { --ground: color-mix(in srgb, var(--hue) 35%, transparent); }
.st-shade, .st-both { --ground: color-mix(in srgb, var(--hue) var(--mix), var(--track)); }
.band { background: var(--ground); }
/* The largest model is the plain hue in every style: it is what the provider colour means. */
.band.r0 { background: var(--hue); }
.st-pattern.r1, .st-both.r1 { background: repeating-linear-gradient(45deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.r2, .st-both.r2 { background: repeating-linear-gradient(135deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.r3, .st-both.r3 { background: repeating-linear-gradient(45deg, var(--hue) 0 2px, transparent 2px 4px),
                                          repeating-linear-gradient(135deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.r4, .st-both.r4 { background: repeating-linear-gradient(0deg, var(--hue) 0 2px, var(--ground) 2px 4px); }
.st-pattern.rother, .st-both.rother { background: radial-gradient(var(--hue) 1px, var(--ground) 1.2px);
                                      background-size: 4px 4px; }
/* Explicit width and height, because this is a replaced element: with inset alone the
   browser took the width from the box and the height from the viewBox's 1:1 ratio, which drew
   a 590 px tall cost line straight over the model table and the heatmap below it. The
   overflow is visible because the series is mapped onto the whole box — the maximum sits at
   y = 0 and a zero at y = 100 — where the browser's own rule for an inline SVG would cut the
   marker dot at the peak in half and square the apex of the line off. The plot does not clip
   either: its tick labels live in the gutter beside it. */
.costline { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
            overflow: visible; }
/* The overlay is one line over a stack of coloured bands, so it wears none of their hues: the
   foreground is the one colour no band uses. It is drawn twice — a halo in the page's own
   background under a 2 px line — so it stays readable over a band of any hue or pattern, and
   both strokes are non-scaling, so their widths hold under the stretched viewBox. The dots sit
   in a second, unstretched SVG and take the line's colour. The legend's key for the line is
   the same three marks at swatch size, so it shares the rules. */
.key polyline, .costline polyline { fill: none; stroke: var(--vscode-charts-foreground, var(--vscode-foreground));
                     stroke-width: 2; vector-effect: non-scaling-stroke; }
.key polyline.halo, .costline polyline.halo { stroke: var(--vscode-sideBar-background, var(--vscode-editor-background));
                                             stroke-width: 4; }
.key circle, .costline circle { fill: var(--vscode-charts-foreground, var(--vscode-foreground)); }
.legend svg.key { width: 22px; height: 10px; overflow: visible; vertical-align: -1px; margin-inline-end: 4px; }
.axis { display: flex; gap: 2px; font-size: 9px; color: var(--dim); margin-top: 3px; }
/* The chart's own axis shares the plot's gutter, so every day label stays under its column;
   the hour strip below has no gutter and keeps the plain rule. */
.plot + .axis { margin-right: 38px; }
/* Every slot keeps its width so the labels stay under their columns; the ones that are
   shown may spill into the empty slots beside them rather than wrap to a second line. The
   spill is centred on the slot — a label aligned to the slot's start ends up under its
   neighbour once it outgrows the slot, which is the column it does not describe. */
.axis span { flex: 1; min-width: 0; overflow: visible; white-space: nowrap;
             display: flex; justify-content: center; }
.axis span i { font-style: normal; white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--dim); margin-top: 6px; }
/* A group heading — the provider a run of swatches belongs to — takes a line of its own.
   Wrapped into the middle of a line it read as one more entry instead of as the label of
   the entries after it. Only the chart's legend has such a child. */
.legend > span.meta { flex-basis: 100%; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-inline-end: 4px; }
/* A chart swatch is bigger than the others: at 8 px a 4 px stripe pitch is two strokes, and
   two strokes are not a pattern anyone can match against a band. */
.legend .dot.band { width: 14px; height: 14px; }
.dot.time { background: var(--vscode-foreground); opacity: .6; width: 2px; border-radius: 1px; }
.dot.fc { background: var(--warn); width: 2px; border-radius: 0; }
.heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 9px);
        gap: 2px; overflow-x: auto; padding-bottom: 2px; }
.heat i { width: 9px; height: 9px; border-radius: 2px; background: var(--track); display: block; }
.heat i.l1 { background: color-mix(in srgb, var(--claude) 30%, var(--track)); }
.heat i.l2 { background: color-mix(in srgb, var(--claude) 55%, var(--track)); }
.heat i.l3 { background: color-mix(in srgb, var(--claude) 78%, var(--track)); }
.heat i.l4 { background: var(--claude); }
.heat i.out { background: transparent; border: 1px dotted var(--line); }
.dot.l1 { background: color-mix(in srgb, var(--claude) 30%, var(--track)); }
.dot.l2 { background: color-mix(in srgb, var(--claude) 55%, var(--track)); }
.dot.l3 { background: color-mix(in srgb, var(--claude) 78%, var(--track)); }
.dot.l4 { background: var(--claude); }
.compbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--track); }
.compbar i { display: block; height: 100%; }
.cs.c1, .dot.c1 { background: var(--claude); }
.cs.c2, .dot.c2 { background: color-mix(in srgb, var(--claude) 60%, var(--track)); }
.cs.c3, .dot.c3 { background: color-mix(in srgb, var(--claude) 35%, var(--track)); }
/* Neutral by construction, because every hue on this page is already spoken for: blue is
   Claude, purple is Codex, and green/orange are the pace verdicts one card above. The
   remaining parts are told apart by weight and by texture instead of by borrowing one. */
.cs.c4, .dot.c4 { background: color-mix(in srgb, var(--vscode-foreground) 65%, transparent); }
.cs.c5, .dot.c5 { background: color-mix(in srgb, var(--vscode-foreground) 38%, transparent); }
.cs.c6, .dot.c6 { background: repeating-linear-gradient(45deg,
                  color-mix(in srgb, var(--vscode-foreground) 65%, transparent),
                  color-mix(in srgb, var(--vscode-foreground) 65%, transparent) 2px,
                  transparent 2px, transparent 4px); }
/* An explicit baseline, so an hour with no usage can be a gap rather than a 1 px rule that
   reads as one. */
.hours { display: flex; align-items: flex-end; gap: 2px; height: 60px;
         border-bottom: 1px solid var(--rule); }
.hours .hb { flex: 1; background: var(--claude); min-height: 3px; border-radius: 2px 2px 0 0; }
/* The marker for an hour with nothing in it has to be the shortest thing in the strip, or
   the emptiest hours read as the busiest ones: it is 1 px against a used hour's floor of
   3 px. Mixed from the foreground rather than taken from --track, because at one pixel a
   14 % tint on top of the baseline is not there at all in either theme. */
.hours .hb.none { background: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
                  min-height: 1px; border-radius: 0; }
.hgrid { display: grid; grid-template-columns: 28px repeat(6, 1fr); gap: 2px; font-size: 10px; }
.hgrid i { height: 14px; border-radius: 2px; background: var(--track); display: block; }
.hgrid i.l1 { background: color-mix(in srgb, var(--claude) 30%, var(--track)); }
.hgrid i.l2 { background: color-mix(in srgb, var(--claude) 55%, var(--track)); }
.hgrid i.l3 { background: color-mix(in srgb, var(--claude) 78%, var(--track)); }
.hgrid i.l4 { background: var(--claude); }
.hgrid i.none { background: repeating-linear-gradient(45deg, var(--track), var(--track) 2px,
                transparent 2px, transparent 4px); }
.box { border-inline-start: 2px solid var(--warn); background: var(--vscode-inputValidation-warningBackground,
       rgba(255,200,0,.10)); padding: 6px 8px; font-size: 11px; margin: 8px 0;
       border-radius: 0; border-start-end-radius: 3px; border-end-end-radius: 3px; }
.box.info { border-color: var(--claude);
            background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.12)); }
.box button { margin-top: 6px; }
.foot { margin-top: 18px; font-size: 10px; color: var(--dim); line-height: 1.6; }
.foot li { margin-bottom: 2px; }
ul { margin: 6px 0; padding-inline-start: 18px; }
/* The agent tree: one list per level, each indented 16 px, so a node's children start under its
   glyph and the glyphs of one level stand in a column. A row is two targets of the mouse — the
   fold, and the row itself, which opens the node's details — without a chip's border: a tree of
   bordered buttons reads as a wall of controls rather than as a tree. 1.6 N9: both are targets of
   at least 24 × 24 px (WCAG 2.5.8) — the fold 24 px wide and high, the row at least 24 px high.
   1.6 L1: neither is a control of its own — the item they stand in is what takes the focus (the
   tree's keyboard, see the script) — so they take a button's box, colour and pointer here, and
   the running list's rows, which stay buttons, keep theirs. */
.agtree ul { list-style: none; margin: 0; padding: 0; }
/* 1.7 F6: guide lines — a vertical line down each open group under its parent's toggle, a stub into every
   child, the last child's line ending at its stub (└); an open child's own group draws its lines one step
   further in, so the verticals of several levels stand side by side. Drawn behind the rows, never over a
   word: the vertical stands in the column of the parent's twisty, left of the child's own toggle, and the
   stub ends 2 px before the first thing the child's line draws. Decorative, so a pseudo-element with no
   content — nothing to read, nothing to copy; the tree's structure is its indentation and its items'
   level, place and size (1.6 L1). The colour is the workbench's own for the same purpose, the explorer's
   indent guides (§7a Q14: at its contrast, 2.50:1 on Dark Modern, 2.21:1 on Light Modern), the page's
   hairline where a build has none. Only the items of a group have lines — the roots (the sessions, the
   group of earlier sessions) none, and the running list and the 7-day block, flat lists, none. No line
   changes a row's height or width: the pseudo-elements are absolute. --ag-guide-y is the vertical centre
   of a row's first line — the glyph's and the twisty's (measured by the harness, ± 1 px). The item is a
   block formatting context of its own (flow-root): the bottom margin of a details panel that ends it
   stays inside it rather than falling between it and its next sibling, so its vertical runs on under the
   panel to that sibling without a gap. --ag-ind stays the panel's level; these names do not reuse it. */
.agtree { --ag-step: 16px; --ag-fold-w: 24px; --ag-guide-y: 9px;
          --ag-guide: var(--vscode-tree-indentGuidesStroke, var(--rule)); }
.agtree ul ul { padding-inline-start: var(--ag-step); }
.agtree ul[role="group"] > li { position: relative; display: flow-root; }
.agtree ul[role="group"] > li::before,
.agtree ul[role="group"] > li::after { content: ""; position: absolute; pointer-events: none;
                                       inset-inline-start: calc(var(--ag-fold-w) / 2 - var(--ag-step)); }
.agtree ul[role="group"] > li::before { top: 0; bottom: 0; border-inline-start: 1px solid var(--ag-guide); }
.agtree ul[role="group"] > li:last-child::before { bottom: auto; height: var(--ag-guide-y); }
/* The stub ends 2 px before the first thing the child's line draws: its toggle's arrow, or — a leaf, the
   "more" line — its row's box, which holds the glyph and the open row's 2 px edge. The arrow, a 9 px
   glyph centred in the 24 px fold, begins about 9.7 px in (measured): a stub to 7 px leaves it 2.7 px,
   and room for the wider arrow of another font. */
.agtree ul[role="group"] > li::after { top: var(--ag-guide-y); border-top: 1px solid var(--ag-guide);
                                       width: calc(var(--ag-step) - var(--ag-fold-w) / 2 + var(--ag-fold-w) - 2px); }
.agtree ul[role="group"] > li:has(> .ag-line > .ag-fold)::after { width: calc(var(--ag-step) - var(--ag-fold-w) / 2 + 7px); }
/* A "more" line has no glyph: its stub goes to the middle of its words — centred in its 24 px while they
   are the button for the next fifty, at its top once only a count is left. */
.agtree ul[role="group"] > li.ag-k-more { --ag-guide-y: 11px; }
.agtree ul[role="group"] > li.ag-k-more:has(> .ag-line > .ag-more:not([data-act])) { --ag-guide-y: 6px; }
/* 1.8 L-4: the details panel spans the tree's width and paints no colour of its own — the view may stand
   in the side bar or be dragged into the panel, whose colours differ, and a webview is not told where it
   stands, so a box in the side bar's colour would show as a box of another colour there. The lines give
   way to it instead: every item whose vertical crosses the tree's open details panel wears ag-gap, with
   the panel's top and bottom relative to the item's own top, 1 px clear of the panel each way (the
   script's fitGuides, after every render, resize and toggle), and its vertical is drawn above and below
   the panel and not across it; a stub stands on its item's first line, never inside a panel below it.
   The clip is no colour: a forced-colours theme keeps it, and its CanvasText rule below. */
.agtree ul[role="group"] > li.ag-gap::before { clip-path: polygon(0 0, 100% 0, 100% var(--ag-gap-t), 0 var(--ag-gap-t),
                                                             0 var(--ag-gap-b), 100% var(--ag-gap-b), 100% 100%, 0 100%); }
.ag-line { display: flex; align-items: flex-start; }
.ag-fold, .ag-pad { flex: none; width: 24px; min-height: 24px; }
/* The arrow stands at the top, on the name's line — a button would centre it in its 24 px — and
   the target is 24 px high all the same. */
.ag-fold { border: none; background: none; padding: 0; line-height: 17px; color: var(--dim);
           display: flex; align-items: flex-start; justify-content: center; box-sizing: border-box;
           cursor: pointer; user-select: none; }
/* The twisty is drawn, like the section heads', so it never ends up in the copied text. */
.ag-fold::before { content: "▾"; font-size: 9px; }
[aria-expanded="false"] > .ag-line > .ag-fold::before { content: var(--tp-closed); }
.ag-row { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 4px;
          min-height: 24px; padding: 1px 4px; border: none; background: none; text-align: start;
          font-size: var(--vscode-font-size); box-sizing: border-box; border-radius: 3px;
          color: var(--vscode-foreground); line-height: normal; cursor: pointer; }
.agtree .ag-row { user-select: none; }
.agtree .ag-row:hover { background: var(--vscode-toolbar-hoverBackground, var(--track)); }
/* 1.6 L1: the item the keyboard is on. Its ring is drawn round its line — the toggle and the row —
   and not round the item, which holds its details and its children as well; inside the line, so
   a row as wide as the sidebar keeps it whole. A click focuses the item too, and draws no ring. */
.agtree li[role="treeitem"]:focus { outline: none; }
.agtree li[role="treeitem"]:focus-visible > .ag-line { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* 1.6 N6: the glyph keeps its column, and beside it the row is two lines — the name, then the
   figures under it, left-aligned with it. Neither ever wraps: a row is two lines at any width. */
.ag-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
/* The open node: the track's tint and the focus colour's edge — the page's own two marks for
   "this one", quieter than a pressed chip, which would paint a whole row in the button colour. */
.ag-row[aria-pressed="true"], .agtree .ag-row[data-pressed="true"] { background: var(--track); color: var(--vscode-foreground);
                               box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
/* 1.13 A2 rule 2: the two things CSS has no logical form for, in a right-to-left page — the open row's edge (an inset
   box-shadow's offset is physical) at the row's inline start, and the three closed disclosures (a section's head, a
   tree node's fold, the 7-day block's button) pointing to the inline end, ◂ (--tp-closed above). Nothing else of the
   stylesheet names a direction: every other rule is in logical properties, which compute to the left-to-right ones in a
   left-to-right page, and the charts keep their own physical rules (they stay left to right, §7a Q1). */
[dir="rtl"] .ag-row[aria-pressed="true"], [dir="rtl"] .agtree .ag-row[data-pressed="true"] {
  box-shadow: inset -2px 0 0 var(--vscode-focusBorder); }
[dir="rtl"] { --tp-closed: "◂"; }
/* The name on one line (1.6 P7b, the lead's call). When the line has no room for all of it, its
   parts give way one after the other, each on an ellipsis — first what the row can best do
   without: an agent's model, the dot in front of it with it; a session's project, then a
   session's or a run's short id, down to its ellipsis. An agent's type and short id, and a
   session's or a run's prefix word and time, stay whole: only a line too short for them alone —
   the last resort — cuts the type or the prefix word, never the time. The order is each part's
   flex-shrink, a million times the next one's, so a part shrinks only once the one before it has
   gone as far as it goes: a part that shrank by a fraction of a pixel would already end on an
   ellipsis. A model left less room than its dot and the ellipsis is taken off the name whole
   (fitAgentNames): out of sight, as a figure taken off its line, and still in the page for a
   screen reader. The id and the project are in the figures' dim tone (§7a Q11). */
.ag-label { position: relative; display: flex; min-width: 0; overflow: hidden; }
.ag-label > span { flex: none; overflow: hidden; white-space: pre; text-overflow: ellipsis; }
.ag-label > .ag-proj { flex-shrink: 1000000000000; min-width: 0; color: var(--dim); }
.ag-label > .ag-model { flex-shrink: 1000000; min-width: 0; }
.ag-label > .ag-give { flex-shrink: 1000000; min-width: 1.5em; }
.ag-label > .ag-type, .ag-label > .ag-pre, .ag-label > .ag-np:only-child { flex-shrink: 1; min-width: 1.5em; }
.ag-label > .ag-sid { color: var(--dim); }
.ag-label > .ag-gone { position: absolute; inset-inline-start: 0; top: 0; width: 1px; height: 1px; clip-path: inset(50%); }
/* 1.13 fix pass 2 (Review L C-F1) — right to left only: a tree label's Latin identifier keeps its start. A part of the
   name is cut at its inline end, which right to left is its left, so a model id, a project or a short id laid out in
   it lost its beginning ("…-6" for opus-4-6). Its identifier — the short id's part itself, the model's and the project's
   span after their dot (ag-lid) — is laid out left to right in a box of its own, cut at its own end: "opus-…". The
   model's and the project's part is a row of its own there: its dot first, whole, at the inline start, then the
   identifier, which gives way; the part keeps its place in the mirrored name and its flex-shrink. A left-to-right page
   has none of these rules, and its identifier's span is no box of its own (display: contents): its text is its part's,
   the name's boxes 1.12's — it renders as before. */
.ag-label > :is(.ag-model, .ag-proj) > .ag-lid { display: contents; }
[dir="rtl"] .ag-label > :is(.ag-model, .ag-proj) { display: flex; }
[dir="rtl"] .ag-label > :is(.ag-model, .ag-proj) > .ag-lid { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; direction: ltr; unicode-bidi: isolate; }
[dir="rtl"] .ag-label > .ag-sid { direction: ltr; unicode-bidi: isolate; }
/* Launched, but its transcript not seen yet: the name is the launch's hint, not the agent's. */
.ag-k-pending > .ag-line .ag-label { font-style: italic; }
/* Usage, duration and the live clock, the silence and the tally — a session's, a run's and a
   collector's tally before their span or duration (1.6 P7b, P10c): quieter than the name, and in
   figures that do not jitter while the seconds tick — one line, whose parts the script takes
   off whole where it has no room for them (fitAgentFigures), ending it on an ellipsis; the
   browser's own ellipsis is the net under it. The silence of a running agent (1.6 N5, "silent for
   4 min") has no colour of its own: it is a fact about the clock, not an alarm. A part taken off
   the line is out of sight and still in the page, for a screen reader. 1.6 P10c: out of sight by
   its text at no size — in the line, where it was — and not by a box of its own: Chrome's
   accessibility tree reads a box placed apart (absolute, clipped) as a block of its own and puts a
   space before and after it, so the line's description read "agents 166K , 49 min 00 s". */
.ag-fig { position: relative; display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
          color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
/* 1.6 L1: for a screen reader the line's "…" says nothing — a tree item is described by its line
   (aria-describedby) —, and its parts stand apart: the dot the eye gets between two of them is
   hidden from it, so each part after the first says ", " in front of itself instead — the text
   alternative of an empty generated content, nothing to see — "12.3K, since 14:20"; a tally's
   part says nothing, its words are the item's name. */
.ag-fig.ag-cut::after { content: "\\00a0…" / ""; }
.ag-fig > .ag-fp + .ag-fp:not(:has(> .ag-t))::before { content: "" / ", "; }
.ag-fig .ag-gone { font-size: 0; }
/* 1.6 O4: the agent hook's marker — "waiting for approval" — in the figures' tone, no colour of its
   own: a marker, not an alarm. Where the line has no room for all of it, it is cut where the line's
   ellipsis begins (fitAgentFigures sets its width), its words still whole for a screen reader. */
.ag-fig .ag-hook-cut { display: inline-block; overflow: hidden; vertical-align: top; }
/* 1.6 D10: the ⚠ of an output that is a lower bound, inside the usage figure — while the script's
   ROW_LOWER_BOUND_MARK is on, as it ships. The glyph comes from a fallback font whose line box is
   a pixel taller than the figures' own; held to its font size, it never makes a row taller. */
.ag-lb { line-height: 1; }
/* 1.7 D-A: the ⚠ is hidden from a screen reader, and the words "lower bound" stand behind it as
   text of the line at no size — out of sight, read where they stand (the technique of .ag-gone),
   so the item's description reads "12.3K lower bound, since 11:59", no space of Chrome's own
   before the comma, as it put one after a name taken from an image's attribute. 1.11 B6: the same mark behind a
   figure of the Records section's tables of 1.11 (.rec-t) — a cell reads "~$12.30 lower bound". */
.ag-fig .ag-lbw, .ag-week .ag-lbw, .rec-t .ag-lbw { font-size: 0; }
/* One glyph per state, drawn from the class and coloured with the page's own tokens only:
   green and red for what the parent recorded, the provider's blue for what still runs, the
   foreground for a session in use, and the dim tone for what the tree can only call quiet — and
   for a stop the parent recorded, which is an end but neither a success nor a failure. 1.7 F4
   (§7a Q12): an unknown outcome's ? in the yellow its name wears, so glyph and name agree. */
.ag-st { flex: none; display: inline-block; width: 12px; text-align: center; font-size: 10px; }
.ag-running::before { content: "●"; color: var(--claude); }
.ag-done::before { content: "✓"; color: var(--ok); }
.ag-failed::before { content: "✕"; color: var(--error); }
.ag-stopped::before { content: "■"; color: var(--dim); }
.ag-unknown::before { content: "?"; color: var(--ag-c-unknown); }
.ag-active::before { content: "●"; color: var(--vscode-foreground); }
.ag-idle::before { content: "○"; color: var(--dim); }
/* 1.7 F2: the group of earlier sessions has no state and so no glyph — its column is kept, so its
   name starts where the sessions' names start, and holds a space that draws nothing and says
   nothing (the span is hidden from a screen reader as well). */
.ag-none::before { content: "\\00a0" / ""; }
/* Words for a screen reader alone: out of sight and out of the copied text's way, still in the
   accessibility tree. A node's tally (1.6 N1) is glyphs for the eye — "112 ✓ · 12 ✕" — which a
   screen reader would read as shapes; the words stand beside them, and the glyphs are hidden
   from it. */
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* 1.6 D7: an attempt the workflow journal superseded keeps its glyph and its name; the name fades
   to .65 (1.6 P7, the lead's call on the pictures: at .8 the dimming was hardly seen on the dark
   theme). The glyph stays at full strength (1.6 P7b, the lead's call): it is the mark of the state
   and keeps its 3:1 (WCAG 1.4.11), which at .65 it would not. The short id and the figures are in
   the dim tone already and stay so: faded as well, they would fall below 3:1 on the light theme,
   and every word of the row keeps 3:1 in both. */
.ag-sup > .ag-line > .ag-row .ag-np { opacity: .65; }
/* 1.7 F4: an outcome in the colour of the name as well — green done, yellow unknown, red failed,
   blue running (the tokens on :root) — on the rows of an agent, a launch, a run and a collector, in the
   tree, the running list and the 7-day block, whose state is one of the four and that no later attempt
   superseded: the script puts ag-c-<state> on the row. Only the name's own parts (.ag-np); the short id
   and the project keep the dim tone, the dots between the parts the foreground. No colour on a stop (its
   name in the foreground, its ■ dim), on a superseded attempt (its fade and a colour together would fall
   below 4.5:1), on a session or on the group of earlier sessions. Never the only carrier: the glyph and its
   label, the state's word in the details and in the item's name, and the tally's words stay as they were.
   A forced-colours theme gives every word its own text colour: no rule of the mode for them. */
.ag-c-done .ag-label > .ag-np { color: var(--ag-c-done); }
.ag-c-unknown .ag-label > .ag-np { color: var(--ag-c-unknown); }
.ag-c-failed .ag-label > .ag-np { color: var(--ag-c-failed); }
.ag-c-running .ag-label > .ag-np { color: var(--ag-c-running); }
/* A tally's parts in the colour of the state they count — a session's, a run's, a collector's and the
   group's too, whose names wear none; started, retried and stopped keep the figures' tone. */
.ag-t.ag-tt-done { color: var(--ag-c-done); }
.ag-t.ag-tt-unknown { color: var(--ag-c-unknown); }
.ag-t.ag-tt-failed { color: var(--ag-c-failed); }
.ag-t.ag-tt-running { color: var(--ag-c-running); }
/* The open row wears no state colour: its name in the foreground, its tally in the figures' tone. On its
   tint a colour would come close to 4.5:1, and the details under it say the state in words. */
.ag-row[aria-pressed="true"] :is(.ag-np, .ag-t), .agtree .ag-row[data-pressed="true"] :is(.ag-np, .ag-t) { color: inherit; }
/* A breath, not a blink: at its faintest the dot keeps most of its colour, so it never reads
   as switched off. */
@keyframes ag-pulse { 50% { opacity: .7; } }
/* 1.6 D3: the line under an open node that holds more children than it shows — "50 more · 377
   not shown" — in the column of its siblings' glyphs. A borderless button like a row while one
   more step can be taken, the dim words of a count once none can; 24 px high, a target (N9). */
.ag-more { flex: 1 1 auto; min-width: 0; min-height: 24px; padding: 1px 4px; border: none;
           background: none; text-align: start; font-size: 11px; font-variant-numeric: tabular-nums;
           box-sizing: border-box; border-radius: 3px; user-select: none; }
/* 1.6 L1: while a step can be taken the words are the mouse's target — the item is the keyboard's —
   in the foreground colour and centred in their 24 px as a button's would be; the count alone is dim. */
.ag-more[data-act] { display: flex; align-items: center; cursor: pointer; }
.ag-more[data-act]:hover { background: var(--vscode-toolbar-hoverBackground, var(--track)); }
.ag-more:not([data-act]) { color: var(--dim); }
/* The running list above the tree: every row is a tree row's button, glyph, name and figures,
   stretched to the width of the list, and where the agent sits is a line of its own under the
   figures. A part of that line — "Session 9d0eb37a", "Workflow run cfe7718d" — keeps together
   while it fits and breaks inside only when a narrow sidebar leaves it no line wide enough. */
.ag-now { margin-bottom: 10px; }
.ag-now ul { list-style: none; margin: 4px 0 0; padding: 0; }
.ag-now li { display: flex; flex-wrap: wrap; }
.ag-now .ag-k-pending .ag-label { font-style: italic; }
.ag-ctx > span { display: inline-block; max-width: 100%; }
/* 1.6 L3: the block's first line — its heading, or the line that says nothing runs — carries the
   disclosure of the 7-day block at its end; what follows takes the whole width under it. The
   disclosure is a chip like the page's other "more" buttons, 24 px high (a target, WCAG 2.5.8),
   its twisty drawn and silent to a screen reader, which hears the button open or closed. */
.ag-now { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; align-items: center; }
.ag-now > :not(:first-child):not(.ag-wkbtn) { grid-column: 1 / -1; }
.ag-wkbtn { justify-self: end; min-height: 24px; white-space: nowrap; }
.ag-wkbtn::after { content: "\\00a0" var(--tp-closed) / ""; font-size: 9px; }
.ag-wkbtn[aria-expanded="true"]::after { content: "\\00a0▾" / ""; }
/* 1.6 L3: where the agent tokens of the last 7 days went — after the running list, before the tree.
   The table is the page's own, and stacks at a narrow width as every table does; the name of a
   type and model and a column's head may take a second line rather than push the table out of a
   sidebar. The row of all agents is set off by a rule. The largest agents are rows as the running
   list's are, their details under them. */
.ag-week { margin-bottom: 10px; }
.ag-week > .scroll { margin-top: 4px; }
.ag-wkt { overflow-wrap: normal; }
.ag-wkt th, .ag-wkt td:first-child { white-space: normal; }
.ag-wkt tr.ag-wkall { border-top: 1px solid var(--line); }
.ag-wktop { margin-top: 8px; }
.ag-week ul { list-style: none; margin: 4px 0 0; padding: 0; }
.ag-week li { display: flex; flex-wrap: wrap; }
.ag-week li > .ag-details { flex: 1 1 100%; min-width: 0; }
/* The details of the selected node, under its row (1.6 N2): the key figure's box around a
   two-column list, the words on the left and what the view model says about them on the right.
   In the tree it stands between the row and the node's children and steps back out of the levels
   above it — --ag-ind is the node's level, set from data-ind — so it takes the tree's whole width
   however deep the node sits; in the running list it is a line of its own under the row. */
.ag-details { margin: 4px 0 6px; margin-inline-start: calc(var(--ag-ind, 0) * -16px); border: 1px solid var(--line); border-radius: 4px;
              padding: 6px 8px; }
.ag-now li > .ag-details { flex: 1 1 100%; min-width: 0; }
.ag-details dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px;
                 margin: 6px 0 0; font-size: 11px; }
.ag-details dt { color: var(--dim); }
.ag-details dd { margin: 0; min-width: 0; font-variant-numeric: tabular-nums; }
/* The state sentence and every row the view model calls a sentence — Claude Code's report,
   the agents' figure with what it is not — are sentences: beside the column of labels a
   narrow sidebar would leave them a word per line, so they take the whole width under their
   label, at every width. The short rows stay label beside value. */
.ag-details .ag-wide { grid-column: 1 / -1; }
.ag-details dd.ag-wide { margin-bottom: 2px; }
/* The ID row: the whole identifier, which may break anywhere rather than leave the panel, and
   the button that copies it, as small as the text beside it. */
.ag-details .ag-id { overflow-wrap: anywhere; }
.ag-copy { margin-inline-start: 4px; padding: 0 6px; }
/* 1.6 L2: an agent's token mix — one bar across the panel, a part per kind of token in the Tokens
   section's own colours, each as wide as its share (set through the CSSOM), and its words under it. */
.ag-mix { display: flex; height: 8px; margin: 3px 0 2px; border-radius: 4px; overflow: hidden; background: var(--track); }
.ag-mix > i { display: block; height: 100%; }
.ag-mixtext { display: block; }
/* 1.10 A2: the Prompts section. The intro and the target line in the dim tone (.meta, 4.5:1 on either theme); the
   target line's level is a class and paints nothing — its words say it. The flash line is always there (a live region
   has to exist before what it announces) and takes no room while it is empty. */
.pr-intro, .pr-target { margin: 0 0 4px; }
.pr-flash { margin: 4px 0 0; }
.pr-flash:empty { margin: 0; }
.pr-ro { margin: 6px 0 0; }
/* The list: an entry per row — the entry's button across the row, its title and under it its text clamped to two
   lines (the whole text is the button's tooltip; a slash command in the editor's font), and its send button beside
   it. Every button at least 24 × 24 px (WCAG 2.5.8), a stop of the Tab key with the page's focus ring; nothing moves. */
.pr-list { list-style: none; margin: 6px 0 0; padding: 0; }
.pr { display: flex; align-items: stretch; gap: 4px; margin: 0 0 4px; }
.pr-main { flex: 1 1 auto; min-width: 0; min-height: 24px; display: block; box-sizing: border-box; padding: 3px 6px;
           text-align: start; font-size: inherit; line-height: 1.35; background: none; }
.pr-main:hover { background: var(--vscode-list-hoverBackground, var(--track)); }
.pr-title { display: block; }
.pr-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.pr-text.pr-cmd { font-family: var(--vscode-editor-font-family, monospace); }
.pr-send { flex: none; display: flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px;
           box-sizing: border-box; padding: 0 5px; }
.pr-send svg { display: block; width: 12px; height: 12px; }
/* The open fields in the entry's place: a named group, the two labelled fields as wide as the row (the field
   colours of the theme), the counter and the error line, then the bar — or the delete question in its place, the
   question on a line of its own above its two buttons. At 200 % zoom and at 260 px everything wraps; nothing is
   wider than the row. */
.pr.editing { display: block; }
.pr-edit { display: flex; flex-direction: column; gap: 4px; min-width: 0; box-sizing: border-box; padding: 6px;
           border: 1px solid var(--line); border-radius: 4px; }
.pr-edit:focus { outline: none; }
.pr-edit label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--dim); }
.pr-edit input, .pr-edit textarea {
  font-family: inherit; font-size: inherit; line-height: 1.35; width: 100%; min-height: 24px; box-sizing: border-box;
  margin: 0; padding: 3px 6px; border-radius: 2px; cursor: text;
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--line));
}
.pr-edit textarea { resize: vertical; }
.pr-edit ::placeholder { color: var(--vscode-input-placeholderForeground, var(--dim)); opacity: 1; }
.pr-edit input:focus-visible, .pr-edit textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pr-err { margin: 0; color: var(--ag-c-failed); }
.pr-bar, .pr-ask { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.pr-ask > span { flex: 1 1 100%; }
.pr-bar button, .pr-ask button, .pr-foot button { min-height: 24px; }
.pr-foot { margin-top: 6px; }
/* A control that does nothing now (a move at an end, New prompt at 50, every edit of a list that cannot be saved):
   still a stop of the Tab key, and heard as unavailable — seen as faded. */
.pr button[aria-disabled="true"], .pr-foot button[aria-disabled="true"] { opacity: .55; cursor: default; }
@media (max-width: 320px) {
  .kpis { grid-template-columns: 1fr; }
  table, thead, tbody, th, td, tr { display: block; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--line); padding: 4px 0; }
  /* A stacked cell is a block of its own width, so the base "white-space: nowrap" (which keeps
     a real table's columns from breaking) turns a long value — the tools section's model list
     is the first one long enough to notice — into text running past the card. Nothing is lost,
     the wrapper still scrolls, but needing a sideways scroll to read one "label: value" line is
     exactly what the stacked layout exists to avoid. */
  td { text-align: start; padding: 1px 0; white-space: normal; }
  /* Only cells that carry a header: the sub-rows and the drill lines span the whole table
     and would otherwise be prefixed with a bare ": ". 1.10 D10: the label as the language writes it —
     data-hl is the column name in the words' "{0}:" ("Période :" with a no-break space, "期間："). 1.11 D1: with
     its one gap before the value in it — a space, none after a full-width colon (dh() in the page script). */
  td[data-h]::before { content: attr(data-hl); color: var(--dim); }
}
/* 1.6 L3: at a narrow width the 7-day table stacks tighter than the page's other tables — a row's
   type and model on a line of their own, then its figures, each with its column's name, as many
   to a line as fit; the two cells the row of all agents leaves empty are not drawn at all. */
@media (max-width: 320px) {
  .ag-wkt td:first-child::before { content: none; }
  .ag-wkt td:not(:first-child) { display: inline-block; margin-inline-end: 10px; padding: 0; white-space: nowrap; }
  .ag-wkt td:empty { display: none; }
}
@media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
/* The running glyph breathes only for a reader who has not asked for less motion; for anyone
   else it is a steady dot, and the state is in its title either way. */
@media (prefers-reduced-motion: no-preference) {
  .ag-running::before { animation: ag-pulse 2s ease-in-out infinite; }
}
/* 1.6 N9: in a forced-colours theme (Windows High Contrast) the agent tree's marks take the
   system's colours — the glyphs and the ⚠ the text's, the twisty a button's, and each part of the
   details' token mix (1.6 L2) a border of the text's, the theme having taken its fill — and the open row,
   whose tint and edge the theme removes, a 2 px outline in the highlight colour. 1.6 L1: the item
   the keyboard is on, a 2 px ring round its line in the text colour — never the highlight's, so an
   open row that has the focus shows both. 1.6 O2: the chart split by main session and subagent
   keeps its two parts apart — the theme removes every gradient and gives every other background
   the page's own colour, so the plain hue of the main sessions and the stripes of the subagents
   would both be painted away: the main sessions a solid band in the text colour, the subagents a
   band of the page colour ringed 1 px inside by the text colour (a legend swatch wears its band's
   classes, so it shows the same). 1.6 P16: every pressed chip — a range, a provider, a model, the
   custom dates, the cache switch, the chart's split and cost line, the heatmap's metric, the hours'
   zone — in the highlight colours: the theme gives every button the same face and takes the button
   colours a pressed chip wears, so pressed and released would look alike and the state would be
   heard but not seen. The chip is taken out of the theme's adjustment: with it on,
   Chrome paints a backplate of the page colour behind every word, and the highlight text is made to
   stand on the highlight, not on the page colour — in the usual themes it is the page colour itself,
   so the chip's words would vanish (1.6 P16's harness pictures). Taken out, it wears the theme's
   system colours alone: the highlight as its face and edge, the highlight text for its words, the
   text colour for its focus ring. Not the pressed rows of the running list and the 7-day block,
   which are buttons as well: they stay in the adjustment and keep the open row's 2 px outline,
   quieter than a chip, as the tree's rows do. 1.7 D-B: the chart's bands by model — every band but
   the split's two parts, a legend swatch too — are the other thing taken out: the theme removes every
   gradient and gives every other background the page colour, so all of them were the page colour.
   Taken out, they wear the theme's two colours alone, the text's and the page's, as patterns by rank
   whatever the style (the shade style has no pattern of its own to fall back on) — the largest model
   solid in the text colour, then 45° and 135° stripes, the cross-hatch, the horizontal lines and the
   dots of the other models —, each ringed 1 px inside by the page colour but a band under 4 px tall,
   which the ring would cover whole (1.7 P7b); the hue that told the providers apart cannot survive
   two colours, so the legend's headings, the band's tooltip and the column order do. The split keeps
   its own two rules below, in the adjustment — but a subagents' band drawn under 4 px tall (1.8 L-5),
   which its 1 px ring of the text colour, at its top and at its bottom, would fill whole, so that it
   read as a main sessions' band: it is striped instead, one pixel of the text colour in three, across
   its width, taken out of the adjustment for that one rule (the theme would remove the gradient). The
   theme's own adjustment is left on everywhere else. */
@media (forced-colors: active) {
  button[aria-pressed="true"]:not(.ag-row) { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; outline-color: CanvasText; }
  .ag-st::before, .ag-lb { color: CanvasText; }
  .ag-fold::before { color: ButtonText; }
  .ag-mix > i { border: 1px solid CanvasText; box-sizing: border-box; }
  .ag-row[aria-pressed="true"], .agtree .ag-row[data-pressed="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
  .agtree li[role="treeitem"]:focus-visible > .ag-line { outline: 2px solid CanvasText; }
  /* 1.7 F6: the guide lines in the text colour — the theme would give a border its own anyway; said here. */
  .agtree ul[role="group"] > li::before, .agtree ul[role="group"] > li::after { border-color: CanvasText; }
  /* 1.9 A6: a flag is a picture, not a colour code — it keeps its colours (the name beside it carries the
     meaning), and a 1 px outline in the text colour keeps its edge on any background. The globe of Automatic
     stays in the adjustment: drawn in currentColor, it follows the mode (taken out, it would keep the theme's
     menu foreground, which the mode's own palette does not know). The open list is the theme's Canvas and
     CanvasText with a 1 px border in the text colour (the mode gives it that); the focused item, whose
     selection colours the mode removes, is outlined in the highlight colour. */
  .flag:not(.flag-auto) { forced-color-adjust: none; outline: 1px solid CanvasText; }
  .lng-pop { border-color: CanvasText; }
  .lng-pop li:focus { outline: 2px solid Highlight; outline-offset: -2px; }
  /* 1.10 A5: the Prompts section — every button in the theme's button colours (the entry's own face is none
     without the mode), the fields in the field colours with a 1 px edge in the text colour, the send glyph in
     currentColor (its button's text colour), a control that does nothing in the disabled text colour instead of a
     fade, the focused control ringed 2 px in the highlight colour. The target line's level is a word, never a colour. */
  .pr-main, .pr-send, .pr-bar button, .pr-ask button, .pr-foot button { background-color: ButtonFace; color: ButtonText; border-color: ButtonText; }
  .pr-main .pr-text { color: ButtonText; }
  .pr-edit input, .pr-edit textarea { background-color: Field; color: FieldText; border: 1px solid CanvasText; }
  .pr button[aria-disabled="true"], .pr-foot button[aria-disabled="true"] { color: GrayText; border-color: GrayText; opacity: 1; }
  .pr-main:focus-visible, .pr-send:focus-visible, .pr-edit button:focus-visible, .pr-foot button:focus-visible,
  .pr-edit input:focus-visible, .pr-edit textarea:focus-visible { outline: 2px solid Highlight; outline-offset: 1px; }
  /* 1.7 D-B: the bands by model — the theme would paint them all away. Two system colours, the rank as
     the pattern style draws it, each band ringed 1 px inside by the page colour so two solid bands side
     by side stay two. Taken out of the theme's adjustment: a gradient is otherwise removed. 1.7 P7b: a
     band drawn under 4 px tall (band-thin, which the script's fitBands hands out) has no ring — at the
     top and at the bottom it would cover such a band whole, a gap in the column — and keeps its pattern
     or its solid paint alone (the dots of other in its middle, below). */
  .band:not(.sp-main, .sp-sub) { forced-color-adjust: none; background: Canvas; }
  .band:not(.sp-main, .sp-sub, .band-thin) { outline: 1px solid Canvas; outline-offset: -1px; }
  .band.r0:not(.sp-main, .sp-sub) { background: CanvasText; }
  .band.r1:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(45deg, CanvasText 0 2px, Canvas 2px 4px); }
  .band.r2:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(135deg, CanvasText 0 2px, Canvas 2px 4px); }
  .band.r3:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(45deg, CanvasText 0 1px, transparent 1px 4px),
                                               repeating-linear-gradient(135deg, CanvasText 0 1px, Canvas 1px 4px); }
  .band.r4:not(.sp-main, .sp-sub) { background: repeating-linear-gradient(0deg, CanvasText 0 2px, Canvas 2px 4px); }
  .band.rother:not(.sp-main, .sp-sub) { background: radial-gradient(CanvasText 1px, Canvas 1.2px); background-size: 4px 4px; }
  /* 1.7 P7b: on a thin band the dots of other stand in its middle — at the top of their 4 px tile, 2 px
     down, they miss a band under 2 px tall, which would be the page colour alone: the gap again. */
  .band.band-thin.rother:not(.sp-main, .sp-sub) { background-position: 0 50%; }
  .band.sp-main { background: CanvasText; }
  .band.sp-sub { background: Canvas; outline: 1px solid CanvasText; outline-offset: -1px; }
  /* 1.8 L-5: a thin subagents' band (band-thin, the script's fitBands) — vertical stripes, readable at any
     height, where the ring would make it solid like a main sessions' band. */
  .band.sp-sub.band-thin { forced-color-adjust: none; outline: none; background: repeating-linear-gradient(90deg, CanvasText 0 1px, Canvas 1px 3px); }
}
`

// ---------------------------------------------------------------------------
// Webview script
// ---------------------------------------------------------------------------

/**
 * The page's script: src/webview/main.ts, built by build.mjs and injected here as text
 * through the virtual module `webview:script` — so the compiler sees every line of it, which
 * it never did while this was a template string.
 *
 * The seven names in front of it are what a browser bundle cannot reach: the provider
 * registry is Node code (fs, os, path), and so is the localisation seam; the agent tree's paging
 * steps and the silence after which a running agent's row says so (1.6 N5) are
 * src/agentTree.ts's, written here so the page cannot count them differently; the language
 * picker's flags (1.9 A3b) are src/flags.ts's. `L10N` and `LOCALE` are the two a language switch
 * sets anew without a reload (1.9 A3.4): the whole push after it carries them (`words`). They are written at
 * the top of the very same <script>, where the module below reads them out of its own scope;
 * src/webview/globals.d.ts declares them for the compiler. A function rather than a const,
 * because `t()` may only run once the host has set the bundle — at render time, not at load.
 * Still a string concatenation, though: rendering a page touches no file.
 */
function scriptText(): string {
  return `
/** The provider titles, interpolated from the registry so the webview cannot drift from it. */
const SRC_TITLE = ${inline(SOURCE_TITLE)};
/** The provider ids in registry order — the order of the provider switch's buttons (1.7 F1). */
const SRC_IDS = ${inline(SOURCES)};
/** Every string the module below shows, keyed by its English text — see webviewWords(). A language switch replaces its entries (applyWords). */
const L10N = ${webviewDictionary()};
/** The tag the host's Intl formatters use, so the page's own numbers read like the model's. A switch sets it anew (applyWords). */
let LOCALE = ${inline(locale())};
/** The language picker's flags (src/flags.ts FLAG_SVG): inline SVG by FlagId and 'auto' — no font, no file. */
const FLAGS = ${inline(FLAG_SVG)};
/** How many children an open agent-tree node shows per "more" step, and at most how many steps. */
const AGENT_PAGING = ${inline({ groupChildren: MAX_GROUP_CHILDREN, morePages: MAX_MORE_PAGES })};
/** After how long without a line a running agent's row says "silent for …" (SILENT_AFTER_MS). */
const AGENT_SILENT_MS = ${inline(SILENT_AFTER_MS)};
${script}`
}

/**
 * The dictionary as it is written into the page.
 *
 * The values are HTML-escaped here, once, because the module concatenates a translation into
 * markup and into attribute values without escaping it again (see `tr()` in
 * src/webview/main.ts). A bundle is a file — one a distribution, a patch or a hand edit could
 * get wrong — and the test that forbids markup in a translation runs only over the files that
 * ship; this makes the page safe against a bundle that never met that test. English is
 * unchanged by it: no key carries one of the five characters. The keys stay as they are, they
 * are what `tr()` looks up. Then `<` is escaped in the JSON as well, the one character that
 * could end the <script> element early.
 */
function webviewDictionary(): string {
  return inline(webviewDictionaryObject())
}

/** The dictionary before it is written into the script: `webviewWords()` through `t()`, every value HTML-escaped. */
function webviewDictionaryObject(): Record<string, string> {
  const words = webviewWords()
  const safe: Record<string, string> = {}
  for (const key of Object.keys(words)) safe[key] = escHtml(words[key])
  return safe
}

/**
 * Every string src/webview/main.ts shows, keyed by the English text `tr()` looks it up with.
 *
 * The list is written out rather than derived: `scripts/l10n-extract.mjs` reads the source of
 * `t()`, not its arguments at run time, and src/webview is not scanned at all (it imports no
 * seam of its own). So this is where a webview string becomes a translatable key — a call to
 * `tr()` with no entry here reaches the reader in English for good, which is what the
 * dictionary test in test/dashboard.test.ts exists to catch.
 *
 * Two rules for the values. They are markup, not text: a translation with `<`, `>`, `&` or a
 * double quote in it would land in an attribute or a tag half-escaped, and
 * test/dashboard.test.ts refuses one, in the English dictionary and in every shipped bundle.
 * And a string the view model already delivers — every label, explanation and caption the
 * model builds — is translated there, never a second time here.
 */
function webviewWords(): Record<string, string> {
  return {
    'A budget is your own number. USD is the hypothetical API equivalent, not a bill, and no budget is ever added to another.':
      t('A budget is your own number. USD is the hypothetical API equivalent, not a bill, and no budget is ever added to another.'),
    // 1.10 A2: the Prompts section's words (§3 A6) — the page's own; the cleaning's three reasons are the model's too.
    'A prompt that starts with an exclamation mark would run a shell command in Claude Code.':
      t('A prompt that starts with an exclamation mark would run a shell command in Claude Code.'),
    'API cost': t('API cost'),
    'API cost (second axis)': t('API cost (second axis)'),
    // 1.11 C3: the cost column's head while custom rates apply.
    'API cost (your rates)': t('API cost (your rates)'),
    'Active days': t('Active days'),
    'Activity': t('Activity'),
    'Agent entries, last 7 days': t('Agent entries, last 7 days'),
    'Agents': t('Agents'),
    'All': t('All'),
    'All agents': t('All agents'),
    // 1.14 A5 rule 4 (§7a Q23): the line under the head of each section the project filter does not reach.
    'All projects — the project filter does not apply to this section.': t('All projects — the project filter does not apply to this section.'),
    'At most {0} prompts.': t('At most {0} prompts.'),
    'Avg turn time {0}': t('Avg turn time {0}'),
    'Avg turn time {0} · P90 {1}': t('Avg turn time {0} · P90 {1}'),
    'Avg/day': t('Avg/day'),
    'Basis': t('Basis'),
    'Blended': t('Blended'),
    'Blended $/1M': t('Blended $/1M'),
    'Budgets': t('Budgets'),
    'CV {0} · {1} spiky day(s)': t('CV {0} · {1} spiky day(s)'),
    'Cache': t('Cache'),
    'Cache read': t('Cache read'),
    // 1.11 B6, B7: the heads and titles of the Records section's four new tables.
    'Cache written': t('Cache written'),
    'Cache · last 30 days': t('Cache · last 30 days'),
    'Calibration {0} {1}: {2}': t('Calibration {0} {1}: {2}'),
    'Calls': t('Calls'),
    'Cancel': t('Cancel'),
    'Chart': t('Chart'),
    'Compared with': t('Compared with'),
    'Connect the status line': t('Connect the status line'),
    'Consent: {0} · {1} · attribution {2} · v{3}': t('Consent: {0} · {1} · attribution {2} · v{3}'),
    'Context window': t('Context window'),
    'Copy ID': t('Copy ID'),
    'Coverage {0} → {1} · {2} hour / {3} day / {4} month buckets · snapshot {5} KB':
      t('Coverage {0} → {1} · {2} hour / {3} day / {4} month buckets · snapshot {5} KB'),
    'Data quality': t('Data quality'),
    'Day': t('Day'),
    'Day {0}': t('Day {0}'),
    'Delete': t('Delete'),
    'Delete “{0}”?': t('Delete “{0}”?'),
    'Details': t('Details'),
    'Duration': t('Duration'),
    'Edit “{0}”': t('Edit “{0}”'),
    'Enter edits it, Ctrl+Enter sends it.': t('Enter edits it, Ctrl+Enter sends it.'),
    'Enter edits it, ⌘+Enter sends it.': t('Enter edits it, ⌘+Enter sends it.'),
    'Extra usage': t('Extra usage'),
    'Extra usage (billed)': t('Extra usage (billed)'),
    'Fetch quota now': t('Fetch quota now'),
    'Fields reported but not rendered ({0}): {1}': t('Fields reported but not rendered ({0}): {1}'),
    'Fresh in': t('Fresh in'),
    'Generated {0}.': t('Generated {0}.'),
    'Hit': t('Hit'),
    'Hit rate': t('Hit rate'),
    'Hour': t('Hour'),
    'Hours with the most cache written': t('Hours with the most cache written'),
    'How': t('How'),
    'Keep': t('Keep'),
    'Key figures': t('Key figures'),
    'Largest sessions': t('Largest sessions'),
    'Last 7 days': t('Last 7 days'),
    'Last 7 days · where the agent tokens went': t('Last 7 days · where the agent tokens went'),
    'Last activity': t('Last activity'),
    'Longest sessions': t('Longest sessions'),
    'Longest streak {0}': t('Longest streak {0}'),
    'Longest streak {0} day · {1} → {2}': t('Longest streak {0} day · {1} → {2}'),
    'Longest streak {0} days · {1} → {2}': t('Longest streak {0} days · {1} → {2}'),
    'Median per agent': t('Median per agent'),
    'Lower bound share {0}': t('Lower bound share {0}'),
    'Model': t('Model'),
    'Models': t('Models'),
    'Most expensive days': t('Most expensive days'),
    'Move down': t('Move down'),
    'Move up': t('Move up'),
    'New prompt': t('New prompt'),
    'No Claude Code session in the last 7 days.': t('No Claude Code session in the last 7 days.'),
    'No agent is running.': t('No agent is running.'),
    'No agent of the last 7 days has a counted request.': t('No agent of the last 7 days has a counted request.'),
    'No budget configured. tokenPace.budgets takes your own limit per provider, period and unit.':
      t('No budget configured. tokenPace.budgets takes your own limit per provider, period and unit.'),
    'No context reading. The Claude Code status line is what reports it.':
      t('No context reading. The Claude Code status line is what reports it.'),
    'No cycles on file yet.': t('No cycles on file yet.'),
    'No data in this range.': t('No data in this range.'),
    'No model data in this range.': t('No model data in this range.'),
    'No project data yet.': t('No project data yet.'),
    'No quota reading yet. There are two ways to get one: fetch it from the provider, which asks for network access first, or connect the Claude Code status line, which mirrors the figures Claude Code already has on this machine.':
      t('No quota reading yet. There are two ways to get one: fetch it from the provider, which asks for network access first, or connect the Claude Code status line, which mirrors the figures Claude Code already has on this machine.'),
    'No records yet.': t('No records yet.'),
    'No session data yet.': t('No session data yet.'),
    'No tool call counted in this range.': t('No tool call counted in this range.'),
    'No tool calls counted.': t('No tool calls counted.'),
    'Not enough data for a summary yet.': t('Not enough data for a summary yet.'),
    'Of it 1 h': t('Of it 1 h'),
    'Open settings': t('Open settings'),
    'Output': t('Output'),
    'Peak day {0}': t('Peak day {0}'),
    'Peak day {0} · {1}': t('Peak day {0} · {1}'),
    'Per req.': t('Per req.'),
    'Period': t('Period'),
    'Preview data — not a reading.': t('Preview data — not a reading.'),
    'Prices as of {0} · your configured rates.': t('Prices as of {0} · your configured rates.'),
    'Prices as of {0}.': t('Prices as of {0}.'),
    'Prices as of {0}; checked later: {1} · your configured rates.': t('Prices as of {0}; checked later: {1} · your configured rates.'),
    'Prices as of {0}; checked later: {1}.': t('Prices as of {0}; checked later: {1}.'),
    'Project': t('Project'),
    'Project attribution is off (tokenPace.attribution).':
      t('Project attribution is off (tokenPace.attribution).'),
    'Projects': t('Projects'),
    'Prompts': t('Prompts'),
    'Providers': t('Providers'),
    'Quota': t('Quota'),
    'Quota history {0} samples · {1} KB · oldest {2}': t('Quota history {0} samples · {1} KB · oldest {2}'),
    'Range': t('Range'),
    'Re-read token history': t('Re-read token history'),
    'Realised': t('Realised'),
    'Reasoning': t('Reasoning'),
    'Rebuild from the transcripts and fetch the quota':
      t('Rebuild from the transcripts and fetch the quota'),
    'Records': t('Records'),
    'Refresh': t('Refresh'),
    'Req.': t('Req.'),
    'Reset history': t('Reset history'),
    'Restore default prompts': t('Restore default prompts'),
    'Retention {0} d hourly · {1} d daily · {2} d quota history':
      t('Retention {0} d hourly · {1} d daily · {2} d quota history'),
    'Roots: {0} · {1} file(s)': t('Roots: {0} · {1} file(s)'),
    'Running now ({0})': t('Running now ({0})'),
    'Save': t('Save'),
    'Send “{0}”': t('Send “{0}”'),
    'Session': t('Session'),
    'Session attribution is off (tokenPace.attribution).':
      t('Session attribution is off (tokenPace.attribution).'),
    'Sessions': t('Sessions'),
    'Settings for this section': t('Settings for this section'),
    'Share': t('Share'),
    'Sources {0}: {1}': t('Sources {0}: {1}'),
    'Spark': t('Spark'),
    'Split': t('Split'),
    'Started': t('Started'),
    'State': t('State'),
    'Status line: {0}': t('Status line: {0}'),
    'Subagent tokens in the hour buckets, last 7 days': t('Subagent tokens in the hour buckets, last 7 days'),
    'Summary': t('Summary'),
    'Time': t('Time'),
    'Time of day': t('Time of day'),
    'Text': t('Text'),
    // 1.14 §3 A4 rule 7: the Tokens section's first line while a project chip is pressed — it follows the chips.
    'The project filter applies to this section — the range and the models of the filter bar do not.':
      t('The project filter applies to this section — the range and the models of the filter bar do not.'),
    'The text is empty.': t('The text is empty.'),
    'The title is empty.': t('The title is empty.'),
    'This prompt was deleted in another window; your changes were not saved.':
      t('This prompt was deleted in another window; your changes were not saved.'),
    'Title': t('Title'),
    'The largest agent': t('The largest agent'),
    'The {0} largest agents': t('The {0} largest agents'),
    'Tokens': t('Tokens'),
    'Tool': t('Tool'),
    'Tools': t('Tools'),
    'Type · model': t('Type · model'),
    'Top projects and sessions need tokenPace.attribution.':
      t('Top projects and sessions need tokenPace.attribution.'),
    'Usage': t('Usage'),
    'What': t('What'),
    'Write 1h': t('Write 1h'),
    'Write 5m': t('Write 5m'),
    'active session': t('active session'),
    'agents {0}': t('agents {0}'),
    'all': t('all'),
    'and {0} more': t('and {0} more'),
    'apply': t('apply'),
    'by weekday and four-hour block · {0}': t('by weekday and four-hour block · {0}'),
    'cache': t('cache'),
    'cache read': t('cache read'),
    'chart metric': t('chart metric'),
    'clear': t('clear'),
    'clear stored data': t('clear stored data'),
    'click a column for that day': t('click a column for that day'),
    'close': t('close'),
    'context window: {0}': t('context window: {0}'),
    'copy diagnostics': t('copy diagnostics'),
    'copy summary': t('copy summary'),
    'cost': t('cost'),
    'cost line': t('cost line'),
    'custom…': t('custom…'),
    'daily bars · {0} columns': t('daily bars · {0} columns'),
    'done': t('done'),
    'dotted = outside coverage': t('dotted = outside coverage'),
    'dotted = outside coverage (before {0})': t('dotted = outside coverage (before {0})'),
    'elapsed share not yet used': t('elapsed share not yet used'),
    'exhausted': t('exhausted'),
    'export CSV': t('export CSV'),
    'export JSON': t('export JSON'),
    'failed': t('failed'),
    'family-priced: {0}': t('family-priced: {0}'),
    'fewer ▴': t('fewer ▴'),
    'from': t('from'),
    'hatched: no usage in that block': t('hatched: no usage in that block'),
    'hidden': t('hidden'),
    'idle session': t('idle session'),
    'last month': t('last month'),
    'less': t('less'),
    'limit reached': t('limit reached'),
    'local': t('local'),
    'lower bound': t('lower bound'),
    'models ({0}) ▾': t('models ({0}) ▾'),
    'month projection {0} · {1}': t('month projection {0} · {1}'),
    'month to date': t('month to date'),
    'more': t('more'),
    'more ▾': t('more ▾'),
    'no hour data · {0} day(s)': t('no hour data · {0} day(s)'),
    'no source answered': t('no source answered'),
    'no usage in this block': t('no usage in this block'),
    'none': t('none'),
    'not every agent has a price: the sum is a lower bound': t('not every agent has a price: the sum is a lower bound'),
    'ok': t('ok'),
    'output': t('output'),
    'output is a lower bound: some requests had no terminal line':
      t('output is a lower bound: some requests had no terminal line'),
    'over': t('over'),
    'over the limit': t('over the limit'),
    'own {0}': t('own {0}'),
    'peak {0} ({1})': t('peak {0} ({1})'),
    'peak {0}:00 · {1} day(s)': t('peak {0}:00 · {1} day(s)'),
    'priced from a related model (family fallback)': t('priced from a related model (family fallback)'),
    'projected at the reset': t('projected at the reset'),
    // 1.14 A5 rule 1: the Projects row's fold, as the Models row's.
    'projects ({0}) ▾': t('projects ({0}) ▾'),
    'projected {0} by {1}': t('projected {0} by {1}'),
    'quota sparkline, 7 days': t('quota sparkline, 7 days'),
    'reasoning': t('reasoning'),
    'requests': t('requests'),
    'reset due': t('reset due'),
    'resets {0}': t('resets {0}'),
    'resets at {0}': t('resets at {0}'),
    'running': t('running'),
    'running for {0}': t('running for {0}'),
    'silent for {0}': t('silent for {0}'),
    'silent since {0}': t('silent since {0}'),
    'since {0}': t('since {0}'),
    'scroll sideways for the remaining columns →': t('scroll sideways for the remaining columns →'),
    'shown': t('shown'),
    'some models have no price on file': t('some models have no price on file'),
    'span from the first to the last line': t('span from the first to the last line'),
    'sparkline: last 7 days': t('sparkline: last 7 days'),
    'stale': t('stale'),
    'stopped': t('stopped'),
    'streak {0} · longest {1} · active {2}': t('streak {0} · longest {1} · active {2}'),
    'sub': t('sub'),
    'subagents': t('subagents'),
    'superseded by a later attempt': t('superseded by a later attempt'),
    'time elapsed': t('time elapsed'),
    'time elapsed in this window': t('time elapsed in this window'),
    'to': t('to'),
    'today': t('today'),
    'unavailable': t('unavailable'),
    'unknown': t('unknown'),
    'unlimited': t('unlimited'),
    'unpriced: {0}': t('unpriced: {0}'),
    'updated {0}': t('updated {0}'),
    'usage': t('usage'),
    'used beyond the elapsed share': t('used beyond the elapsed share'),
    'utc': t('utc'),
    'waits for a child agent': t('waits for a child agent'),
    'week to date': t('week to date'),
    'weekly bars · {0} columns': t('weekly bars · {0} columns'),
    'without cache · {0} tokens cache read and {1} cache write not shown':
      t('without cache · {0} tokens cache read and {1} cache write not shown'),
    'without cache · {0} tokens cache read not shown': t('without cache · {0} tokens cache read not shown'),
    'without cache · {0} tokens cache write not shown':
      t('without cache · {0} tokens cache write not shown'),
    'year': t('year'),
    'yesterday': t('yesterday'),
    '{0} ago': t('{0} ago'),
    '{0} / {1} characters': t('{0} / {1} characters'),
    '{0} call(s) · {1} distinct tool(s)': t('{0} call(s) · {1} distinct tool(s)'),
    '{0} composition · last 30 days': t('{0} composition · last 30 days'),
    '{0} more': t('{0} more'),
    '{0} more not listed': t('{0} more not listed'),
    '{0} more — set tokenPace.dashboard.modelRows': t('{0} more — set tokenPace.dashboard.modelRows'),
    '{0} more · {1} not shown': t('{0} more · {1} not shown'),
    '{0} not shown': t('{0} not shown'),
    '{0} of {1}': t('{0} of {1}'),
    '{0} older session(s) not shown.': t('{0} older session(s) not shown.'),
    '{0} tokens over {1} day(s)': t('{0} tokens over {1} day(s)'),
    '{0} · derived': t('{0} · derived'),
    '{0} · recorded': t('{0} · recorded'),
    // 1.14 B6 (§7a Q18): the list separator, applied pairwise by the page's listOf (the host's is src/i18n.ts listOf).
    '{0}, {1}': t('{0}, {1}'),
    '{0}, derived': t('{0}, derived'),
    '{0}, recorded': t('{0}, recorded'),
    '{0} · {1} · {2} · {3} % of the day · {1} total {4}':
      t('{0} · {1} · {2} · {3} % of the day · {1} total {4}'),
    '{0} · {1} · {2} · {3} % of the week · {1} total {4}':
      t('{0} · {1} · {2} · {3} % of the week · {1} total {4}'),
    // 1.6 O2: a band of the split names its provider in its label, so its tooltip names it once.
    '{0} · {1} · {2} % of the day · {3} total {4}': t('{0} · {1} · {2} % of the day · {3} total {4}'),
    '{0} · {1} · {2} % of the week · {3} total {4}': t('{0} · {1} · {2} % of the week · {3} total {4}'),
    '{0}: {1} of {2}': t('{0}: {1} of {2}'),
    // 1.10 D10: the label a stacked table cell prints in front of its value, the column's name in {0}.
    '{0}:': t('{0}:'),
    '~1 of them running': t('~1 of them running'),
    '~Cost': t('~Cost'),
    '~{0} of them running': t('~{0} of them running'),
    '≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals':
      t('≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals'),
  }
}
