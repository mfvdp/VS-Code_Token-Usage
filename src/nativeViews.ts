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
import { toCsv, toJson, toMarkdownSummary, toolsCsv } from './exporter'
import { t } from './i18n'
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
      return `# Token Pace\n\n${t('The usage view could not be built: {0}', String(err))}\n`
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
  // Three whole sentences rather than one built from a stem: what follows "model names"
  // changes the sentence, not just a word at its end.
  if (cfg.attribution === 'none') return t('Includes model names.')
  return cfg.showProjectNames === 'hash'
    ? t('Includes model names and project labels (salted hashes).')
    : t('Includes model names and project labels (directory basenames).')
}

/**
 * A second file written beside the chosen one, for data that cannot live in the first.
 *
 * The tool table is keyed by day and model while a bucket row is keyed by day, hour, model,
 * tier and isSub, so a tool column on a bucket row would be an invented split. It becomes a
 * companion file instead — named in the save dialog before anything is written, because a
 * file the user did not pick must not appear on disk unannounced.
 */
interface Companion {
  /** Replaces the extension of the chosen name, e.g. `.tools.csv`. */
  suffix: string
  text: string
}

/** `…/export.csv` + `.tools.csv` → `…/export.tools.csv`; a name without a dot just gains it. */
function companionPath(path: string, suffix: string): string {
  const cut = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return (cut > slash ? path.slice(0, cut) : path) + suffix
}

async function save(
  text: string,
  name: string,
  filters: Record<string, string[]>,
  notice: string,
  companion?: Companion,
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(name),
    filters,
    saveLabel: t('Export'),
    title: t('Token Pace export — {0}', notice),
  })
  if (!uri) return
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'))
  let second: vscode.Uri | null = null
  if (companion) {
    second = uri.with({ path: companionPath(uri.path, companion.suffix) })
    await vscode.workspace.fs.writeFile(second, Buffer.from(companion.text, 'utf8'))
  }
  // The button is computed once and compared with that same value: a label translated on
  // the way in and re-translated on the way out compares against a string nobody was shown.
  const openLabel = t('Open')
  const open = await vscode.window.showInformationMessage(
    second
      ? t('Token Pace: exported to {0} and {1}', uri.fsPath, second.fsPath)
      : t('Token Pace: exported to {0}', uri.fsPath),
    openLabel,
  )
  if (open === openLabel) await vscode.window.showTextDocument(uri)
}

async function showQuickPick(deps: NativeViewDeps): Promise<void> {
  const vm = deps.getVm()
  const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { command?: string }>()
  pick.title = t('Token Pace — {0}', vm.range.label)
  pick.placeholder = t('Usage, quota windows and key figures (chart and heatmap need the dashboard)')
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
  // The tooltip is both the label and the key the click is looked up under, so it is
  // translated exactly once and the table is built from those same four values.
  const buttons: Array<{ icon: string; tooltip: string; command: string }> = [
    { icon: 'sync', tooltip: t('Fetch quota now'), command: 'tokenPace.refreshQuota' },
    { icon: 'history', tooltip: t('Re-read token history'), command: 'tokenPace.rescan' },
    { icon: 'output', tooltip: t('Show log'), command: 'tokenPace.showOutput' },
    { icon: 'settings-gear', tooltip: t('Open settings'), command: 'tokenPace.openSettings' },
  ]
  pick.buttons = buttons.map((b) => ({ iconPath: new vscode.ThemeIcon(b.icon), tooltip: b.tooltip }))
  const byTooltip: Record<string, string> = {}
  for (const b of buttons) byTooltip[b.tooltip] = b.command
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
        `${exportNotice(cfg)} ${t('Tool names go into a second file beside it (.tools.csv).')}`,
        { suffix: '.tools.csv', text: toolsCsv(agg, range) },
      )
    }),

    vscode.commands.registerCommand('tokenPace.exportJson', async () => {
      const { agg, range, cfg } = deps.getExportInput()
      const tcfg = readTimeConfig(cfg)
      await save(
        toJson(agg, range, cfg, tcfg),
        `token-pace-${range.from}_${range.to}-${timestamp()}.json`,
        { JSON: ['json'] },
        // The CSV path names the tool file; this one has to name the array, for the same
        // reason: `tools[]` carries the names as the transcript spells them, MCP names
        // included, and the dialog is the last moment to say no to that leaving the machine.
        `${exportNotice(cfg)} ${t('Tool names are included as tools[].')}`,
      )
    }),

    vscode.commands.registerCommand('tokenPace.copySummary', async () => {
      await vscode.env.clipboard.writeText(toMarkdownSummary(deps.getVm()))
      void vscode.window.showInformationMessage(
        t('Token Pace: usage summary copied as markdown (model names included).'),
      )
    }),
  )

  return {
    refreshMarkdown(): void {
      provider.refresh(uri)
    },
  }
}
