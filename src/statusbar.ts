// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from 'vscode'
import { Aggregator, billable } from './agg'
import { ModelPrice } from './prices'
import {
  ageMinutes, BarStyle, compact, extraUsageText, lastDays, relativeTime, renderBar,
  severity, Severity, usd, windowElapsed,
} from './render'
import { QuotaState, QuotaWindow, Source } from './types'

// All three IDs are registered in the workbench bundle and defined for
// dark/light/hcDark/hcLight. An unknown ThemeColor id fails silently
// (getColor -> undefined -> style.color = ""), so typos would be invisible.
const COLOR: Record<Severity, string> = {
  ok: 'charts.green',
  warn: 'charts.yellow',
  error: 'charts.red',
}

/** Which entries the status bar may show. */
export type StatusPart = 'claudeQuota' | 'codexQuota' | 'extra' | 'tokens' | 'cost'

export interface UiConfig {
  show: Set<StatusPart>
  windows: 'all' | 'leading'
  barWidth: number
  barStyle: BarStyle
  alignment: 'left' | 'right'
  staleAfterMinutes: number
  showCost: boolean
  customPrices: Record<string, ModelPrice>
}

export function readConfig(): UiConfig {
  const c = vscode.workspace.getConfiguration('tokenPace')
  return {
    show: new Set(c.get<StatusPart[]>('statusBar.show', ['claudeQuota', 'codexQuota', 'tokens'])),
    windows: c.get<'all' | 'leading'>('windows', 'all'),
    barWidth: c.get<number>('barWidth', 8),
    barStyle: c.get<BarStyle>('barStyle', 'line'),
    alignment: c.get<'left' | 'right'>('alignment', 'left'),
    staleAfterMinutes: c.get<number>('staleAfterMinutes', 20),
    showCost: c.get<boolean>('showCost', true),
    customPrices: c.get<Record<string, ModelPrice>>('customPrices', {}),
  }
}

/** Which windows go into the status bar. With 'leading', only the most loaded one. */
function shown(q: QuotaState, mode: 'all' | 'leading'): QuotaWindow[] {
  if (mode === 'all') return q.windows
  let best: QuotaWindow | null = null
  for (const w of q.windows) if (!best || w.percent > best.percent) best = w
  return best ? [best] : []
}

const LABEL: Record<Source, string> = { claude: 'CC', codex: 'CDX' }
const TITLE: Record<Source, string> = { claude: 'Claude Code', codex: 'Codex' }

export class StatusBar implements vscode.Disposable {
  private items: vscode.StatusBarItem[] = []
  private cfg: UiConfig

  constructor() {
    this.cfg = readConfig()
  }

  reloadConfig(): void {
    this.cfg = readConfig()
    this.dispose()
    this.items = []
  }

  private item(index: number): vscode.StatusBarItem {
    let it = this.items[index]
    if (!it) {
      const align =
        this.cfg.alignment === 'right'
          ? vscode.StatusBarAlignment.Right
          : vscode.StatusBarAlignment.Left
      // Descending priority keeps the entries together in a fixed order.
      it = vscode.window.createStatusBarItem(`tokenPace.${index}`, align, 1000 - index)
      it.command = 'tokenPace.showDashboard'
      this.items[index] = it
    }
    return it
  }

  update(quotas: QuotaState[], agg: Aggregator): void {
    const now = Date.now()
    let idx = 0

    const QUOTA_PART: Record<Source, StatusPart> = { claude: 'claudeQuota', codex: 'codexQuota' }

    for (const q of quotas) {
      if (!this.cfg.show.has(QUOTA_PART[q.source])) continue
      const age = ageMinutes(q.fetchedAt, now)
      const stale = age !== null && age > this.cfg.staleAfterMinutes
      const list = shown(q, this.cfg.windows)

      if (!q.ok || list.length === 0) {
        const it = this.item(idx++)
        it.name = `${TITLE[q.source]} — quota`
        it.text = `${LABEL[q.source]} –`
        it.color = new vscode.ThemeColor('descriptionForeground')
        it.backgroundColor = undefined
        it.tooltip = this.problemTooltip(q)
        it.show()
        continue
      }

      // One entry per window: a status bar item has exactly ONE foreground colour,
      // so several utilisations could not be coloured separately within one entry.
      for (const w of list) {
        const it = this.item(idx++)
        const sev = severity(w.percent, windowElapsed(w.resetsAt, w.windowMinutes, now))
        const bar =
          this.cfg.barWidth > 0 ? ' ' + renderBar(w.percent, this.cfg.barWidth, this.cfg.barStyle) : ''
        const mark = stale ? ' ~' : ''
        it.name = `${TITLE[q.source]} — ${w.label}`
        it.text = `${LABEL[q.source]} ${w.shortLabel}${bar} ${Math.round(w.percent)}%${mark}`

        // Either coloured text OR an alarm background — never both: once
        // backgroundColor is set, the extension host replaces the foreground with
        // statusBarItem.errorForeground and the main thread discards `color`.
        // Reserved for an exhausted window, so it stays a real signal.
        const alarm = sev === 'error' && !stale
        it.backgroundColor = alarm ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined
        it.color = alarm
          ? undefined
          : new vscode.ThemeColor(stale ? 'descriptionForeground' : COLOR[sev])

        it.tooltip = this.quotaTooltip(q, agg, now)
        it.show()
      }
    }

    if (this.cfg.show.has('extra')) {
      for (const q of quotas) {
        const text = extraUsageText(q.extra)
        if (text === null) continue
        const it = this.item(idx++)
        const on = q.extra?.enabled === true
        it.name = `${TITLE[q.source]} — extra usage`
        it.text = `${LABEL[q.source]} extra ${on ? text : '–'}`
        it.color = new vscode.ThemeColor(on ? 'charts.blue' : 'descriptionForeground')
        it.backgroundColor = undefined
        it.tooltip = this.quotaTooltip(q, agg, now)
        it.show()
      }
    }

    const today = lastDays(1)[0]
    if (this.cfg.show.has('tokens')) {
      const it = this.item(idx++)
      const cc = agg.sum(today, today, 'claude')
      const cx = agg.sum(today, today, 'codex')
      it.name = 'Tokens today'
      it.text = `Σ ${compact(billable(cc) + billable(cx))}`
      it.color = undefined
      it.backgroundColor = undefined
      it.tooltip = this.tokenTooltip(agg, now)
      it.show()
    }

    if (this.cfg.show.has('cost')) {
      const it = this.item(idx++)
      const c = agg.cost(today, today, undefined, this.cfg.customPrices)
      it.name = 'API cost today'
      // Same colour as the other figures — a highlight would make a hypothetical
      // number read like an invoice. The caveat lives in the tooltip instead.
      it.text = `${usd(c.usd)}${c.unpricedTokens > 0 ? ' ⚠' : ''}`
      it.color = undefined
      it.backgroundColor = undefined
      it.tooltip = this.tokenTooltip(agg, now)
      it.show()
    }

    // Drop entries left over from an earlier configuration.
    for (let i = idx; i < this.items.length; i++) {
      this.items[i]?.dispose()
      delete this.items[i]
    }
  }

  private md(): vscode.MarkdownString {
    const m = new vscode.MarkdownString()
    m.isTrusted = true
    m.supportThemeIcons = true
    m.supportHtml = true
    return m
  }

  private problemTooltip(q: QuotaState): vscode.MarkdownString {
    const m = this.md()
    m.appendMarkdown(`**${TITLE[q.source]} — quota unavailable**\n\n`)
    m.appendMarkdown(`${q.problem ?? 'Unknown reason'}\n\n`)
    m.appendMarkdown('_See the `tokenPace.quotaSource` setting._\n')
    return m
  }

  private quotaTooltip(q: QuotaState, agg: Aggregator, now: number): vscode.MarkdownString {
    const m = this.md()
    const plan = q.planType ? ` · plan \`${q.planType}\`` : ''
    m.appendMarkdown(`**${TITLE[q.source]}**${plan}\n\n`)

    m.appendMarkdown('| Window | Used | Elapsed | Resets |\n|---|---|---|---|\n')
    for (const w of q.windows) {
      const elapsed = windowElapsed(w.resetsAt, w.windowMinutes, now)
      const sev = severity(w.percent, elapsed)
      const bar = renderBar(w.percent, 10, this.cfg.barStyle)
      // Ahead of the clock means burning faster than the window refills.
      const pace = elapsed === null ? '–' : `${elapsed.toFixed(0)} %${sev === 'warn' ? ' $(arrow-up)' : ''}`
      m.appendMarkdown(
        `| ${w.label} | <span style="color:var(--vscode-${COLOR[sev].replace('.', '-')});">${bar}</span> ` +
          `${w.percent.toFixed(0)} % | ${pace} | ${w.resetsAt ? relativeTime(w.resetsAt, now) : '–'} |\n`,
      )
    }

    const extra = extraUsageText(q.extra)
    if (extra !== null) {
      // Purchased usage is a separate pot — never fold it into the plan windows above.
      m.appendMarkdown(`\nExtra usage: ${q.extra?.enabled ? `**${extra}**` : extra}\n`)
    }

    const age = ageMinutes(q.fetchedAt, now)
    m.appendMarkdown('\n')
    if (age !== null) {
      const txt = age < 1 ? 'just now' : `${Math.round(age)} min ago`
      const from = q.origin === 'poll' ? 'polled' : q.origin === 'cache' ? 'cache file' : null
      const suffix = from ? ` · ${from}` : ''
      m.appendMarkdown(
        age > this.cfg.staleAfterMinutes
          ? `$(warning) Updated ${txt}${suffix} — **stale**\n\n`
          : `Updated ${txt}${suffix}\n\n`,
      )
    }

    this.appendUsageTable(m, agg, q.source, now)
    m.appendMarkdown(
      '\n_“Elapsed” is how much of the window’s own time has passed. Green means usage is at ' +
        'or below it, yellow means usage is ahead of the clock, red means the window is spent._\n\n' +
        '_The percentage comes from the server and covers **all** clients (desktop app and ' +
        'browser included). It cannot be derived from the token counts below._\n',
    )
    return m
  }

  private tokenTooltip(agg: Aggregator, now: number): vscode.MarkdownString {
    const m = this.md()
    m.appendMarkdown('**Tokens today** (fresh input + cache write + output)\n\n')
    this.appendUsageTable(m, agg, 'claude', now)
    m.appendMarkdown('\n')
    this.appendUsageTable(m, agg, 'codex', now)
    m.appendMarkdown('\n_Cache reads are excluded — they dominate the total by a factor of ~1000._\n')
    return m
  }

  private appendUsageTable(m: vscode.MarkdownString, agg: Aggregator, source: Source, now: number): void {
    const days = lastDays(30, now)
    const today = days[days.length - 1]
    const weekStart = days[days.length - 7]
    const d = agg.sum(today, today, source)
    const cost = this.cfg.showCost

    m.appendMarkdown(`**${TITLE[source]}** — tokens\n\n`)
    m.appendMarkdown(
      cost
        ? '| Period | Usage | Output | Cache read | Req. | API cost |\n|---|---|---|---|---|---|\n'
        : '| Period | Usage | Output | Cache read | Req. |\n|---|---|---|---|---|\n',
    )
    const row = (label: string, from: string, to: string) => {
      const b = agg.sum(from, to, source)
      const incomplete = b.requests > 0 && b.outputFinal < b.requests
      const out = compact(b.output) + (incomplete ? ' ⚠' : '')
      let line = `| ${label} | ${compact(billable(b))} | ${out} | ${compact(b.cacheRead)} | ${compact(b.requests)} |`
      if (cost) {
        const c = agg.cost(from, to, source, this.cfg.customPrices)
        line += ` ${usd(c.usd)}${c.unpricedTokens > 0 ? ' ⚠' : ''} |`
      }
      m.appendMarkdown(line + '\n')
    }
    row('today', today, today)
    row('7 days', weekStart, today)
    row('30 days', days[0], today)

    if (d.requests > 0 && d.outputFinal < d.requests) {
      const pct = Math.round((1 - d.outputFinal / d.requests) * 100)
      m.appendMarkdown(
        `\n⚠ ${pct} % of responses have no terminal line — the output figure is a **lower bound**.\n`,
      )
    }
    if (cost) {
      m.appendMarkdown(
        '\n_API cost is hypothetical: what this usage would have cost through the provider’s ' +
          'API at list prices. On a subscription you do **not** pay this._\n',
      )
    }
  }

  dispose(): void {
    for (const it of this.items) it?.dispose()
    this.items = []
  }
}
