// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode'

const CONSENT_KEY = 'networkConsent'
const OFFERED_KEY = 'networkConsentOffered'

export type ConsentState = 'granted' | 'denied' | 'unasked'

/**
 * Gate in front of every network access the extension makes on its own.
 *
 * Quota percentages can only be fetched with Claude Code's access token, and
 * starting to do that unasked is not defensible however carefully it is
 * implemented. So the default touches no network at all, and the one question
 * that unlocks it states plainly what is sent where — including the fact that
 * the request identifies itself as the Claude Code client, which is the part a
 * user is least able to discover on their own.
 *
 * The answer is remembered per machine, never synced, and revocable.
 */
export class NetworkConsent {
  private asking: Promise<boolean> | null = null

  constructor(
    private memento: vscode.Memento,
    private log: (msg: string) => void,
  ) {}

  state(): ConsentState {
    return this.memento.get<ConsentState>(CONSENT_KEY, 'unasked')
  }

  granted(): boolean {
    return this.state() === 'granted'
  }

  /**
   * Asks once and remembers the answer. Concurrent callers share the same
   * dialog rather than stacking several on top of each other.
   */
  request(): Promise<boolean> {
    if (this.granted()) return Promise.resolve(true)
    if (this.asking) return this.asking
    this.asking = this.ask().finally(() => { this.asking = null })
    return this.asking
  }

  private async ask(): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      'Allow Token Pace to fetch quota figures?',
      { modal: true, detail: DISCLOSURE },
      'Allow',
      'Never',
    )
    if (choice === 'Allow') {
      await this.memento.update(CONSENT_KEY, 'granted')
      this.log('Network access allowed by the user.')
      return true
    }
    // Cancel means "not now" and stays askable; only "Never" is recorded.
    if (choice === 'Never') {
      await this.memento.update(CONSENT_KEY, 'denied')
      this.log('Network access declined by the user.')
    }
    return false
  }

  /** Whether the unprompted one-time offer has already been made. */
  offered(): boolean {
    return this.memento.get<boolean>(OFFERED_KEY, false)
  }

  async markOffered(): Promise<void> {
    await this.memento.update(OFFERED_KEY, true)
  }

  async reset(): Promise<void> {
    await this.memento.update(CONSENT_KEY, undefined)
    await this.memento.update(OFFERED_KEY, undefined)
    this.log('Network access decision reset.')
  }
}

const DISCLOSURE = [
  'Token counts are read from local transcript files and need no network access. Quota percentages do.',
  '',
  'If you allow it, then at most every 30 minutes:',
  '',
  '• Claude — GET https://api.anthropic.com/api/oauth/usage, using the accessToken from',
  '  ~/.claude/.credentials.json. The request identifies itself as the Claude Code client,',
  '  because the endpoint rate-limits other callers into a permanent 429.',
  '• Codex — the local "codex app-server" is started and asked for its rate limits. No traffic',
  '  of ours leaves the machine for this.',
  '',
  'The token is only read, never refreshed, and appears in no log line or error message. The',
  'target address is hard-coded and cannot be configured. Nothing is sent anywhere else, and',
  'no usage data is collected by this extension.',
  '',
  'You can change this later with "Token Pace: Reset Network Access Decision".',
].join('\n')
