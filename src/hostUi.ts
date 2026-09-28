// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.13 A3 rule 8 (§7a Q8): the one door to VS Code's messages, dialogs, Quick Picks, InputBox and progress
 * notifications. Every call of VS Code's `show…Message`, Quick Pick, InputBox and progress API in `src/` is made here
 * and nowhere else — test/bidi.test.ts holds it with the privacy scan's lexer (comments and strings blanked): a new
 * site elsewhere fails with its file and line. The host seams that ask a question (the consents' `ui`, the prompt
 * tool's, the notification channels' `NotifyUi`) are built from `hostUi()` or `hostUiOf(window)`.
 *
 * What the door adds is the direction of the words' language (i18n.ts `dir()`, src/bidi.ts): in Arabic, Hebrew and
 * Persian the texts VS Code draws are isolated — a message and its buttons, a dialog's `detail` line by line, a Quick
 * Pick's title, placeholder and every item's label, description and detail, an InputBox's title, prompt, placeholder
 * and validation message (never its value: the reader's own input stays as typed), a progress notification's title
 * and message. A left-to-right language gets every text as the caller wrote it, and the call VS Code sees is the one
 * the caller would have made. Every answer comes back as the caller's own: the button label, the item object — so a
 * caller compares with its unisolated label (i18n.ts rule 2: computed once, shown and compared) and no call site's
 * logic changes.
 *
 * `vscode` is required when a door is used, never at load: the consents, the prompt tool and the notification host
 * stay loadable in a plain test, which hands its fake window to `hostUiOf`.
 */

import type * as vscode from 'vscode'
import { isolate, isolateLines } from './bidi'
import { dir } from './i18n'
import type { TextDirection } from './languages'

export type MessageKind = 'info' | 'warning' | 'error'

/** A message's options: `{}` for a notification, `{ modal: true, detail }` for a dialog. */
export interface MessageOpts {
  modal?: boolean
  detail?: string
}

/** The members of VS Code's window the door calls — `vscode.window`, or a test's fake of it. */
export type WindowApi = Pick<typeof vscode.window, 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'
  | 'showQuickPick' | 'showInputBox' | 'createQuickPick' | 'withProgress'>

/** The questions and notices a host puts to the reader, each through the door. */
export interface HostUi {
  /** A message (`opts` `{}`) or a dialog (`{ modal: true, detail }`); the answer is the caller's label, or undefined. */
  showMessage(kind: MessageKind, message: string, opts: MessageOpts, ...labels: string[]): Promise<string | undefined>
  /**
   * A Quick Pick of items or of strings; the answer is the caller's own item. `typed`: the options that show the
   * reader's own text (a command from their settings file as the placeholder) — as typed, as an InputBox's value is.
   */
  showPick<T extends vscode.QuickPickItem | string>(items: readonly T[], options?: vscode.QuickPickOptions,
    typed?: readonly PickText[]): Promise<T | undefined>
  /** A Quick Pick of several (`canPickMany`); the answer is the caller's own items. */
  showPickMany<T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions): Promise<T[] | undefined>
  /** An InputBox; the answer is what the reader typed, as typed. */
  showInput(options: vscode.InputBoxOptions): Promise<string | undefined>
  /** A Quick Pick control for a caller that fills it itself — with `pickItems`, `isolate` (src/bidi.ts) for its texts. */
  createPick<T extends vscode.QuickPickItem>(): vscode.QuickPick<T>
  /** A progress notification: its title and every reported message isolated. */
  showProgress<R>(options: vscode.ProgressOptions,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<R>): Thenable<R>
}

/** Whether `opts` asks for anything — `{}` is a plain message, made as the call without options VS Code treats alike. */
function hasOptions(opts: MessageOpts | undefined): opts is MessageOpts {
  return opts !== undefined && opts !== null && Object.keys(opts).length > 0
}

/**
 * A message's texts as VS Code shows them: the message isolated, a dialog's `detail` line by line (a hard-wrapped
 * paragraph is one bidi paragraph per line), each button label isolated. Pure; the same object for a left-to-right
 * language.
 */
export function messageTexts(message: string, opts: MessageOpts, labels: readonly string[], d: TextDirection = dir()):
  { message: string; opts: MessageOpts; labels: string[] } {
  if (d !== 'rtl') return { message, opts, labels: [...labels] }
  const shownOpts = opts.detail === undefined ? opts : { ...opts, detail: isolateLines(opts.detail, d) }
  return { message: isolate(message, d), opts: shownOpts, labels: labels.map((l) => isolate(l, d)) }
}

/**
 * The items of a Quick Pick as VS Code shows them: a string isolated, an item copied with its `label`, `description`
 * and `detail` isolated (every other field — a command, a key, a separator's kind — as it was). `items` itself for a
 * left-to-right language.
 */
export function pickItems<T extends vscode.QuickPickItem | string>(items: readonly T[], d: TextDirection = dir()): T[] {
  if (d !== 'rtl') return items as T[]
  return items.map((item): T => {
    if (typeof item === 'string') return isolate(item, d) as T
    const shown: vscode.QuickPickItem = { ...item, label: isolate(item.label, d) }
    if (typeof item.description === 'string') shown.description = isolate(item.description, d)
    if (typeof item.detail === 'string') shown.detail = isolate(item.detail, d)
    return shown as T
  })
}

/** The two texts of a Quick Pick's options. */
export type PickText = 'title' | 'placeHolder'

/**
 * A Quick Pick's options as VS Code shows them: `title` and `placeHolder` isolated, but those `typed` names (the
 * reader's own text). `o` itself left to right.
 */
export function pickOptions(o: vscode.QuickPickOptions, d: TextDirection = dir(), typed: readonly PickText[] = []): vscode.QuickPickOptions {
  if (d !== 'rtl') return o
  const shown: vscode.QuickPickOptions = { ...o }
  if (typeof o.title === 'string' && !typed.includes('title')) shown.title = isolate(o.title, d)
  if (typeof o.placeHolder === 'string' && !typed.includes('placeHolder')) shown.placeHolder = isolate(o.placeHolder, d)
  return shown
}

/** A validation message as VS Code shows it under the InputBox: a text isolated, the rest as it is. */
function shownValidation(v: unknown, d: TextDirection): unknown {
  if (typeof v === 'string') return isolate(v, d)
  if (v !== null && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') {
    return { ...(v as object), message: isolate((v as { message: string }).message, d) }
  }
  if (v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function') {
    return (v as Thenable<unknown>).then((x) => shownValidation(x, d))
  }
  return v
}

/**
 * An InputBox's options as VS Code shows them: `title`, `prompt`, `placeHolder` and every validation message isolated —
 * never `value`, the reader's own text (a URL, an address, a token), which stays as typed. `o` itself left to right.
 */
export function inputOptions(o: vscode.InputBoxOptions, d: TextDirection = dir()): vscode.InputBoxOptions {
  if (d !== 'rtl') return o
  const shown: vscode.InputBoxOptions = { ...o }
  if (typeof o.title === 'string') shown.title = isolate(o.title, d)
  if (typeof o.prompt === 'string') shown.prompt = isolate(o.prompt, d)
  if (typeof o.placeHolder === 'string') shown.placeHolder = isolate(o.placeHolder, d)
  const validate = o.validateInput
  if (typeof validate === 'function') {
    shown.validateInput = (value: string) => shownValidation(validate(value), d) as ReturnType<typeof validate>
  }
  return shown
}

/** The caller's own answer for what VS Code handed back: the original at the shown one's place, else what it handed. */
function original<T>(shown: readonly T[], items: readonly T[], chosen: T): T {
  const at = shown.indexOf(chosen)
  return at >= 0 ? items[at] : chosen
}

/**
 * The door over one window: `w`, or the window a function returns when a door is used (`hostUi()` — the real one,
 * required then). The members are read at each call, so a test that replaces one of its fake's reaches it.
 */
export function hostUiOf(w: WindowApi | (() => WindowApi)): HostUi {
  const win = (): WindowApi => (typeof w === 'function' ? w() : w)
  return {
    async showMessage(kind, message, opts, ...labels) {
      const shown = messageTexts(message, opts ?? {}, labels)
      const target = win()
      const show = (kind === 'error' ? target.showErrorMessage : kind === 'warning' ? target.showWarningMessage
        : target.showInformationMessage) as (m: string, ...rest: unknown[]) => Thenable<string | undefined>
      const choice = hasOptions(shown.opts)
        ? await show.call(target, shown.message, shown.opts, ...shown.labels)
        : await show.call(target, shown.message, ...shown.labels)
      return choice === undefined ? undefined : original(shown.labels, labels, choice)
    },
    async showPick<T extends vscode.QuickPickItem | string>(items: readonly T[], options?: vscode.QuickPickOptions,
      typed: readonly PickText[] = []) {
      const shown = pickItems(items)
      const pick = win().showQuickPick as (i: readonly T[], o?: vscode.QuickPickOptions) => Thenable<T | undefined>
      const chosen = await pick.call(win(), shown, options === undefined ? undefined : pickOptions(options, dir(), typed))
      return chosen === undefined ? undefined : original(shown, items, chosen)
    },
    async showPickMany<T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions) {
      const shown = pickItems(items)
      const pick = win().showQuickPick as (i: readonly T[], o: vscode.QuickPickOptions) => Thenable<T[] | undefined>
      const chosen = await pick.call(win(), shown, pickOptions({ ...(options ?? {}), canPickMany: true }))
      return chosen === undefined ? undefined : Array.isArray(chosen) ? chosen.map((c) => original(shown, items, c)) : chosen
    },
    async showInput(options) {
      return win().showInputBox(inputOptions(options))
    },
    createPick<T extends vscode.QuickPickItem>() {
      return win().createQuickPick<T>()
    },
    showProgress(options, task) {
      const d = dir()
      const target = win()
      if (d !== 'rtl') return target.withProgress(options, task)
      const shown = typeof options.title === 'string' ? { ...options, title: isolate(options.title, d) } : options
      return target.withProgress(shown, (progress, token) => task({
        report: (v) => progress.report(typeof v?.message === 'string' ? { ...v, message: isolate(v.message, d) } : v),
      }, token))
    },
  }
}

/** The door over VS Code's own window, required when it is used. */
export function hostUi(): HostUi {
  return hostUiOf(() => (require('vscode') as typeof import('vscode')).window)
}

/** `hostUi().showMessage` — a message or a dialog through the door. */
export function showMessage(kind: MessageKind, message: string, opts: MessageOpts, ...labels: string[]): Promise<string | undefined> {
  return hostUi().showMessage(kind, message, opts, ...labels)
}

/** `hostUi().showPick` — a Quick Pick through the door. */
export function showPick<T extends vscode.QuickPickItem | string>(items: readonly T[], options?: vscode.QuickPickOptions,
  typed?: readonly PickText[]): Promise<T | undefined> {
  return hostUi().showPick(items, options, typed)
}

/** `hostUi().showPickMany` — a Quick Pick of several through the door. */
export function showPickMany<T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions): Promise<T[] | undefined> {
  return hostUi().showPickMany(items, options)
}

/** `hostUi().showInput` — an InputBox through the door. */
export function showInput(options: vscode.InputBoxOptions): Promise<string | undefined> {
  return hostUi().showInput(options)
}

/** `hostUi().createPick` — a Quick Pick control through the door. */
export function createPick<T extends vscode.QuickPickItem>(): vscode.QuickPick<T> {
  return hostUi().createPick<T>()
}

/** `hostUi().showProgress` — a progress notification through the door. */
export function showProgress<R>(options: vscode.ProgressOptions,
  task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<R>): Thenable<R> {
  return hostUi().showProgress(options, task)
}
