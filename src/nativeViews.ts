// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The views and commands that need vscode: the QuickPick, the read-only markdown document
 * and the three export commands.
 *
 * All the rendering lives in `textViews.ts` and `exporter.ts`, which are pure and tested;
 * this file only wires them to commands, a content provider and the save dialog. The dialog
 * names what leaves the machine before the file exists — model names always, project labels
 * when attribution is on — because that is the last moment the user can say no.
 */

import * as vscode from 'vscode'
import { Aggregator } from './agg'
import { Config, readTimeConfig } from './config'
import { toCsv, toJson, toMarkdownSummary } from './exporter'
import { markdownDocument, quickPickItems } from './textViews'
import { DayRange } from './time'
import type { ViewModel } from './viewModel'

export const MARKDOWN_SCHEME = 'tokenpace'
export const MARKDOWN_URI = `${MARKDOWN_SCHEME}:/usage.md`

export interface NativeViewDeps {
  getVm: () => ViewModel
  /** Runs one of our own commands; the QuickPick never executes anything else. */
  run: (command: string, ...args: unknown[]) => Thenable<unknown>
  getExportInput: () => { agg: Aggregator; range: DayRange; cfg: Config }
}

export interface NativeViews {
  /** Tells the open markdown document that the view model changed. */
  refreshMarkdown(): void
}

class UsageDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.emitter.event

  constructor(private readonly getVm: () => ViewModel) {}

  provideTextDocumentContent(): string {
    try {
      return markdownDocument(this.getVm())
    } catch (err) {
      // A view that throws would leave an empty editor with no explanation.
      return `# Token Pace\n\nThe usage view could not be built: ${String(err)}\n`
    }
  }

  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri)
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

function timestamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

/** What the save dialog has to say out loud before anything is written. */
function exportNotice(cfg: Config): string {
  const base = 'Includes model names'
  return cfg.attribution === 'none'
    ? `${base}.`
    : `${base} and project labels (${cfg.showProjectNames === 'hash' ? 'salted hashes' : 'directory basenames'}).`
}

async function save(text: string, name: string, filters: Record<string, string[]>, notice: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(name),
    filters,
    saveLabel: 'Export',
    title: `Token Pace export — ${notice}`,
  })
  if (!uri) return
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'))
  const open = await vscode.window.showInformationMessage(`Token Pace: exported to ${uri.fsPath}`, 'Open')
  if (open === 'Open') await vscode.window.showTextDocument(uri)
}

async function showQuickPick(deps: NativeViewDeps): Promise<void> {
  const vm = deps.getVm()
  const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { command?: string }>()
  pick.title = `Token Pace — ${vm.range.label}`
  pick.placeholder = 'Usage, quota windows and key figures (chart and heatmap need the dashboard)'
  pick.matchOnDescription = true
  pick.matchOnDetail = true
  // A `separator: true` item is a heading, not a row: it carries no command and the
  // QuickPick refuses to select it. Read defensively so an older `quickPickItems`
  // that does not set the flag still renders exactly as before.
  pick.items = quickPickItems(vm).map((i) => {
    const item = i as typeof i & { separator?: boolean }
    if (item.separator === true) {
      return { label: item.label, kind: vscode.QuickPickItemKind.Separator }
    }
    return {
      label: i.label,
      description: i.description,
      detail: i.detail,
      command: i.command,
    }
  })
  pick.buttons = [
    { iconPath: new vscode.ThemeIcon('sync'), tooltip: 'Fetch quota now' },
    { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Re-read token history' },
    { iconPath: new vscode.ThemeIcon('output'), tooltip: 'Show log' },
    { iconPath: new vscode.ThemeIcon('settings-gear'), tooltip: 'Open settings' },
  ]
  const byTooltip: Record<string, string> = {
    'Fetch quota now': 'tokenPace.refreshQuota',
    'Re-read token history': 'tokenPace.rescan',
    'Show log': 'tokenPace.showOutput',
    'Open settings': 'tokenPace.openSettings',
  }
  pick.onDidTriggerButton((b) => {
    const command = byTooltip[String(b.tooltip ?? '')]
    if (command) void deps.run(command)
  })
  pick.onDidAccept(() => {
    const item = pick.selectedItems[0]
    pick.hide()
    if (item?.command) void deps.run(item.command)
  })
  pick.onDidHide(() => pick.dispose())
  pick.show()
}

export function registerNativeViews(
  context: vscode.ExtensionContext,
  deps: NativeViewDeps,
): NativeViews {
  const provider = new UsageDocumentProvider(deps.getVm)
  const uri = vscode.Uri.parse(MARKDOWN_URI)
  context.subscriptions.push(
    provider,
    vscode.workspace.registerTextDocumentContentProvider(MARKDOWN_SCHEME, provider),

    vscode.commands.registerCommand('tokenPace.showUsageQuickPick', () => showQuickPick(deps)),

    vscode.commands.registerCommand('tokenPace.showUsageMarkdown', async () => {
      provider.refresh(uri)
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown')
      await vscode.window.showTextDocument(doc, { preview: false })
    }),

    vscode.commands.registerCommand('tokenPace.exportCsv', async () => {
      const { agg, range, cfg } = deps.getExportInput()
      const tcfg = readTimeConfig(cfg)
      await save(
        toCsv(agg, range, cfg, tcfg),
        `token-pace-${range.from}_${range.to}-${timestamp()}.csv`,
        { CSV: ['csv'] },
        exportNotice(cfg),
      )
    }),

    vscode.commands.registerCommand('tokenPace.exportJson', async () => {
      const { agg, range, cfg } = deps.getExportInput()
      const tcfg = readTimeConfig(cfg)
      await save(
        toJson(agg, range, cfg, tcfg),
        `token-pace-${range.from}_${range.to}-${timestamp()}.json`,
        { JSON: ['json'] },
        exportNotice(cfg),
      )
    }),

    vscode.commands.registerCommand('tokenPace.copySummary', async () => {
      await vscode.env.clipboard.writeText(toMarkdownSummary(deps.getVm()))
      void vscode.window.showInformationMessage(
        'Token Pace: usage summary copied as markdown (model names included).',
      )
    }),
  )

  return {
    refreshMarkdown(): void {
      provider.refresh(uri)
    },
  }
}
