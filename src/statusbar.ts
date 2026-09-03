// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The vscode half of the status bar: it owns `StatusBarItem` objects and nothing else.
 *
 * Every decision about text, colour, tooltip and click target is made in `statusText.ts`,
 * which is pure and tested; this file maps the resulting models onto items, keyed by their
 * stable ids. That split is deliberate — VS Code remembers per-id visibility, so the id is
 * part of the contract with the user, and the wording is part of the contract with the docs.
 */

import * as vscode from 'vscode'
import { Aggregator } from './agg'
import { Config } from './config'
import {
  ALARM_BACKGROUND, buildItems, ConsentState, ItemModel, previewItems, Role, StatusTextInput,
} from './statusText'
import { QuotaState } from './types'

export interface StatusInput extends StatusTextInput {
  agg: Aggregator
}

export type { Role, ConsentState }

/** How long a preview stays on screen before it removes itself. */
const PREVIEW_MS = 60_000

/**
 * The commands a tooltip may link. `isTrusted: true` would enable every command in the
 * workbench, including ones that take arguments from the link — this list is the whole set
 * of our own argument-less commands and nothing else.
 */
const TOOLTIP_COMMANDS = [
  'tokenPace.refreshQuota',
  'tokenPace.rescan',
  'tokenPace.showOutput',
  'tokenPace.openSettings',
  'tokenPace.showDashboard',
]

function markdown(src: string): vscode.MarkdownString {
  const m = new vscode.MarkdownString(src)
  m.isTrusted = { enabledCommands: TOOLTIP_COMMANDS }
  m.supportThemeIcons = true
  m.supportHtml = true
  return m
}

/** One live item plus the two properties that can only be set when it is created. */
interface Entry {
  item: vscode.StatusBarItem
  alignment: vscode.StatusBarAlignment
  priority: number
}

export class StatusBar implements vscode.Disposable {
  private live = new Map<string, Entry>()
  private preview_ = new Map<string, Entry>()
  private previewTimer: ReturnType<typeof setTimeout> | null = null

  update(input: StatusInput): void {
    this.render(this.live, buildItems(input), alignmentOf(input.cfg))
  }

  /**
   * Renders synthetic states into a separate `tokenPace.preview.*` id space.
   *
   * Calling it again while a preview runs ends it, so the one command can toggle. The
   * preview never touches the live items and never reads or writes a file.
   */
  preview(cfg: Config): void {
    if (this.previewTimer !== null) {
      this.endPreview()
      return
    }
    this.render(this.preview_, previewItems(cfg, Date.now()), alignmentOf(cfg))
    this.previewTimer = setTimeout(() => this.endPreview(), PREVIEW_MS)
  }

  /**
   * Whether synthetic preview items are on screen.
   *
   * The dashboard has to say so out loud: preview data and real state must never look alike.
   */
  previewActive(): boolean {
    return this.previewTimer !== null
  }

  endPreview(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer)
      this.previewTimer = null
    }
    for (const e of this.preview_.values()) e.item.dispose()
    this.preview_.clear()
  }

  private render(map: Map<string, Entry>, models: ItemModel[], alignment: vscode.StatusBarAlignment): void {
    const seen = new Set<string>()
    for (const m of models) {
      seen.add(m.id)
      const priority = Number(m.priorityKey)
      let entry = map.get(m.id)
      // Alignment and priority are fixed at creation time, so a reordered `statusBar.show`
      // (or a flipped `alignment`) has to build the item again rather than lie about its place.
      if (entry && (entry.alignment !== alignment || entry.priority !== priority)) {
        entry.item.dispose()
        map.delete(m.id)
        entry = undefined
      }
      if (!entry) {
        entry = { item: vscode.window.createStatusBarItem(m.id, alignment, priority), alignment, priority }
        map.set(m.id, entry)
      }
      const it = entry.item
      it.name = m.name
      it.text = m.text
      it.tooltip = m.tooltipMarkdown === '' ? undefined : markdown(m.tooltipMarkdown)
      // Either an alarm background or a coloured foreground, never both: once a background
      // is set the workbench replaces the foreground and discards `color` silently.
      it.backgroundColor = m.alarm ? new vscode.ThemeColor(ALARM_BACKGROUND) : undefined
      it.color = m.alarm || m.colorId === null ? undefined : new vscode.ThemeColor(m.colorId)
      it.command = commandOf(m)
      it.show()
    }
    for (const [id, entry] of [...map]) {
      if (seen.has(id)) continue
      entry.item.dispose()
      map.delete(id)
    }
  }

  dispose(): void {
    this.endPreview()
    for (const e of this.live.values()) e.item.dispose()
    this.live.clear()
  }
}

function alignmentOf(cfg: Config): vscode.StatusBarAlignment {
  return cfg.alignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left
}

function commandOf(m: ItemModel): string | vscode.Command | undefined {
  if (m.command === null) return undefined
  if (!m.commandArgs || m.commandArgs.length === 0) return m.command
  return { command: m.command, title: m.name, arguments: [...m.commandArgs] }
}

// ---------------------------------------------------------------------------
// The QuickPick menu (tokenPace.clickAction: menu)
// ---------------------------------------------------------------------------

interface MenuItem extends vscode.QuickPickItem {
  command?: string
  args?: unknown[]
}

const SOURCE_TITLE: Record<'claude' | 'codex', string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * The menu behind a click. Every entry is one of this extension's own commands; `run` does
 * the executing, so the menu itself stays testable and free of side effects.
 *
 * A fetch that the current state cannot perform stays in the list and says why: hiding it
 * would leave the user wondering where it went.
 */
export async function showMenu(
  input: { role: Role; consent: ConsentState; cfg: Config; quotas: QuotaState[] },
  run: (command: string, ...args: unknown[]) => Thenable<unknown>,
): Promise<void> {
  const blocked = input.cfg.quotaSource === 'cache'
    ? 'disabled: tokenPace.quotaSource is “cache” — nothing is fetched over the network'
    : input.consent === 'denied'
      ? 'disabled: network consent was declined (Token Pace: Reset Network Access Decision asks again)'
      : input.role === 'follower'
        ? 'disabled: another VS Code window holds the lease and polls'
        : undefined

  const sources = input.quotas.length > 0
    ? [...new Set(input.quotas.map((q) => q.source))]
    : (['claude', 'codex'] as const).slice()

  const items: MenuItem[] = [
    { label: '$(dashboard) Open Dashboard', command: 'tokenPace.showDashboard' },
    { label: '$(list-selection) Show Usage (Quick Pick)', command: 'tokenPace.showUsageQuickPick' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `${blocked ? '$(circle-slash)' : '$(sync)'} Fetch Quota Now`,
      detail: blocked,
      command: 'tokenPace.refreshQuota',
    },
    { label: '$(history) Re-read History', command: 'tokenPace.rescan' },
    {
      label: '$(list-ordered) Cycle Status Bar Windows',
      description: input.cfg.windowSelect,
      command: 'tokenPace.cycleWindowSelect',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    ...sources.map((s): MenuItem => ({
      label: `$(link-external) Open Official Usage Page — ${SOURCE_TITLE[s]}`,
      command: 'tokenPace.openUsagePage',
      args: [s],
    })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(desktop-download) Export CSV…', command: 'tokenPace.exportCsv' },
    { label: '$(clippy) Copy Usage Summary', command: 'tokenPace.copySummary' },
    { label: '$(bug) Copy Diagnostics', command: 'tokenPace.copyDiagnostics' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(eye) Preview Status Bar States', command: 'tokenPace.previewStatusBar' },
    { label: '$(output) Show Log', command: 'tokenPace.showOutput' },
    { label: '$(settings-gear) Settings', command: 'tokenPace.openSettings' },
    { label: '$(trash) Clear Stored Data…', command: 'tokenPace.clearStoredData' },
  ]

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Token Pace',
    placeHolder: 'Pick an action',
    matchOnDetail: true,
  })
  if (!picked || !picked.command) return
  await run(picked.command, ...(picked.args ?? []))
}
