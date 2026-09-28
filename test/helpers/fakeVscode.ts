// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for the `vscode` module, small enough to read in one sitting and large
 * enough to run `activate()`.
 *
 * The extension bundle marks `vscode` external, so the module is never resolved until
 * something requires it. `installVscodeStub` puts a fake in front of that resolution;
 * a test then requires `../src/extension` lazily and gets a real activation against a
 * recorded host — status bar items, commands, settings, notifications and clipboard
 * writes all land in `FakeVscodeState`, where they can be asserted on.
 *
 * Everything here records rather than acts: no file outside the caller's own temporary
 * directories is touched, no process is started and no network call can be made.
 */

import * as path from 'path'

export interface LogLine {
  level: 'info' | 'warn' | 'error' | 'debug' | 'trace'
  message: string
}

export interface FakeStatusBarItem {
  id: string
  alignment: number
  priority: number
  name?: string
  text: string
  tooltip?: unknown
  color?: unknown
  backgroundColor?: unknown
  command?: unknown
  visible: boolean
  disposed: boolean
  show(): void
  hide(): void
  dispose(): void
}

export interface FakeMemento {
  get<T>(key: string, def?: T): T | undefined
  update(key: string, value: unknown): Promise<void>
  keys(): readonly string[]
  setKeysForSync(keys: readonly string[]): void
}

export interface RecordedMessage {
  kind: 'info' | 'warning' | 'error'
  text: string
  actions: string[]
  /** 1.10 P4: the message's options where it had some — `modal` and `detail` of a modal dialog. */
  options?: Record<string, unknown>
}

/**
 * 1.13 A3 rule 8: one text VS Code would draw on a status bar item — every assignment of `text`, `tooltip`, `name` and
 * `accessibilityInformation`, in order, of every item (the bar's, the keep-warm countdown's, the scan's), so that a
 * test reads what each owner handed over and not only what an item shows at the end.
 */
export interface RecordedItemSet {
  id: string
  field: 'text' | 'tooltip' | 'name' | 'accessibilityInformation'
  value: unknown
}

/** 1.13 A3 rule 8: one `withProgress` call — its options and every message reported to it. */
export interface RecordedProgress {
  options: Record<string, unknown>
  reported: unknown[]
}

/** At most this many item assignments are kept (the oldest go first): an activation renders many times a second. */
export const MAX_ITEM_SETS = 20_000

/** One `showQuickPick` call: what it offered, so a test can assert the list itself. */
export interface RecordedQuickPick {
  items: Array<Record<string, unknown>>
  options: Record<string, unknown>
}

/**
 * 1.8 B2 (P10): a terminal of the fake window. Its `name` records every read — Claude Code sets a
 * terminal's name to a summary of the conversation, and Token Pace never reads it (§7c) — and so does
 * the output of an execution (`read()`); `sendText` records every call in `FakeVscodeState.sent`.
 * 1.10 P2 (§0a.3): the folder the shell integration reports (`shellIntegration.cwd`, set by `openTerminal`'s
 * `cwd`), and a count of every read of `creationOptions` and `processId`, which Token Pace never reads.
 * 1.10 P4: `show` records every call in `FakeVscodeState.shown`; a terminal made with `refuse` throws from
 * `sendText`, as a terminal VS Code no longer takes text for would.
 */
export interface FakeTerminal {
  readonly name: string
  readonly state: { isInteractedWith: boolean; shell: string | undefined }
  readonly shellIntegration: { cwd: { fsPath: string; scheme: string; path: string } | undefined } | undefined
  readonly creationOptions: Record<string, unknown>
  readonly processId: Promise<number | undefined>
  readonly exitStatus: undefined
  sendText(text: string, shouldExecute?: boolean): void
  show(preserveFocus?: boolean): void
  hide(): void
  dispose(): void
  /** The fake's own handle on the state above, for a test to set what VS Code would report. */
  setShell(shell: string | undefined): void
}

/** 1.8 B2 (P10): one shell execution of a fake terminal, as `onDidStartTerminalShellExecution` hands it out. */
export interface FakeExecution {
  readonly commandLine: { value: string; confidence: number; isTrusted: boolean }
  readonly cwd: { fsPath: string; scheme: string; path: string } | undefined
  read(): AsyncIterable<string>
}

/** A `createQuickPick()` control, kept so a test can read the items it was filled with. */
export interface FakeQuickPick {
  title: string
  placeholder: string
  items: Array<Record<string, unknown>>
  buttons: unknown[]
  selectedItems: unknown[]
  shown: boolean
}

export interface FakeVscodeState {
  /** Every line the extension's output channel received, newest last. */
  log: LogLine[]
  /** Command id → number of registrations. A second registration is a bug, not an overwrite. */
  registered: Map<string, number>
  /** Command ids passed to `executeCommand`, in order. */
  executed: string[]
  /** The same calls with their arguments — for a command whose payload is the point. */
  executedArgs: Array<{ id: string; args: unknown[] }>
  /** Every status bar item ever created, disposed ones included. */
  items: FakeStatusBarItem[]
  /** 1.13 A3 rule 8: every text, tooltip, name and accessible name set on an item, in order (at most MAX_ITEM_SETS). */
  itemSets: RecordedItemSet[]
  /** 1.13 A3 rule 8: every `withProgress` call, in order. */
  progress: RecordedProgress[]
  clipboard: string[]
  messages: RecordedMessage[]
  quickPicks: RecordedQuickPick[]
  /** Every `createQuickPick()` control, in creation order. */
  quickPickControls: FakeQuickPick[]
  documents: Array<{ uri: string; text: string }>
  /** The options of every `showSaveDialog` call — what the dialog said before anything was written. */
  saveDialogs: Array<Record<string, unknown>>
  /** 1.12 P9: the options of every `showInputBox` call, in order. */
  inputBoxes: Array<Record<string, unknown>>
  /**
   * Every `workspace.fs.writeFile`, in order: the path and the text. Recorded in memory only —
   * nothing is written to disk from a test.
   */
  writes: Array<{ path: string; text: string }>
  /**
   * Answers `showQuickPick` / `showInformationMessage` hand out, oldest first. 1.10 P4: an answer that is a
   * function is called with the items a `showQuickPick` offers, and its result is the pick.
   */
  answers: unknown[]
  settings: Map<string, unknown>
  webviewProviders: Map<string, unknown>
  contentProviders: Map<string, { provideTextDocumentContent(uri: unknown): string }>

  /** Items that are on screen right now, in creation order. */
  live(prefix?: string): FakeStatusBarItem[]
  /** The text of one live item, or undefined when it is not on screen. */
  textOf(id: string): string | undefined
  /** Runs a registered command exactly as `vscode.commands.executeCommand` would. */
  execute(id: string, ...args: unknown[]): Promise<unknown>
  logText(): string
  set(key: string, value: unknown): void
  /** `vscode.env.remoteName` — undefined is a local window, a string is WSL/SSH/container. */
  setRemoteName(name: string | undefined): void
  /**
   * `vscode.env.language` and `vscode.l10n.bundle` — what `activate()` hands to the i18n
   * seam. 'en' and no bundle unless a test says otherwise; `reset()` puts that back.
   */
  setLanguage(language: string, bundle?: Record<string, string>): void
  /**
   * Clears every recording and replaces the settings.
   *
   * A bundle evaluates `require('vscode')` once and keeps the object, so one process can
   * only ever have one fake host — a second activation has to reuse this one, and reuse
   * without a reset would count the first activation's commands twice.
   */
  reset(settings?: Record<string, unknown>): void
  /** Fires `onDidChangeConfiguration` for the given full keys. */
  fireConfigChange(keys: string[]): void
  /** Fires `onDidChangeWindowState` — and sets `window.state` to it, as VS Code does. */
  fireWindowState(focused: boolean): void
  /** 1.8 B2: every terminal of the window (`window.terminals`), in the order they opened. */
  terminals: FakeTerminal[]
  /** 1.8 B2: every `sendText` call, in order — the spy of §3 B2 test 8. */
  sent: Array<{ terminal: FakeTerminal; text: string; execute: boolean | undefined }>
  /** 1.10 P4: every terminal `show` call, in order — `preserveFocus` as it was passed. */
  shown: Array<{ terminal: FakeTerminal; preserveFocus: boolean | undefined }>
  /**
   * 1.10 P4: `vscode.workspace.isTrusted` — true unless a test says otherwise; `true` after `false` fires
   * `onDidGrantWorkspaceTrust`, as VS Code does when the reader trusts the workspace. `reset()` trusts it.
   */
  setTrusted(trusted: boolean): void
  /** 1.8 B2: how often a terminal's `name` was read (must stay 0), and an execution's output (`read()`). */
  nameReads: number
  outputReads: number
  /** 1.10 P2: how often a terminal's `creationOptions` or `processId` was read (must stay 0). */
  creationReads: number
  /**
   * 1.8 B2: opens a terminal (fires `onDidOpenTerminal`-free: VS Code's list simply holds it). 1.10 P2:
   * `cwd` — the folder the shell integration reports for it; `integration: false` — a terminal without
   * shell integration (`shellIntegration` undefined).
   */
  openTerminal(o?: { shell?: string; name?: string; cwd?: string | null; integration?: boolean; refuse?: boolean }): FakeTerminal
  /** 1.8 B2: fires `onDidStartTerminalShellExecution` for a command in a terminal; the execution stays open. */
  startExecution(terminal: FakeTerminal, o: { commandLine: string; confidence?: number; cwd?: string | null }): FakeExecution
  /** 1.8 B2: fires `onDidEndTerminalShellExecution`. */
  endExecution(terminal: FakeTerminal, execution: FakeExecution): void
  /** 1.8 B2: closes a terminal — it leaves `window.terminals`, and `onDidCloseTerminal` fires. */
  closeTerminal(terminal: FakeTerminal): void
  /** 1.8 B2: makes a terminal the active one (`window.activeTerminal`) and fires `onDidChangeActiveTerminal`. */
  setActiveTerminal(terminal: FakeTerminal | undefined): void
  /** 1.8 B2: how many listeners each terminal event has — a host that may not act subscribes to none. */
  terminalListeners(): number
}

class FakeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = []

  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener)
    return {
      dispose: (): void => {
        const at = this.listeners.indexOf(listener)
        if (at >= 0) this.listeners.splice(at, 1)
      },
    }
  }

  fire(e: T): void {
    for (const l of [...this.listeners]) l(e)
  }

  dispose(): void {
    this.listeners.length = 0
  }
}

class FakeUri {
  constructor(readonly scheme: string, readonly path: string, readonly fsPath: string) {}

  static parse(value: string): FakeUri {
    const at = value.indexOf(':')
    if (at < 0) return new FakeUri('file', value, value)
    const rest = value.slice(at + 1)
    return new FakeUri(value.slice(0, at), rest, rest)
  }

  static file(p: string): FakeUri {
    return new FakeUri('file', p, p)
  }

  static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
    const joined = [base.path, ...parts].join('/')
    return new FakeUri(base.scheme, joined, joined)
  }

  /** A copy with another path, as `vscode.Uri.with({ path })` makes one; the file path follows it. */
  with(change: { path?: string }): FakeUri {
    const next = change.path ?? this.path
    return new FakeUri(this.scheme, next, next)
  }

  toString(): string {
    return `${this.scheme}:${this.path}`
  }
}

class FakeThemeColor {
  constructor(readonly id: string) {}
}

class FakeThemeIcon {
  constructor(readonly id: string) {}
}

class FakeMarkdownString {
  isTrusted: unknown = false
  supportThemeIcons = false
  supportHtml = false
  constructor(public value = '') {}
}

function memento(store = new Map<string, unknown>()): FakeMemento {
  return {
    get<T>(key: string, def?: T): T | undefined {
      return store.has(key) ? (store.get(key) as T) : def
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) store.delete(key)
      else store.set(key, value)
      return Promise.resolve()
    },
    keys(): readonly string[] {
      return [...store.keys()]
    },
    setKeysForSync(): void {
      /* nothing is synced in a test */
    },
  }
}

/**
 * A fake `vscode` module plus the recording behind it.
 *
 * `settings` are full keys (`tokenPace.claudeDir`), exactly as `readConfig` asks for them.
 */
export function createFakeVscode(settings: Record<string, unknown> = {}): {
  api: unknown
  state: FakeVscodeState
} {
  const log: LogLine[] = []
  const registered = new Map<string, number>()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const executed: string[] = []
  const executedArgs: Array<{ id: string; args: unknown[] }> = []
  const items: FakeStatusBarItem[] = []
  const itemSets: RecordedItemSet[] = []
  const progress: RecordedProgress[] = []
  const clipboard: string[] = []
  const messages: RecordedMessage[] = []
  const quickPicks: RecordedQuickPick[] = []
  const quickPickControls: FakeQuickPick[] = []
  const documents: Array<{ uri: string; text: string }> = []
  const saveDialogs: Array<Record<string, unknown>> = []
  const inputBoxes: Array<Record<string, unknown>> = []
  const writes: Array<{ path: string; text: string }> = []
  const answers: unknown[] = []
  const values = new Map<string, unknown>(Object.entries(settings))
  const webviewProviders = new Map<string, unknown>()
  const contentProviders = new Map<string, { provideTextDocumentContent(uri: unknown): string }>()
  const configListeners: Array<(e: { affectsConfiguration(section: string): boolean }) => void> = []
  const windowStateListeners: Array<(e: { focused: boolean; active: boolean }) => void> = []
  // 1.8 B2 (P10): the window's terminals, its active terminal, its focus and the four terminal events.
  const terminals: FakeTerminal[] = []
  const sent: Array<{ terminal: FakeTerminal; text: string; execute: boolean | undefined }> = []
  const shown: Array<{ terminal: FakeTerminal; preserveFocus: boolean | undefined }> = []
  const trustListeners: Array<(e: void) => void> = []
  let trusted = true
  const startListeners: Array<(e: { terminal: FakeTerminal; execution: FakeExecution; shellIntegration: unknown }) => void> = []
  const endListeners: Array<(e: { terminal: FakeTerminal; execution: FakeExecution; shellIntegration: unknown; exitCode: number | undefined }) => void> = []
  const closeListeners: Array<(t: FakeTerminal) => void> = []
  const activeListeners: Array<(t: FakeTerminal | undefined) => void> = []
  let activeTerminal: FakeTerminal | undefined
  const windowState = { focused: true, active: true }
  const reads = { name: 0, output: 0, creation: 0 }
  let language = 'en'
  let l10nBundle: Record<string, string> | undefined

  const disposable = (dispose: () => void = () => { /* nothing to release */ }): { dispose(): void } =>
    ({ dispose })

  /**
   * 1.7 D-D: a subscription to one of the host's events, released as VS Code releases it — the
   * listener leaves its list, so an activation that has disposed its subscriptions hears no
   * further event. Until 1.7 both events below returned the no-op above, and a disposed
   * activation kept receiving every `fireConfigChange` and `fireWindowState` of the test.
   */
  function subscribe<T>(list: Array<(e: T) => void>, listener: (e: T) => void): { dispose(): void } {
    list.push(listener)
    return disposable(() => {
      const at = list.indexOf(listener)
      if (at >= 0) list.splice(at, 1)
    })
  }

  function nextAnswer(): unknown {
    return answers.length > 0 ? answers.shift() : undefined
  }

  function record(kind: RecordedMessage['kind'], text: string, actions: unknown[]): Promise<unknown> {
    const options = actions.find((a): a is Record<string, unknown> => typeof a === 'object' && a !== null && !Array.isArray(a))
    messages.push({ kind, text, actions: actions.filter((a): a is string => typeof a === 'string'), ...(options ? { options } : {}) })
    return Promise.resolve(nextAnswer())
  }

  const channel = {
    name: 'Token Pace',
    logLevel: 0,
    onDidChangeLogLevel: new FakeEventEmitter<number>().event,
    info: (m: string): void => { log.push({ level: 'info', message: m }) },
    warn: (m: string): void => { log.push({ level: 'warn', message: m }) },
    error: (m: string): void => { log.push({ level: 'error', message: m }) },
    debug: (m: string): void => { log.push({ level: 'debug', message: m }) },
    trace: (m: string): void => { log.push({ level: 'trace', message: m }) },
    append: (m: string): void => { log.push({ level: 'info', message: m }) },
    appendLine: (m: string): void => { log.push({ level: 'info', message: m }) },
    replace: (): void => { log.length = 0 },
    clear: (): void => { log.length = 0 },
    show: (): void => { /* no view to reveal */ },
    hide: (): void => { /* no view to hide */ },
    dispose: (): void => { /* the array outlives the channel on purpose */ },
  }

  function createStatusBarItem(id: string, alignment: number, priority: number): FakeStatusBarItem {
    const item: FakeStatusBarItem = {
      id,
      alignment,
      priority,
      text: '',
      visible: false,
      disposed: false,
      show(): void { this.visible = true },
      hide(): void { this.visible = false },
      dispose(): void { this.visible = false; this.disposed = true },
    }
    // 1.13 A3 rule 8: the four fields a test reads as VS Code would draw them, each assignment recorded (itemSets).
    const fields: Record<RecordedItemSet['field'], unknown> = { text: '', tooltip: undefined, name: undefined, accessibilityInformation: undefined }
    for (const field of Object.keys(fields) as Array<RecordedItemSet['field']>) {
      Object.defineProperty(item, field, {
        enumerable: true,
        configurable: true,
        get: () => fields[field],
        set: (value: unknown) => {
          fields[field] = value
          itemSets.push({ id, field, value })
          if (itemSets.length > MAX_ITEM_SETS) itemSets.splice(0, itemSets.length - MAX_ITEM_SETS)
        },
      })
    }
    items.push(item)
    return item
  }

  function configuration(section?: string): unknown {
    const full = (key: string): string => (section ? `${section}.${key}` : key)
    return {
      get<T>(key: string, def?: T): T | undefined {
        const k = full(key)
        return values.has(k) ? (values.get(k) as T) : def
      },
      has(key: string): boolean {
        return values.has(full(key))
      },
      inspect<T>(key: string): { key: string; globalValue: T } | undefined {
        // Every value in this host is a "user" value, so a key that was set reports itself as
        // the user's own (globalValue); a key that was never set reports nothing, which is what
        // the diagnostics report reads as "default".
        const k = full(key)
        return values.has(k) ? { key: k, globalValue: values.get(k) as T } : undefined
      },
      update(key: string, value: unknown): Promise<void> {
        values.set(full(key), value)
        state.fireConfigChange([full(key)])
        return Promise.resolve()
      },
    }
  }

  const api = {
    version: '1.99.0-test',

    Uri: FakeUri,
    ThemeColor: FakeThemeColor,
    ThemeIcon: FakeThemeIcon,
    MarkdownString: FakeMarkdownString,
    EventEmitter: FakeEventEmitter,
    Disposable: class {
      constructor(private readonly cb: () => void) {}
      dispose(): void { this.cb() }
    },

    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    // 1.10 Review 2 F1: the values of `@types/vscode`; the fake context runs in Development (2).
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    // 1.8 B2 (P10): the values of `@types/vscode` 1.106.1.
    TerminalShellExecutionCommandLineConfidence: { Low: 0, Medium: 1, High: 2 },

    extensions: {
      getExtension: (): { id: string; extensionKind: number } =>
        ({ id: 'frederik.token-pace', extensionKind: 1 }),
    },

    commands: {
      registerCommand(id: string, fn: (...args: unknown[]) => unknown): { dispose(): void } {
        registered.set(id, (registered.get(id) ?? 0) + 1)
        handlers.set(id, fn)
        return disposable(() => handlers.delete(id))
      },
      executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
        executed.push(id)
        executedArgs.push({ id, args })
        const fn = handlers.get(id)
        // An unknown id is a workbench command (openSettings, view focus): a no-op here.
        if (!fn) return Promise.resolve(undefined)
        try {
          return Promise.resolve(fn(...args))
        } catch (err) {
          return Promise.reject(err)
        }
      },
    },

    env: {
      remoteName: undefined as string | undefined,
      get language(): string { return language },
      appName: 'Token Pace Test Host',
      clipboard: {
        writeText(text: string): Promise<void> {
          clipboard.push(text)
          return Promise.resolve()
        },
        readText(): Promise<string> {
          return Promise.resolve(clipboard[clipboard.length - 1] ?? '')
        },
      },
      openExternal(): Promise<boolean> {
        // Nothing may leave the machine from a test; the call is only recorded as executed.
        return Promise.resolve(true)
      },
    },

    window: {
      createOutputChannel: (): typeof channel => channel,
      createStatusBarItem,
      createQuickPick: () => {
        const control = {
          title: '', placeholder: '', matchOnDescription: false, matchOnDetail: false,
          items: [] as Array<Record<string, unknown>>, buttons: [] as unknown[],
          selectedItems: [] as unknown[], shown: false,
          onDidTriggerButton: () => disposable(),
          onDidAccept: () => disposable(),
          onDidHide: () => disposable(),
          show(): void { this.shown = true },
          hide: () => { /* nothing to hide */ },
          dispose: () => { /* nothing to release */ },
        }
        quickPickControls.push(control)
        return control
      },
      registerWebviewViewProvider(viewType: string, provider: unknown): { dispose(): void } {
        webviewProviders.set(viewType, provider)
        return disposable(() => webviewProviders.delete(viewType))
      },
      onDidChangeWindowState(listener: (e: { focused: boolean; active: boolean }) => void): { dispose(): void } {
        return subscribe(windowStateListeners, listener)
      },
      // 1.8 B2 (P10): the terminal side of the window — the list, the active one, the focus, four events.
      get terminals(): readonly FakeTerminal[] { return [...terminals] },
      get activeTerminal(): FakeTerminal | undefined { return activeTerminal },
      get state(): { focused: boolean; active: boolean } { return { ...windowState } },
      onDidStartTerminalShellExecution(listener: (e: { terminal: FakeTerminal; execution: FakeExecution; shellIntegration: unknown }) => void): { dispose(): void } {
        return subscribe(startListeners, listener)
      },
      onDidEndTerminalShellExecution(listener: (e: { terminal: FakeTerminal; execution: FakeExecution; shellIntegration: unknown; exitCode: number | undefined }) => void): { dispose(): void } {
        return subscribe(endListeners, listener)
      },
      onDidCloseTerminal(listener: (t: FakeTerminal) => void): { dispose(): void } {
        return subscribe(closeListeners, listener)
      },
      onDidChangeActiveTerminal(listener: (t: FakeTerminal | undefined) => void): { dispose(): void } {
        return subscribe(activeListeners, listener)
      },
      showInformationMessage: (text: string, ...rest: unknown[]): Promise<unknown> =>
        record('info', text, rest),
      showWarningMessage: (text: string, ...rest: unknown[]): Promise<unknown> =>
        record('warning', text, rest),
      showErrorMessage: (text: string, ...rest: unknown[]): Promise<unknown> =>
        record('error', text, rest),
      showQuickPick: (items: unknown, options: unknown): Promise<unknown> => {
        const offered = Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []
        quickPicks.push({ items: offered, options: (options ?? {}) as Record<string, unknown> })
        const answer = nextAnswer()
        return Promise.resolve(typeof answer === 'function' ? (answer as (i: unknown[]) => unknown)(offered) : answer)
      },
      // 1.12 P9: an input box — its options recorded (a secret's box is `password`), answered from the queue.
      showInputBox: (options: unknown): Promise<unknown> => {
        inputBoxes.push((options ?? {}) as Record<string, unknown>)
        return Promise.resolve(nextAnswer())
      },
      showSaveDialog: (options: unknown): Promise<unknown> => {
        saveDialogs.push((options ?? {}) as Record<string, unknown>)
        return Promise.resolve(nextAnswer())
      },
      showTextDocument: (doc: unknown): Promise<unknown> => Promise.resolve(doc),
      withProgress<T>(options: unknown, task: (p: unknown, t: unknown) => PromiseLike<T>): PromiseLike<T> {
        // 1.13 A3 rule 8: the options and every report recorded (`progress`); nothing is rendered.
        const call: RecordedProgress = { options: (options ?? {}) as Record<string, unknown>, reported: [] }
        progress.push(call)
        return task(
          { report: (v: unknown) => { call.reported.push(v) } },
          { isCancellationRequested: false, onCancellationRequested: () => disposable() },
        )
      },
    },

    workspace: {
      get isTrusted(): boolean { return trusted },
      // 1.10 P4: VS Code fires it once the reader trusts the workspace (`setTrusted(true)`).
      onDidGrantWorkspaceTrust(listener: (e: void) => void): { dispose(): void } {
        return subscribe(trustListeners, listener)
      },
      getConfiguration: configuration,
      onDidChangeConfiguration(
        listener: (e: { affectsConfiguration(section: string): boolean }) => void,
      ): { dispose(): void } {
        return subscribe(configListeners, listener)
      },
      registerTextDocumentContentProvider(
        scheme: string,
        provider: { provideTextDocumentContent(uri: unknown): string },
      ): { dispose(): void } {
        contentProviders.set(scheme, provider)
        return disposable(() => contentProviders.delete(scheme))
      },
      openTextDocument(uri: FakeUri): Promise<unknown> {
        const provider = contentProviders.get(uri.scheme)
        const text = provider ? provider.provideTextDocumentContent(uri) : ''
        documents.push({ uri: uri.toString(), text })
        return Promise.resolve({ uri, languageId: 'plaintext', getText: () => text })
      },
      fs: {
        writeFile(uri: FakeUri, bytes: Uint8Array): Promise<void> {
          // Exports are never written to disk from a test: what would have been written is
          // recorded, so a test can read it back.
          writes.push({ path: uri.fsPath, text: Buffer.from(bytes).toString('utf8') })
          return Promise.resolve()
        },
      },
    },

    languages: {
      setTextDocumentLanguage: (doc: unknown): Promise<unknown> => Promise.resolve(doc),
    },

    /** The bundle VS Code would have loaded for `env.language`; `t` mirrors the real one. */
    l10n: {
      get bundle(): Record<string, string> | undefined { return l10nBundle },
      uri: undefined,
      t(message: string, ...args: Array<string | number | boolean>): string {
        const template = l10nBundle?.[message] ?? message
        return template.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] === undefined ? m : String(args[Number(i)])))
      },
    },
  }

  const state: FakeVscodeState = {
    log,
    registered,
    executed,
    executedArgs,
    items,
    itemSets,
    progress,
    clipboard,
    messages,
    quickPicks,
    quickPickControls,
    documents,
    saveDialogs,
    inputBoxes,
    writes,
    answers,
    settings: values,
    webviewProviders,
    contentProviders,
    live(prefix?: string): FakeStatusBarItem[] {
      return items.filter((i) => !i.disposed && i.visible && (!prefix || i.id.startsWith(prefix)))
    },
    textOf(id: string): string | undefined {
      return this.live().find((i) => i.id === id)?.text
    },
    execute(id: string, ...args: unknown[]): Promise<unknown> {
      return api.commands.executeCommand(id, ...args)
    },
    logText(): string {
      return log.map((l) => `${l.level} ${l.message}`).join('\n')
    },
    set(key: string, value: unknown): void {
      values.set(key, value)
    },
    setRemoteName(name: string | undefined): void {
      api.env.remoteName = name
    },
    setLanguage(tag: string, bundle?: Record<string, string>): void {
      language = tag
      l10nBundle = bundle
    },
    reset(settings?: Record<string, unknown>): void {
      language = 'en'
      l10nBundle = undefined
      log.length = 0
      registered.clear()
      handlers.clear()
      executed.length = 0
      executedArgs.length = 0
      items.length = 0
      itemSets.length = 0
      progress.length = 0
      clipboard.length = 0
      messages.length = 0
      quickPicks.length = 0
      quickPickControls.length = 0
      documents.length = 0
      saveDialogs.length = 0
      inputBoxes.length = 0
      writes.length = 0
      api.env.remoteName = undefined
      answers.length = 0
      webviewProviders.clear()
      contentProviders.clear()
      configListeners.length = 0
      windowStateListeners.length = 0
      // 1.8 B2: no terminal, nothing sent, the window focused, as a fresh window.
      terminals.length = 0
      sent.length = 0
      shown.length = 0
      trusted = true
      trustListeners.length = 0
      startListeners.length = 0
      endListeners.length = 0
      closeListeners.length = 0
      activeListeners.length = 0
      activeTerminal = undefined
      windowState.focused = true
      windowState.active = true
      reads.name = 0
      reads.output = 0
      reads.creation = 0
      if (settings) {
        values.clear()
        for (const [k, v] of Object.entries(settings)) values.set(k, v)
      }
    },
    fireConfigChange(keys: string[]): void {
      const event = {
        affectsConfiguration: (section: string): boolean =>
          keys.some((k) => k === section || k.startsWith(`${section}.`)),
      }
      for (const l of [...configListeners]) l(event)
    },
    fireWindowState(focused: boolean): void {
      windowState.focused = focused
      windowState.active = focused
      for (const l of [...windowStateListeners]) l({ focused, active: focused })
    },
    terminals,
    sent,
    shown,
    setTrusted(value: boolean): void {
      const granted = value && !trusted
      trusted = value
      if (granted) for (const l of [...trustListeners]) l()
    },
    get nameReads(): number { return reads.name },
    get outputReads(): number { return reads.output },
    get creationReads(): number { return reads.creation },
    openTerminal(o: { shell?: string; name?: string; cwd?: string | null; integration?: boolean; refuse?: boolean } = {}): FakeTerminal {
      const shellState = { isInteractedWith: false, shell: o.shell as string | undefined }
      const title = o.name ?? 'bash'
      const cwd = o.cwd === null || o.cwd === undefined ? undefined : { fsPath: o.cwd, scheme: 'file', path: o.cwd }
      const terminal: FakeTerminal = {
        get name(): string { reads.name++; return title },
        get state(): { isInteractedWith: boolean; shell: string | undefined } { return { ...shellState } },
        shellIntegration: o.integration === false ? undefined : { cwd },
        get creationOptions(): Record<string, unknown> { reads.creation++; return { name: title } },
        get processId(): Promise<number | undefined> { reads.creation++; return Promise.resolve(4242) },
        exitStatus: undefined,
        sendText(text: string, shouldExecute?: boolean): void {
          if (o.refuse === true) throw Object.assign(new Error(`The terminal ${title} has been disposed`), { name: 'TerminalGone' })
          shellState.isInteractedWith = true
          sent.push({ terminal, text, execute: shouldExecute })
        },
        show(preserveFocus?: boolean): void { shown.push({ terminal, preserveFocus }) },
        hide(): void { /* nothing to hide */ },
        dispose(): void { state.closeTerminal(terminal) },
        setShell(shell: string | undefined): void { shellState.shell = shell },
      }
      terminals.push(terminal)
      return terminal
    },
    startExecution(terminal: FakeTerminal, o: { commandLine: string; confidence?: number; cwd?: string | null }): FakeExecution {
      const cwd = o.cwd === null || o.cwd === undefined ? undefined : { fsPath: o.cwd, scheme: 'file', path: o.cwd }
      const execution: FakeExecution = {
        commandLine: { value: o.commandLine, confidence: o.confidence ?? 2, isTrusted: true },
        cwd,
        read(): AsyncIterable<string> {
          reads.output++
          return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: '' }) }) }
        },
      }
      for (const l of [...startListeners]) l({ terminal, execution, shellIntegration: terminal.shellIntegration })
      return execution
    },
    endExecution(terminal: FakeTerminal, execution: FakeExecution): void {
      for (const l of [...endListeners]) l({ terminal, execution, shellIntegration: terminal.shellIntegration, exitCode: 0 })
    },
    closeTerminal(terminal: FakeTerminal): void {
      const at = terminals.indexOf(terminal)
      if (at < 0) return
      terminals.splice(at, 1)
      if (activeTerminal === terminal) {
        activeTerminal = undefined
        for (const l of [...activeListeners]) l(undefined)
      }
      for (const l of [...closeListeners]) l(terminal)
    },
    setActiveTerminal(terminal: FakeTerminal | undefined): void {
      activeTerminal = terminal
      for (const l of [...activeListeners]) l(terminal)
    },
    terminalListeners(): number {
      return startListeners.length + endListeners.length + closeListeners.length + activeListeners.length
    },
  }

  return { api, state }
}

// ---------------------------------------------------------------------------
// Module injection
// ---------------------------------------------------------------------------

let current: unknown = null

/**
 * Makes `require('vscode')` return `fake` from here on.
 *
 * The hook is installed once per process and then only ever re-pointed, so a second
 * test in the same file gets its own recording without a second layer of patching.
 */
export function installVscodeStub(fake: unknown): void {
  current = fake
  const mod = require('node:module')
  if (mod._load.tokenPaceStub) return
  const original = mod._load
  const load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return current
    return original.call(this, request, parent, isMain)
  }
  load.tokenPaceStub = true
  mod._load = load
}

// ---------------------------------------------------------------------------
// Extension context
// ---------------------------------------------------------------------------

/**
 * 1.12 P9: `vscode.SecretStorage` in memory — the map a test reads back, and every call in order (a test that
 * asserts "no secret read" looks at `calls`).
 */
export function fakeSecrets(initial: Record<string, string> = {}): { secrets: Record<string, unknown>; store: Map<string, string>; calls: string[] } {
  const store = new Map<string, string>(Object.entries(initial))
  const calls: string[] = []
  const secrets = {
    get: (key: string): Promise<string | undefined> => { calls.push(`get:${key}`); return Promise.resolve(store.get(key)) },
    store: (key: string, value: string): Promise<void> => { calls.push(`store:${key}`); store.set(key, value); return Promise.resolve() },
    delete: (key: string): Promise<void> => { calls.push(`delete:${key}`); store.delete(key); return Promise.resolve() },
    keys: (): Promise<string[]> => { calls.push('keys'); return Promise.resolve([...store.keys()]) },
    onDidChange: (): { dispose(): void } => ({ dispose: () => undefined }),
  }
  return { secrets, store, calls }
}

export interface FakeExtensionContext {
  subscriptions: Array<{ dispose(): void }>
  globalState: FakeMemento
  /** 1.12 P9: VS Code's secret storage — `fakeSecrets()`'s, empty unless a test hands one in. */
  secrets: Record<string, unknown>
  workspaceState: FakeMemento
  globalStorageUri: { fsPath: string }
  storageUri: { fsPath: string }
  logUri: { fsPath: string }
  extensionPath: string
  extensionUri: { fsPath: string }
  extensionMode: number
  asAbsolutePath(relative: string): string
}

export function createFakeContext(opts: {
  storage: string
  extensionPath: string
  globalState?: Map<string, unknown>
  secrets?: Record<string, unknown>
}): FakeExtensionContext {
  return {
    subscriptions: [],
    globalState: memento(opts.globalState ?? new Map<string, unknown>()),
    secrets: opts.secrets ?? fakeSecrets().secrets,
    workspaceState: memento(),
    globalStorageUri: { fsPath: opts.storage },
    storageUri: { fsPath: opts.storage },
    logUri: { fsPath: opts.storage },
    extensionPath: opts.extensionPath,
    extensionUri: { fsPath: opts.extensionPath },
    extensionMode: 2,
    asAbsolutePath: (relative: string): string => path.join(opts.extensionPath, relative),
  }
}

/** Runs every registered `dispose`, newest first, and reports the ones that threw. */
export function disposeAll(context: FakeExtensionContext): string[] {
  const failures: string[] = []
  for (const d of [...context.subscriptions].reverse()) {
    try {
      d.dispose()
    } catch (err) {
      failures.push(String(err))
    }
  }
  context.subscriptions.length = 0
  return failures
}
