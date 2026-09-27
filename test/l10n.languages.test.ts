// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 B3: the frame every language is measured by.
 *
 * Twelve languages beyond English and German are translated by AI agents, in parallel, from the
 * English source with the German as a second reference (l10n/TRANSLATING.md), and no native speaker
 * reads them. What a machine can check is checked here, the same thirteen rules for every language
 * whose files are on disk — German among them, whose own rules (no informal „du", „Token" not
 * „Tokens") stay in its own tests:
 *
 *   T1  the keys: the bundle's are the extracted t() keys, the manifest's are package.nls.json's in its order
 *   T2  the parts: the four part files, each with exactly the German part's keys
 *   T3  the placeholders: every {n} of the key, as often
 *   T4  the marks: ~ ⚠ ≈ – % × → · as often as the key (the manifest: ~ ⚠ ≈ –)
 *   T5  the code: backtick spans, tokenPace ids, codicons, command targets; in the manifest also the
 *       setting links, command links, fences, paragraphs and JSON examples
 *   T6  the page's words carry no markup character
 *   T7  the tone: no exclamation mark
 *   T8  the tables: a header row keeps its pipes
 *   T9  no English left, proper names and code excepted (SAME_IN_EVERY_LANGUAGE), a key's own field ids too
 *       (FIELD_IDS_OF_A_KEY)
 *   T10 the registry: every file names a shipped language; the language names translated (or written
 *       as the English where LANGUAGE_NAME_AS_ENGLISH says the language writes them so), the native
 *       names and the product's name as they are
 *   T11 the English quotes: the keep-warm consent quotes the terms and the line verbatim, and a
 *       quoted {n} stays between quotation marks
 *   T12 the freshness of the manifest's translations (scripts/nls-sources.mjs --check)
 *   T13 the heat map's weekday words fit their column: four characters at most — counted as a reader
 *       sees them, in grapheme clusters (1.11 A3)
 *   T14 the pending list (1.10 B1): its keys in today's English, the ledger applied to its end, none
 *       for German, none at all once PENDING_ALLOWED is false
 *
 * 1.10 B1: the English changes while 1.10's code is written, and each change is an entry of the
 * re-key ledger (l10n/rekey.json), which scripts/l10n-rekey.mjs applies to every language's files.
 * What a language has not translated yet is on its pending list (l10n/pending/<id>.json), and while
 * PENDING_ALLOWED is true the rules read that list: a key listed `translate` may be absent (T1, T2 —
 * t() shows the English, on the build branch only), a manifest key on the list stays out of the rules
 * that compare a value with today's English (T3, T4, T5, T7, T9: its value is the English, or a
 * translation of the English before the change), and nls-sources.mjs --check calls it pending, not
 * stale (T12). The ledger's own test replays the entries on the tree they start from
 * (l10n/rekey-base.json) and asks for today's key sets: an English change without its entry fails.
 * At the join (1.10 P20) PENDING_ALLOWED is false, and every rule holds every key again.
 *
 * 1.11 A3: twelve more languages are written from the frozen English — Ukrainian, Greek and Hindi in scripts of their
 * own, Swedish and Finnish with their own quotation marks, Hindi with weekday words longer in code points than on the
 * screen. Each rule that would misjudge one of them was taught once, for every language, before a single one was
 * written: NON_LATIN names every language of another script, T13 counts grapheme clusters, a ” may open and a » close
 * a quotation, T4 counts the marks of the NFC form (the Greek ano teleia, U+0387, is the separator · there) and names
 * the ano teleia itself, and T10 lets a language name the ledger has just added be absent while it is pending and a
 * name equal to the English stand where LANGUAGE_NAME_AS_ENGLISH says the language writes it so. The ledger started
 * again at 1.10.0's release commit (l10n-rekey.mjs --start b89ff43), and PENDING_ALLOWED was true until 1.11's join
 * (P8 set it false).
 *
 * 1.12 E1 (P1): the English changes again while 1.12's code is written, for all twenty-four languages at once: the ledger
 * started at 1.11.0's release commit (l10n-rekey.mjs --start d39c2df) with a list at cursor 0 for each, and
 * PENDING_ALLOWED was true until 1.12's join (P10 set it false). Before a single 1.12 text is written, T9 learned the
 * names those texts carry (NAMES_OF_1_12) and to read a name of several words across a line break (D4), and
 * SESSION_NAME_KEYS lists the keys whose placeholder receives a session's name — held to the code by a scan of every t()
 * call and named in the brief (D10).
 *
 * Every rule is a function over the files of one language, so it runs over the repository's files
 * and — each once with the mutation it exists to catch — over a synthetic language written into a
 * temporary directory: a copy of the German under another id (a Latin-script language), a
 * pseudo-translation of the English that turns every word into 語 and keeps everything the rules
 * hold (a language of another script), and — since 1.11 — the same pseudo-translation with every
 * word शुक्र under `hi` (a script whose weekday words are longer in code points than on the screen).
 * Each passes every rule before it is broken. No file outside
 * the repository and the test's own temporary directories is touched; nothing is sent anywhere.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { budgetRows } from '../src/budget'
import { readTimeConfig, sanitize } from '../src/config'
import { KEEP_WARM_TERMS_PASSAGE, KeepWarmConsent } from '../src/consent'
import { setBundle, setLang, setLocale } from '../src/i18n'
import { KEEP_WARM_LINE } from '../src/keepWarm'
import { isLanguageId, LANGUAGE_IDS, languageEntry, languageName, LANGUAGES } from '../src/languages'
import type { StatsCtx } from '../src/stats'
import { buildItems, makeContext, UsageSource } from '../src/statusText'
import type { MementoLike } from '../src/storage'
import { formatReset, weekdayWords } from '../src/time'
import { emptyBucket, QuotaState, QuotaWindow } from '../src/types'
import { LANGUAGE_NAME_AS_ENGLISH, ROOT } from './helpers/nls'

// ---------------------------------------------------------------------------
// The words that stay the same in every language (T9)
// ---------------------------------------------------------------------------

/**
 * T9's false positives the translation packages reported, added at the join of group L (1.9 B5: the lead's 23860f6
 * after the ja merge, confirmed by P19 over all twelve reports) — each named in the brief (TRANSLATING.md, T9), which
 * the brief's test holds. The reports were these three words, all from the languages of another script, where three
 * Latin words in a row fail T9 (ja, ko, zh-cn, zh-tw, ru); fr, es, pt-br, tr, pl and cs reported none. Italian reported
 * one in `config.budgets.description` — "uno per scope × period × unit", 'per' being Italian too — and rephrased it: no
 * entry for it, since 'scope', 'period', 'unit' and 'per' are English words T9 has to go on catching, and no narrower
 * rule tells the Italian 'per' from the English one.
 */
export const ADDED_AT_THE_JOIN: ReadonlyArray<readonly [string, string]> = [
  ['codex app-server', 'the literal command Token Pace starts — the bundle key "• Codex — the local …codex app-server… is started …", config.codexQuotaSources.enum.poll, config.codexAppServer.mode.enum.oneShot and .persistent (ja, ko, zh-cn, zh-tw, ru)'],
  ['paceWarn', 'a contributed theme colour id — config.colorMode.enum.theme lists `tokenPace.paceOk / paceWarn / paceAhead / stale` (ja, ko, zh-cn, zh-tw, ru)'],
  ['paceAhead', 'a contributed theme colour id — config.colorMode.enum.theme, as paceWarn'],
]

/**
 * 1.12 E1 rule 2 (P1): the names 1.12's texts carry — the credentials cascade's (B), the notifications' channels and
 * protocols (C) —, added before a single one of those texts is written, each with its reason: without them T9 reads them as
 * English left (in a language of another script a run of three Latin words — `Microsoft Teams` beside one more name is
 * three; in a Latin one four of the key's words in a row). A package whose English names another adds it here, named,
 * with its reason (§3 E1 rule 2); the brief's 1.12 section names every one.
 */
export const NAMES_OF_1_12: ReadonlyArray<readonly [string, string]> = [
  ['CLAUDE_CODE_OAUTH_TOKEN', 'an environment variable\'s name — the credentials cascade\'s first source (§3 B1)'],
  ['Secret Service', 'freedesktop\'s service, the store Linux\'s `secret-tool` reads (§3 B1, §7 Q8)'],
  ['secret-tool', 'a command\'s name (libsecret\'s tool on Linux)'],
  ['Slack', 'a service\'s name — a webhook preset (§3 C1)'],
  ['Discord', 'a service\'s name — a webhook preset (§3 C1)'],
  ['Microsoft Teams', 'a product\'s name — a webhook preset (§3 C1)'],
  ['Mattermost', 'a service\'s name — a webhook preset (§3 C1)'],
  ['Rocket.Chat', 'a service\'s name — a webhook preset (§3 C1)'],
  ['Telegram', 'a service\'s name — a channel (§3 C1)'],
  ['ntfy', 'a service\'s name, written in lower case — a channel (§3 C1)'],
  ['BotFather', 'Telegram\'s bot that makes a bot and its token — a name (§3 C1)'],
  ['SMTP', 'a protocol\'s name — the e-mail channel (§3 C10)'],
  ['STARTTLS', 'a protocol command\'s name — the e-mail channel\'s security (§3 C10)'],
]

/**
 * 1.12 O2 (the lead, at O2's merge — §0b.7: an exception is never a package's): a key that names a setting's fields by
 * their ids keeps those ids in English in every language, as the ledger's why says (n=95, P9 — §3 C13) — a language of
 * another script lists them between its own separators (ja 「host、user、from、to」, ru «host, user, from и to»), a run
 * of Latin words T9's second rule read as English left: O2 reported it for ja, ko, zh-cn, zh-tw and ru, and O4's uk, el
 * and hi would follow. Held per key — `[key, ids, reason]`: T9 takes the ids out of that key and its value alone, so
 * that `host`, `user`, `from` and `to` stay English words it catches everywhere else (SAME_IN_EVERY_LANGUAGE would
 * take them out of every text). The brief's T9 section names the key and the ids.
 */
export const FIELD_IDS_OF_A_KEY: ReadonlyArray<readonly [string, ReadonlyArray<string>, string]> = [
  ['Set host, user, from and to in tokenPace.notifications.email first.', ['host', 'user', 'from', 'to'],
    'the e-mail channel\'s setup check names the four fields of tokenPace.notifications.email by their ids (ledger n=95, P9 — §3 C13); O2 reported the false positive for the five languages of another script'],
]

/**
 * T9's exceptions, each with its reason: a word of this list is taken out of the key and the value
 * before they are compared, so keeping it in English is no "English left". Owned by 1.9 P3; the lead
 * extends it at the join (P19) for a false positive a translation package reports — never a package
 * itself (§0b.7): ADDED_AT_THE_JOIN. Case matters: `Windows` is the operating system, `windows` the quota's.
 */
export const SAME_IN_EVERY_LANGUAGE: ReadonlyArray<readonly [string, string]> = [
  // The product names of the brief (TRANSLATING.md, "Never translated").
  ['Token Pace', 'the product\'s name'],
  ['Claude Code', 'a product\'s name'],
  ['Claude', 'a product\'s name'],
  ['Codex', 'a product\'s name'],
  ['Anthropic', 'a company\'s name'],
  ['OpenAI', 'a company\'s name'],
  ['ChatGPT', 'a product\'s name'],
  ['Visual Studio Code', 'a product\'s name'],
  ['VS Code', 'a product\'s name'],
  ['Open VSX', 'a registry\'s name'],
  ['GitHub', 'a service\'s name'],
  ['WSL', 'a product\'s name (Windows Subsystem for Linux)'],
  ['Windows', 'an operating system\'s name'],
  ['macOS', 'an operating system\'s name'],
  ['Linux', 'an operating system\'s name'],
  // Abbreviations every language writes the same.
  ['API', 'an abbreviation written so in every language'],
  ['USD', 'a currency code'],
  ['CSV', 'a file format\'s name'],
  ['JSON', 'a file format\'s name'],
  ['TTL', 'the cache\'s time-to-live as Anthropic writes it (`1 h TTL` is a fixed form, §3 A5)'],
  ['ID', 'an abbreviation written so in every language'],
  ['HTTP', 'a protocol\'s name'],
  ['TLS', 'a protocol\'s name'],
  ['OAuth', 'a protocol\'s name'],
  ['CLI', 'an abbreviation written so in every language'],
  ['P90', 'a statistic\'s name (the 90th percentile)'],
  ['CV', 'a statistic\'s name (the coefficient of variation)'],
  ['ctx', 'the context figure\'s short label'],
  // The units and suffixes of the fixed forms (§3 A5: `2 h 14 min`, `4 m 10 s`, `12.5K`).
  ['min', 'a unit of the fixed forms'],
  ['h', 'a unit of the fixed forms'],
  ['d', 'a unit of the fixed forms'],
  ['m', 'a unit of the fixed forms (`4 m 10 s`, countdownText)'],
  ['s', 'a unit of the fixed forms'],
  ['K', 'a suffix of the fixed forms'],
  ['M', 'a suffix of the fixed forms'],
  ['G', 'a suffix of the fixed forms'],
  ['Quick Pick', 'VS Code\'s name for the list, kept as shipped (the German says „Quick Pick" too)'],
  // 1.9 P3: found by running the rule over German, or certain for every language.
  ['CC', 'the status bar\'s short label for Claude Code (adapters `shortLabel`) — notation, quoted in the manifest\'s examples'],
  ['CDX', 'the status bar\'s short label for Codex (adapters `shortLabel`) — notation'],
  ['Pro', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  ['Max', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  ['Team', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  ['Plus', 'a plan\'s name as the providers write it (config.planName\'s examples)'],
  // 1.9 B5: the join's false positives (above).
  ...ADDED_AT_THE_JOIN,
  // 1.11 L3 (the lead, at the merge — ADDED_AT_THE_JOIN): VS Code's command title, kept in English where VS Code has no
  // language pack for the reader's language (uk, el; hi), so that the Command Palette shows the title the sentence names.
  ['Configure Display Language', 'a command title of VS Code, kept in English where VS Code has no pack for the language'],
  // 1.12 P1 (§3 E1 rule 2): the names 1.12's texts carry (above).
  ...NAMES_OF_1_12,
]

/**
 * The languages written in another script than Latin (T9's second rule): their values may keep no
 * run of three Latin words. Every other language of the registry is written in Latin script.
 * 1.11 A3 rule 1: Ukrainian (Cyrillic), Greek and Hindi (Devanagari) joined before they were written;
 * Vietnamese is written in Latin letters (LATIN_LETTERS spans its U+1E00–U+1EFF), so T9's Latin rule
 * holds it. A test holds this set to the scripts of the registry's native names.
 */
export const NON_LATIN: ReadonlySet<string> = new Set(['ja', 'ko', 'zh-cn', 'zh-tw', 'ru', 'uk', 'el', 'hi'])

/**
 * T5: a backtick span of the manifest that is words, not code — a formula spelled in words or a
 * label the page shows translated. A translation may put these into its own words (the German does,
 * since 1.2); every other span is a setting's value, a key or a command and stays as it is.
 */
export const NLS_SPANS_READ_AS_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['ratio = (used ÷ limit) ÷ (elapsed ÷ window)', 'the pace formula in words (config.pace.*)'],
  ['used % − elapsed %', 'the tolerance formula in words (config.pace.sensitivity)'],
  ['ratio 1.12', 'a value of the formula, in its words (config.pace.tolerancePoints)'],
  ['elapsed ≈ 0', 'the formula\'s edge case in words (config.pace.minElapsedPercent)'],
  ['subagents', 'the chart chip\'s label as the page shows it (config.chart.modelStyle) — the page translates it'],
  // 1.9 B5 (P19): two spans every translation package reported — each quotes a text the extension shows translated.
  ['plan Max 20x (as configured)', 'the configured plan as the tooltip names it — the runtime string \'plan {0} (as configured)\', translated (config.planName) — all twelve packages reported it'],
  ['other', 'the chart band\'s label as the page shows it — the bundle key \'other\', translated (config.chart.modelStyle) — reported by ko'],
]

/**
 * 1.10 B1: whether a language may carry pending keys — the ones l10n/pending/<id>.json lists, which the English
 * changes of 1.10's code packages left for the language's own package (scripts/l10n-rekey.mjs). True from 1.10 P1
 * until the join; P20 set it false (the twelve language packages merged, every list deleted), and from then on no
 * pending file may exist (T14) and every rule holds every key. The next version's first English change turns it true
 * again together with `l10n-rekey.mjs --start`.
 * 1.11 P1: true again — `l10n-rekey.mjs --start b89ff43` started 1.11's ledger with a list at cursor 0 for each of the
 * twelve 1.10 languages; 1.11's join (P8) sets it false. test/languages.test.ts's join test reads this line.
 * 1.11 P8: false — group N wrote the twelve new languages whole, group O worked the twelve 1.10 lists to the ledger's end
 * and deleted them; no list is left, and every rule holds every key of all twenty-four languages and German again.
 * 1.12 P1: true again — `l10n-rekey.mjs --start d39c2df` (the 1.11.0 release) started 1.12's ledger with a list at cursor
 * 0 for each of the twenty-four languages beyond English and German (every one has its files since 1.11's join); 1.12's
 * join (P10) sets it false. test/languages.test.ts's join test reads this line.
 * 1.12 P10: false — group O (O1–O4, six languages each) worked the twenty-four lists to the ledger's end (121 entries) and
 * deleted them; no list is left, and every rule holds every key of all twenty-four languages and German again.
 */
export const PENDING_ALLOWED: boolean = false

/**
 * 1.11 A3 rule 11 (b): a language name a language writes as the English does — `[id, English name, reason]`. T10
 * refuses a translation of a language name equal to its English, except by this list; test/languages.test.ts's German
 * check takes the same list. Owned by 1.11 P1; the join (P8) extends it for a package's report, each with its reason,
 * never a package itself. Kept in test/helpers/nls.ts, which both tests import (a test file imported by another would
 * run its tests twice).
 */
export { LANGUAGE_NAME_AS_ENGLISH }

/**
 * 1.12 D10 (RL-brief-1, P1): the t() keys with a placeholder that receives a session's name — `[key, placeholder, form]`.
 * `full` is the name the Agents tree gives a session, beginning with the word for session: `sessionName` ("Session Tue
 * 14:20 · 9d0eb37a"), or `sessionIdName` ("Session 9d0eb37a") where the session has no first line; `short` is
 * `sessionShortName` ("Tue 14:20 · 9d0eb37a", 1.11's pre-freeze fix), for the Records, whose key says "session" itself.
 * 1.11's Review L found what a translation does wrong here — a word for session written before a full name (it reads
 * twice), an adjective or a pronoun that does not agree with the language's word for session (el), a case ending that
 * cannot attach to a placeholder (ru, cs, pl, uk) —, and no pattern judges gender or case (§7a Q27: no rule, a list): the
 * brief names every key of this list ("Session names and product names in placeholders"), and a test finds the list's
 * keys by the calls whose arguments carry a name (SESSION_NAME_CARRIERS). A package that adds such a key adds it here and
 * says so in its ledger `why`.
 */
export const SESSION_NAME_KEYS: ReadonlyArray<readonly [string, string, 'full' | 'short']> = [
  // keepWarmHost.ts, the keep-warm countdown: the tooltip and the screen reader's label (1.11 R4: el's gender; R8: the case
  // after a placeholder, ru and cs).
  ['Token Pace will type “{0}” into the terminal that runs {1} and press Enter, so that its prompt cache stays warm. Click to cancel.', '{1}', 'full'],
  ['Keep-warm line for {0} in {1} seconds, press to cancel', '{0}', 'full'],
  // statusText.ts, the prompt-cache entry's screen-reader label (1.11 R8: the case after a placeholder, ru and uk).
  ['Prompt cache of {0} cools in {1}', '{0}', 'full'],
  ['Prompt cache of {0} cools in {1}, and {2} more', '{0}', 'full'],
  ['Prompt cache of {0} cools in about {1} (estimated)', '{0}', 'full'],
  ['Prompt cache of {0} cools in about {1} (estimated), and {2} more', '{0}', 'full'],
  // cacheWatch.ts, a session's prompt-cache line — the card and the entry's tooltip (found by P1's scan, beyond the six
  // Review L named).
  ['{0} · prompt cache warm · cools in {1} (1 h TTL)', '{0}', 'full'],
  ['{0} · prompt cache warm · cools in ~{1} (1 h TTL, estimated from the transcript)', '{0}', 'full'],
  ['{0} · prompt cache cools in {1} (1 h TTL)', '{0}', 'full'],
  ['{0} · prompt cache cools in ~{1} (1 h TTL, estimated from the transcript)', '{0}', 'full'],
  ['{0} · prompt cache cold since {1} (1 h TTL)', '{0}', 'full'],
  ['{0} · prompt cache cold since ~{1} (1 h TTL, estimated from the transcript)', '{0}', 'full'],
  // textViews.ts, the Records' Quick Pick lines (1.11 B2, the pre-freeze fix).
  ['Longest session {0}: {1}', '{0}', 'short'],
  ['Largest session {0}: {1}', '{0}', 'short'],
]

/**
 * 1.12 D10 rule 2: where a session's name reaches a t() argument — `[file, expression, form, where the name comes from]`.
 * No t() call takes `sessionName(…)` or `sessionShortName(…)` itself: the name is made once and carried in a field, and
 * these are the expressions a call passes it by. The test scans every t() call of src/ — and every tr() call of the page
 * (1.12 R1-F5: SESSION_NAME_PAGE_FIELDS) — with the TypeScript parser: a call
 * whose argument holds one of these expressions (in its file), or a call of the three name functions, is a key of
 * SESSION_NAME_KEYS, and every key of the list is found so. The name functions' own call sites are pinned beside it
 * (SESSION_NAME_SOURCES): a new one is a name that may reach a t() argument by another expression.
 */
export const SESSION_NAME_CARRIERS: ReadonlyArray<readonly [string, string, 'full' | 'short', string]> = [
  ['src/keepWarmHost.ts', 'c.name', 'full', 'the countdown\'s `name`, a CacheWatchEntry\'s (cacheWatch.ts)'],
  ['src/statusText.ts', 'first.name', 'full', 'the first CacheWatchEntry\'s `name` (cacheWatch.ts)'],
  ['src/cacheWatch.ts', 'e.name', 'full', 'a CacheWatchEntry\'s `name` — `sessionName`, or `sessionIdName` without a first line'],
  ['src/textViews.ts', 's.name', 'short', 'a SessionRecord\'s `name` (stats.ts `words.sessionName`, which viewModel.ts binds to `sessionShortName`)'],
]

/**
 * 1.12 D10 rule 2: the calls of the name functions in src/ — `[file, callee, count]`, the definitions and comments not
 * counted. As a grep: grep -rnoE "\b(sessionName|sessionShortName|sessionIdName)\(" src --include=*.ts, less the three
 * `function` lines and the comments. Each call's name goes where the comment says; a new call is a name to trace.
 */
export const SESSION_NAME_SOURCES: ReadonlyArray<readonly [string, string, number]> = [
  // sessionName's own fallback, and the Agents tree's session row (`label`, `fullLabel`, `idName`: markup, no t()).
  ['src/agentTreeBuild.ts', 'sessionIdName', 2],
  ['src/agentTreeBuild.ts', 'sessionName', 1],
  // A CacheWatchEntry's `name` — SESSION_NAME_CARRIERS' c.name, first.name and e.name.
  ['src/cacheWatch.ts', 'sessionIdName', 1],
  ['src/cacheWatch.ts', 'sessionName', 1],
  // A SessionRecord's `name` — the Records' tables (markup, no t()) and SESSION_NAME_CARRIERS' s.name.
  ['src/stats.ts', 'sessionName', 1],
  // The preview's entries (statusText.ts previewCache) name their sessions with t('Session {0}', …) — the full form.
]

/**
 * 1.12 R1-F5 (the lead, after P10): the page's tr() calls are scanned like t() — src/webview/main.ts defines its own tr and
 * imports no t. A session's name reaches the page as markup, never as a tr() argument today: the Agents tree's rows carry
 * it in `label`, `fullLabel` and `idName` (agentTreeBuild.ts; the page's agentLabel/agentSpoken build markup from them),
 * the Records' tables in their row cells (recordsTable — markup). These are the expressions by which a name would reach a
 * tr() key — `[expression, where the name comes from]`; `label` alone is not one (a bar's, a budget's, a model's label are
 * tr() arguments today), so the tree item's and the agent payload's are named with their object. The test holds that no
 * tr() call passes one; a tr() key that takes one is a key of SESSION_NAME_KEYS with a carrier of its own (D10 rule 2).
 */
export const SESSION_NAME_PAGE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['fullLabel', 'a tree row\'s full name (agentTreeBuild.ts `fullLabel`; the page\'s agentLabel/agentSpoken read it)'],
  ['idName', 'a tree row\'s id name (agentTreeBuild.ts `idName`)'],
  ['it.label', 'a tree item\'s label — `it` in the page\'s tree renderers (agentLabel({ label: it.label, fullLabel: it.fullLabel, … }))'],
  ['n.label', 'an agent payload\'s label — `n` in agentLabel(n, kind) and agentSpoken(n, …)'],
]

// ---------------------------------------------------------------------------
// What a language is measured against: the English source and the German reference
// ---------------------------------------------------------------------------

const PARTS = ['dashboard', 'host', 'model', 'text'] as const
type Part = typeof PARTS[number]

interface Source {
  /** Every t() key of src/, as scripts/l10n-extract.mjs reads them. */
  keys: string[]
  /** package.nls.json. */
  english: Record<string, string>
  /** The key set of each German part: the shape every language's parts mirror (§3 B1). */
  germanParts: Record<Part, string[]>
  /** The keys of webviewWords(): the page's own words, concatenated into markup. */
  pageWords: string[]
  /** languageName() of every id with no bundle installed: the registry's names in English. */
  names: Array<{ id: string; english: string }>
  /** weekdayWords() with no bundle installed: 'Sun' … 'Sat'. */
  weekdays: string[]
}

const readTable = (file: string): Record<string, string> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>

/** The seam is module state; every test that installs a bundle puts it back. */
function pristine(): void {
  setBundle(undefined)
  setLocale(undefined)
  setLang(undefined)
}

/** dashboard.ts imports `vscode`; the module is required behind the stub dashboard.test.ts uses. */
function pageWordKeys(): string[] {
  const mod = require('node:module')
  if (!mod._load.stubbed) {
    const original = mod._load
    const load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') return { commands: { executeCommand: () => undefined } }
      return original.call(this, request, parent, isMain)
    }
    load.stubbed = true
    mod._load = load
  }
  const { pageWords } = require('../src/dashboard') as typeof import('../src/dashboard')
  pristine()
  return Object.keys(pageWords().dict)
}

let source: Source | null = null
function src(): Source {
  if (source) return source
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'l10n-extract.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `l10n-extract failed:\n${r.stderr}`)
  const keys = Object.keys((JSON.parse(r.stdout) as { keys: Record<string, string[]> }).keys)
  const germanParts = {} as Record<Part, string[]>
  for (const part of PARTS) germanParts[part] = Object.keys(readTable(join(ROOT, 'l10n', 'parts', `${part}.de.json`)))
  pristine()
  source = {
    keys,
    english: readTable(join(ROOT, 'package.nls.json')),
    germanParts,
    pageWords: pageWordKeys(),
    names: LANGUAGES.map((e) => ({ id: e.id, english: languageName(e.id) })),
    weekdays: weekdayWords(),
  }
  return source
}

// ---------------------------------------------------------------------------
// The files of one language
// ---------------------------------------------------------------------------

interface LangFiles {
  id: string
  root: string
  bundle: Record<string, string> | null
  parts: Partial<Record<string, Record<string, string>>>
  nls: Record<string, string> | null
  /** Files that exist but do not parse as a JSON object. */
  unreadable: string[]
  /** 1.10 B1: l10n/pending/<id>.json as read, or null when the language has none (nothing left to do). */
  pending: Pending | null
  /** The number of entries of l10n/rekey.json beside it, or null where there is no ledger. */
  ledger: number | null
  /** PENDING_ALLOWED, or what a test asks for: whether the rules read the pending list at all. */
  pendingAllowed: boolean
}

/** 1.10 B1: a bundle key on a language's pending list — the parts it is listed for, and what is left to do there. */
interface PendingKey { parts: string[]; state: 'translate' | 'review'; why: string }
/** 1.10 B1: l10n/pending/<id>.json, as scripts/l10n-rekey.mjs writes it. */
interface Pending {
  v: number
  /** How many entries of l10n/rekey.json are applied to the language's files. */
  applied: number
  bundle: Record<string, PendingKey>
  nls: Record<string, { state: 'translate' | 'review'; why: string }>
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const PENDING_FILE = (id: string): string => `l10n/pending/${id}.json`

/** The pending entry of a bundle key — only while the rules read the list, and only a well-formed one. */
function pendingKey(l: LangFiles, key: string): PendingKey | null {
  if (!l.pendingAllowed || !l.pending || !isTable(l.pending.bundle) || !own(l.pending.bundle, key)) return null
  const e = l.pending.bundle[key]
  return isTable(e) && Array.isArray(e.parts) ? e : null
}
/** A key the language has not translated yet: listed `translate` — for `part`, when one is named. */
const translatePending = (l: LangFiles, key: string, part?: string): boolean => {
  const e = pendingKey(l, key)
  return e !== null && e.state === 'translate' && (part === undefined || e.parts.includes(part))
}
/** A manifest key the language has not translated or reviewed yet. */
const nlsPending = (l: LangFiles, key: string): boolean =>
  l.pendingAllowed && l.pending !== null && isTable(l.pending.nls) && own(l.pending.nls, key)

/** `host.pt-br.json` → part and id — the rule scripts/merge-l10n.mjs names a part by. */
const PART_FILE = /^([A-Za-z0-9_-]+)\.([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\.json$/

function readObject(file: string, unreadable: string[], label: string): Record<string, string> | null {
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, string>
  } catch { /* named below */ }
  unreadable.push(label)
  return null
}

function loadLang(root: string, id: string, pendingAllowed: boolean = PENDING_ALLOWED): LangFiles {
  const unreadable: string[] = []
  const parts: Partial<Record<string, Record<string, string>>> = {}
  const partsDir = join(root, 'l10n', 'parts')
  for (const f of existsSync(partsDir) ? readdirSync(partsDir).sort() : []) {
    const m = PART_FILE.exec(f)
    if (!m || m[2] !== id) continue
    const table = readObject(join(partsDir, f), unreadable, `l10n/parts/${f}`)
    if (table) parts[m[1]] = table
  }
  const pending = readObject(join(root, PENDING_FILE(id)), unreadable, PENDING_FILE(id)) as unknown as Pending | null
  let ledger: number | null = null
  const ledgerFile = join(root, 'l10n', 'rekey.json')
  if (existsSync(ledgerFile)) {
    try {
      const entries = (JSON.parse(readFileSync(ledgerFile, 'utf8')) as { entries?: unknown }).entries
      if (Array.isArray(entries)) ledger = entries.length
    } catch { /* --check and the ledger's test name it */ }
  }
  return {
    id,
    root,
    bundle: readObject(join(root, 'l10n', `bundle.l10n.${id}.json`), unreadable, `l10n/bundle.l10n.${id}.json`),
    parts,
    nls: readObject(join(root, `package.nls.${id}.json`), unreadable, `package.nls.${id}.json`),
    unreadable,
    pending,
    ledger,
    pendingAllowed,
  }
}

/** Every language with a file on disk — a bundle, a part, a manifest translation or a record — in the registry's order. */
function languagesOnDisk(root: string = ROOT): string[] {
  const ids = new Set<string>()
  const add = (dir: string, re: RegExp, group = 1): void => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) { const m = re.exec(f); if (m) ids.add(m[group]) }
  }
  add(join(root, 'l10n'), /^bundle\.l10n\.(.+)\.json$/)
  add(root, /^package\.nls\.(.+)\.json$/)
  add(join(root, 'l10n', 'parts'), PART_FILE, 2)
  add(join(root, 'l10n', 'nls-sources'), /^(.+)\.json$/)
  add(join(root, 'l10n', 'pending'), /^(.+)\.json$/)
  const order = (id: string): number => { const i = (LANGUAGE_IDS as readonly string[]).indexOf(id); return i < 0 ? 999 : i }
  return [...ids].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Small tools
// ---------------------------------------------------------------------------

const J = (x: unknown): string => JSON.stringify(x)
const count = (s: string, needle: string): number => s.split(needle).length - 1
const sorted = (xs: string[]): string[] => [...xs].sort()
/** The entries of a bundle a rule reads: every key the bundle translates. */
const entries = (t: Record<string, string> | null): Array<[string, string]> =>
  t ? Object.entries(t).filter((e): e is [string, string] => typeof e[1] === 'string') : []
/**
 * The manifest's entries beside the English: [key, English, translation]. 1.10 B1: a key on the language's pending list
 * is left out — its value is the English (added) or a translation of the English before the change (reworded), so the
 * rules that compare a value with today's English (T3, T4, T5, T7, T9) have nothing to say about it until it is done.
 */
function nlsEntries(s: Source, l: LangFiles): Array<[string, string, string]> {
  if (!l.nls) return []
  return Object.entries(s.english).filter(([k]) => typeof l.nls![k] === 'string' && !nlsPending(l, k)).map(([k, en]) => [k, en, l.nls![k]])
}

const placeholders = (s: string): string[] => sorted([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[0]))
const MARKS = ['~', '⚠', '≈', '–', '%', '×', '→', '·'] as const
const NLS_MARKS = ['~', '⚠', '≈', '–'] as const
const withoutFences = (s: string): string => s.replace(/```[\s\S]*?```/g, ' ')
const spans = (s: string): string[] => sorted([...withoutFences(s).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))
const ids = (s: string): string[] => sorted([...s.matchAll(/tokenPace\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g)].map((m) => m[0]))
const codicons = (s: string): string[] => sorted([...s.matchAll(/\$\([a-z0-9-]+(?:~[a-z]+)?\)/g)].map((m) => m[0]))
const commandTargets = (s: string): string[] => sorted([...s.matchAll(/command:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)].map((m) => m[1]))
const settingLinks = (s: string): string[] => sorted([...s.matchAll(/#(tokenPace\.[\w.]+)#/g)].map((m) => m[1]))
const commandLinks = (s: string): string[] => sorted([...s.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1]))
const jsonBlocks = (s: string): string[] => [...s.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
const paragraphs = (s: string): number => s.split('\n\n').length

const reEsc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * 1.12 D4 (L1-O2): a name of SAME_IN_EVERY_LANGUAGE as a pattern that takes any run of whitespace for each of its spaces —
 * a hard-wrapped text ("…as Claude\nCode's status line", the status-line consent's English) breaks a name where the
 * line ends, and "Claude\nCode" is the name "Claude Code" still, never the name Claude and the English word Code.
 */
const namePattern = (name: string): string => reEsc(name).replace(/ /g, '\\s+')

/**
 * What stands in a text as code or as a name, never as a word of its language: fences, backtick
 * spans, placeholders, addresses, command targets, setting ids and links, codicons, paths, file
 * names, model ids, the fixed forms that start with a digit (`2h14m`, `12.5K`, a hash) and the words
 * of SAME_IN_EVERY_LANGUAGE — a name of several words also across a line break (1.12 D4). T9 takes these out before it
 * compares; the pseudo-translation keeps them as they are.
 */
const PROTECTED = new RegExp([
  '```[\\s\\S]*?```',
  '`[^`\\n]*`',
  '\\{\\d+\\}',
  'https?://[^\\s)]+',
  '\\(command:[^)\\s]*\\)',
  'command:[\\w.]+',
  '#?tokenPace\\.[\\w.]+#?',
  '\\$\\([\\w~-]+\\)',
  '(?:~|%[A-Za-z]+%|[A-Za-z]:)?(?:[\\\\/][\\w.<>*~-]+)+[\\\\/]?',
  '[\\w.<>-]*\\.(?:jsonl?|md|m?js|ts|lock|key|csv|toml|txt|log|vsix|sh|ps1|exe)\\b[\\w.<>-]*',
  '\\b(?:claude|gpt|codex|o\\d)-[\\w.-]+',
  '\\d[\\w.,:]*',
  `(?<![\\p{L}\\p{N}])(?:${[...SAME_IN_EVERY_LANGUAGE.map(([w]) => w)].sort((a, b) => b.length - a.length).map(namePattern).join('|')})(?![\\p{L}\\p{N}])`,
].join('|'), 'gu')

/** The words of a text once its code and names are out: runs of letters, two or more. */
function wordsOf(s: string): string[] {
  return (s.replace(PROTECTED, ' ').match(/[\p{L}\p{M}]+/gu) ?? []).filter((w) => [...w].length >= 2)
}
/** Latin letters, the accented ones among them — not × (U+00D7) or ÷ (U+00F7), which stand in that block. */
const LATIN_LETTERS = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF'
const LATIN_WORD = new RegExp(`^[${LATIN_LETTERS}]+$`, 'u')

/** T9, Latin script: the key never its own translation (three words or more), and no four words of it in a row. */
function latinLeft(key: string, value: string): string | null {
  const k = wordsOf(key).map((w) => w.toLowerCase())
  if (k.length >= 3 && value === key) return 'is its own key'
  const v = ` ${wordsOf(value).map((w) => w.toLowerCase()).join(' ')} `
  for (let i = 0; i + 4 <= k.length; i++) {
    const run = k.slice(i, i + 4).join(' ')
    if (v.includes(` ${run} `)) return `keeps four English words in a row: "${run}"`
  }
  return null
}

/**
 * T9, another script: no run of three Latin words of two letters or more. A one-letter token neither counts nor breaks a run.
 * 1.10 B1 (forLead 3, §7a Q19): a × or ÷ between two Latin words ends the run — `scope × period × unit` names three code
 * words of a JSON example the way the English does, `scope period unit` is English left; no other mark breaks a run.
 */
function nonLatinLeft(value: string): string | null {
  const tokens = value.replace(PROTECTED, ' ').match(/[\p{L}\p{M}]+|[×÷]/gu) ?? []
  let run: string[] = []
  for (const tok of tokens) {
    if (tok === '×' || tok === '÷') {
      run = []
    } else if (LATIN_WORD.test(tok)) {
      if ([...tok].length < 2) continue
      run.push(tok)
      if (run.length >= 3) return `keeps three Latin words in a row: "${run.join(' ')}"`
    } else {
      run = []
    }
  }
  return null
}

/** T9: a key of FIELD_IDS_OF_A_KEY, and its value, with the listed ids taken out — whole words, whatever stands around them. */
const FIELD_IDS: ReadonlyMap<string, RegExp> = new Map(FIELD_IDS_OF_A_KEY.map(([k, ids]) => [k, new RegExp(`(?<![\\p{L}\\p{N}])(?:${ids.map(reEsc).join('|')})(?![\\p{L}\\p{N}])`, 'gu')]))
function withoutFieldIds(key: string, value: string): [string, string] {
  const re = FIELD_IDS.get(key)
  return re ? [key.replace(re, ' '), value.replace(re, ' ')] : [key, value]
}

/**
 * The quotation marks a {n} may stand between (T11), and an example between (T15), in any language of the registry.
 * 1.11 A3 rule 3: ” opens too — Swedish and Finnish write ”…” (and »…», which 1.10's sets read already: » was an
 * opening and a closing mark since 1.9, for Danish »…« and the «…» of the others). The examples and the quoted {n} of
 * the files on disk are the same with 1.10's openers and these (a test).
 */
export const OPEN_QUOTES = '“"„«‹「『‘\'‚»›”'
export const CLOSE_QUOTES = '”"“»›」』’\'‘«‹'
/** 1.11 A3 rule 3: the opening marks as 1.10 had them — the test that the files on disk read the same compares with them. */
const OPEN_QUOTES_1_10 = '“"„«‹「『‘\'‚»›'
function quoted(s: string, ph: string, open: string = OPEN_QUOTES, close: string = CLOSE_QUOTES): boolean {
  return new RegExp(`[${reEsc(open)}][\\u00a0\\u202f ]?${reEsc(ph)}[\\u00a0\\u202f ]?[${reEsc(close)}]`).test(s)
}

/**
 * 1.11 A3 rule 2: what T13 counts — grapheme clusters, the characters a reader sees. Hindi's short weekday शुक्र is two
 * of them and five code points; for every language of 1.10 the two counts are equal (a test).
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const graphemes = (s: string): number => [...GRAPHEMES.segment(s)].length

/**
 * 1.11 A3 rule 6: the Greek ano teleia. Its canonical decomposition is the middle dot, so NFC — which an editor or a tool
 * may apply to a file — turns U+0387 into U+00B7, the separator T4 counts. T4 therefore counts the marks of the NFC form
 * and names the ano teleia itself: Greek writes a comma or a full stop inside a sentence, never the ano teleia.
 */
export const ANO_TELEIA = '\u0387'

function installed<T>(bundle: Record<string, string> | null, run: () => T): T {
  try {
    setBundle(bundle ?? {})
    return run()
  } finally {
    pristine()
  }
}

const noMemento: MementoLike = { get: <T>(_key: string, fallback: T): T => fallback, update: () => Promise.resolve() }

// ---------------------------------------------------------------------------
// T15 (1.10 B3): the bar's own examples — the documented fixture every example in the settings is built from
// ---------------------------------------------------------------------------

/**
 * The fixture (also in l10n/TRANSLATING.md, T15): Monday 2026-09-28, 03:46 UTC, the time zone UTC. Claude Code's 5 h
 * window is at 25 % with its reset 2 h 14 min away (06:00), its 7 d window at 69 % with exactly 6 days left; 3.1M
 * tokens today, 12.3M in the last 7 days, 48.9M in the last 30 (fresh input, Claude Code only). The settings each
 * example shows: the reset formats and the hour cycles without a bar (`barWidth` 0), the `full` density with a bar of
 * width 8 and no time marker (`timeProgressStyle` none), the `compact` density over both windows (`windowSelect` all);
 * the weekday example is the same reset read two days before it (Saturday 06:00), and the `minimal` example the 5 h
 * window alone (`windowSelect` session) read at 01:30 — a tenth of its clock gone, so 25 % runs ahead of the pace (▲).
 * 1.12 D5: the `budget` example is one budget of the reader's own — Claude Code's tokens today against a daily limit of
 * 4.92M (`tokenPace.budgets`), so the 3.1M of today are 63 %, the figure the bar prints as `63%`.
 */
export const BAR_FIXTURE = {
  now: Date.UTC(2026, 8, 28, 3, 46),
  reset: Date.UTC(2026, 8, 28, 6, 0),
  weekdayAt: Date.UTC(2026, 8, 26, 6, 0),
  paceAt: Date.UTC(2026, 8, 28, 1, 30),
  tokens: { today: 3_100_000, '7d': 12_300_000, '30d': 48_900_000 },
  budget: { scope: 'claude', period: 'day', unit: 'tokens', limit: 4_920_000 },
} as const
const DAY_MS = 86_400_000

/** One way the bar is set up for an example: its settings, and the moment it is read. */
/** `bare`: the example may quote the 5 h window's reset alone (the hour-cycle keys: “06:00 AM”), not a whole item text. */
interface BarVariant { settings: Record<string, unknown>; at?: number; bare?: boolean }
const NO_BAR = { 'tokenPace.barWidth': 0 }
/**
 * The manifest keys whose values quote the bar (1.10 B3): each with the settings its examples show. Every example
 * quoted in a value must be a text the bar builds under one of them (BAR_EXEMPT names none).
 */
export const BAR_EXAMPLE_KEYS: Readonly<Record<string, readonly BarVariant[]>> = {
  'config.resetFormat.enum.relative': [{ settings: { ...NO_BAR, 'tokenPace.resetFormat': 'relative' } }],
  'config.resetFormat.enum.absolute': [
    { settings: { ...NO_BAR, 'tokenPace.resetFormat': 'absolute' } },
    { settings: { ...NO_BAR, 'tokenPace.resetFormat': 'absolute' }, at: BAR_FIXTURE.weekdayAt },
  ],
  'config.resetFormat.enum.both': [{ settings: { ...NO_BAR, 'tokenPace.resetFormat': 'both' } }],
  'config.density.enum.full': [{ settings: { 'tokenPace.density': 'full', 'tokenPace.barWidth': 8, 'tokenPace.timeProgressStyle': 'none' } }],
  'config.density.enum.compact': [{ settings: { 'tokenPace.density': 'compact' } }],
  'config.density.enum.minimal': [{ settings: { 'tokenPace.density': 'minimal', 'tokenPace.windowSelect': 'session' }, at: BAR_FIXTURE.paceAt }],
  'config.summary.period.enum.today': [{ settings: { 'tokenPace.summary.period': 'today' } }],
  'config.summary.period.enum.7d': [{ settings: { 'tokenPace.summary.period': '7d' } }],
  'config.summary.period.enum.30d': [{ settings: { 'tokenPace.summary.period': '30d' } }],
  'config.resetHourCycle.enum.h12': [{ settings: { ...NO_BAR, 'tokenPace.resetFormat': 'absolute', 'tokenPace.resetHourCycle': 'h12' }, bare: true }],
  'config.resetHourCycle.enum.h23': [{ settings: { ...NO_BAR, 'tokenPace.resetFormat': 'absolute', 'tokenPace.resetHourCycle': 'h23' }, bare: true }],
  // 1.12 D5: the budget entry's figure is the bar's notation, as the quota entries' is.
  'config.statusBar.show.enum.budget': [{ settings: { 'tokenPace.statusBar.show': ['budget'], 'tokenPace.budgets': [BAR_FIXTURE.budget] } }],
}
/** An example no fixture can produce, `<id>: <key>: <example>` with its reason — expected: none. */
export const BAR_EXEMPT: ReadonlyArray<readonly [string, string]> = []

/** The Claude Code reading of the fixture, fetched a minute before the moment the bar is read. */
function barQuotas(now: number): QuotaState[] {
  const win = (p: Partial<QuotaWindow>): QuotaWindow => ({
    id: 'session:300', kind: 'session', label: '5 h', shortLabel: '5h', model: null, percent: 25,
    resetsAt: BAR_FIXTURE.reset, windowMinutes: 300, limitReached: false, unlimited: false, ...p,
  })
  return [{
    source: 'claude', ok: true, origin: 'poll', fetchedAt: Math.floor(now / 1000) - 60, planType: 'max20',
    windows: [win({}), win({
      id: 'weekly:10080', kind: 'weekly', label: '7 d', shortLabel: '7d', percent: 69,
      resetsAt: BAR_FIXTURE.now + 6 * DAY_MS, windowMinutes: 10080,
    })],
  }]
}

/** The hour buckets of the fixture: the period's tokens as fresh input, told apart by the days the bar asks for. */
function barUsage(): UsageSource {
  const bucket = (tokens: number): ReturnType<typeof emptyBucket> => {
    const b = emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-28')
    b.input = tokens
    return b
  }
  return {
    sum: (from: string, to: string, _tcfg: unknown, filter?: { source?: string }) => {
      if (filter?.source !== 'claude') return bucket(0)
      const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
      return bucket(days === 1 ? BAR_FIXTURE.tokens.today : days === 7 ? BAR_FIXTURE.tokens['7d'] : days === 30 ? BAR_FIXTURE.tokens['30d'] : 0)
    },
    cost: () => ({ usd: 0, listUsd: 0, unpricedTokens: 0, unpricedModels: [], fastUnpricedTokens: 0, familyPriced: [], custom: false }),
  } as UsageSource
}

/**
 * 1.12 D5: the budget rows of the variant's `tokenPace.budgets`, as the view model builds them for the bar (`budgetRows`
 * over every provider) — the fixture's tokens of today in one day bucket of 2026-09-28. None without a budget.
 */
function barBudgets(cfg: ReturnType<typeof sanitize>, now: number): ReturnType<typeof budgetRows> {
  const today = emptyBucket('claude', 'claude-opus-4-6', false, 'standard', 'd', null, '2026-09-28')
  today.input = BAR_FIXTURE.tokens.today
  const agg = { ...barUsage(), all: () => [today] } as unknown as StatsCtx['agg']
  const ctx: StatsCtx = { agg, tcfg: readTimeConfig(cfg), pricing: {}, now, sources: ['claude', 'codex'], models: [], showCost: cfg.showCost }
  return budgetRows(ctx, cfg.budgets, now)
}

/**
 * The texts the bar builds for one variant: every item's text, the tail of each from a `· ` on (an example that
 * quotes the reset part alone, “· resets at Mo 06:00”), and the 5 h window's reset as the item prints it (“06:00 AM”).
 */
function barTexts(v: BarVariant): string[] {
  const now = v.at ?? BAR_FIXTURE.now
  const cfg = sanitize({ 'tokenPace.timezone': 'utc', 'tokenPace.resetHourCycle': 'h23', 'tokenPace.windowSelect': 'all',
    'tokenPace.statusBar.show': ['claudeQuota', 'tokens'], ...v.settings })
  const input = { quotas: barQuotas(now), agg: barUsage(), cfg, now, forecasts: new Map(), role: 'single' as const, scanning: false, consent: 'granted' as const,
    budgets: barBudgets(cfg, now) }
  const out: string[] = []
  for (const item of buildItems(input)) {
    out.push(item.text)
    for (let at = item.text.indexOf('· '); at > 0; at = item.text.indexOf('· ', at + 1)) out.push(item.text.slice(at))
  }
  // The bare reset only where the key's example quotes it alone (Review 1a F5): a relative or absolute example must
  // be a whole item text, so “2h14m” or “06:00” alone would not pass for them.
  if (v.bare) out.push(formatReset(BAR_FIXTURE.reset, now, cfg.resetFormat, makeContext(input).tcfg))
  return out
}

/** U+00A0 and U+202F read as a space (1.10 B3): Intl writes them, a manifest may write a plain space. */
const barSpaces = (s: string): string => s.replace(/[  ]/g, ' ').trim()
/**
 * The examples a value quotes: the text between two of T11's quotation marks. An apostrophe between two letters
 * (aujourd’hui, dell’ora) is a letter of the word, not a closing mark (1.10 P8's finding): it is masked before the
 * scan and put back in the example.
 */
export function quotedExamples(value: string, open: string = OPEN_QUOTES, close: string = CLOSE_QUOTES): string[] {
  const marks = reEsc(open + close)
  const masked = value.replace(/(?<=\p{L})’(?=\p{L})/gu, '\uE000').replace(/(?<=\p{L})'(?=\p{L})/gu, '\uE001')
  return [...masked.matchAll(new RegExp(`[${reEsc(open)}]([^${marks}]+)[${reEsc(close)}]`, 'g'))]
    .map((m) => barSpaces(m[1].replace(/\uE000/g, '’').replace(/\uE001/g, "'")))
}

/**
 * T15 over one language's manifest: every example of the keys BAR_EXAMPLE_KEYS names equals a text the bar builds
 * for the fixture under the language's bundle and locale, and a value quotes as many examples as the English. `skip`:
 * a key on the language's pending list (the ledger changed its English; the language's package writes it again).
 */
export function barExampleProblems(id: string, file: string, nls: Record<string, string>, bundle: Record<string, string> | null,
  skip: (key: string) => boolean = () => false): string[] {
  const out: string[] = []
  const english = src().english
  const locale = isLanguageId(id) ? languageEntry(id).locale : id
  try {
    setBundle(bundle ?? {})
    setLocale(locale)
    setLang(id)
    for (const [key, variants] of Object.entries(BAR_EXAMPLE_KEYS)) {
      if (skip(key) || typeof nls[key] !== 'string') continue
      const examples = quotedExamples(nls[key])
      const want = quotedExamples(english[key] ?? '').length
      if (examples.length !== want) out.push(`${id}: ${file}: ${key} quotes ${examples.length} example(s), the English ${want}: ${J(nls[key])}`)
      const texts = new Set(variants.flatMap((v) => barTexts(v)).map(barSpaces))
      for (const ex of examples) {
        if (texts.has(ex) || BAR_EXEMPT.some(([at]) => at === `${id}: ${key}: ${ex}`)) continue
        out.push(`${id}: ${file}: ${key} quotes ${J(ex)}, and the bar prints ${J([...texts][0])} (fixture: l10n/TRANSLATING.md, T15)`)
      }
    }
  } finally {
    pristine()
  }
  return out
}

// ---------------------------------------------------------------------------
// The rules — each returns the problems it found, every one naming the language, the file and the key
// ---------------------------------------------------------------------------

type Rule = (s: Source, l: LangFiles) => string[]
const BUNDLE = (l: LangFiles): string => `l10n/bundle.l10n.${l.id}.json`
const NLS = (l: LangFiles): string => `package.nls.${l.id}.json`

const RULES: Record<string, { title: string; rule: Rule }> = {
  T1: {
    title: 'the keys — the bundle\'s are the extracted t() keys, no more, no less; the manifest\'s are package.nls.json\'s, in its order',
    rule: (s, l) => {
      const out = l.unreadable.map((f) => `${l.id}: ${f} is not a JSON object`)
      if (!l.bundle) out.push(`${l.id}: ${BUNDLE(l)} is missing`)
      else {
        const have = new Set(Object.keys(l.bundle))
        const want = new Set(s.keys)
        // 1.10 B1: a key the language has not translated yet is absent while it is listed `translate`; one listed for review is there.
        for (const k of s.keys) if (!have.has(k) && !translatePending(l, k)) out.push(`${l.id}: ${BUNDLE(l)}: no translation of ${J(k)}`)
        for (const k of Object.keys(l.bundle)) if (!want.has(k)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} is no key of src/ (any more)`)
        for (const k of s.keys) {
          if (!have.has(k) && pendingKey(l, k)?.state === 'review') out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} is listed for review in ${PENDING_FILE(l.id)}, and the bundle has no value for it`)
        }
      }
      if (!l.nls) out.push(`${l.id}: ${NLS(l)} is missing`)
      else {
        const en = Object.keys(s.english)
        const have = Object.keys(l.nls)
        for (const k of en) if (!(k in l.nls)) out.push(`${l.id}: ${NLS(l)}: no translation of ${k}`)
        for (const k of have) if (!(k in s.english)) out.push(`${l.id}: ${NLS(l)}: ${k} is no key of package.nls.json`)
        const common = have.filter((k) => k in s.english)
        const order = en.filter((k) => k in l.nls!)
        const at = common.findIndex((k, i) => k !== order[i])
        if (at >= 0) out.push(`${l.id}: ${NLS(l)}: ${common[at]} stands where package.nls.json has ${order[at]} — the keys are not in its order`)
      }
      return out
    },
  },
  T2: {
    title: 'the parts — the four part files, each with exactly the German part\'s keys',
    rule: (s, l) => {
      const out: string[] = []
      for (const name of Object.keys(l.parts)) {
        if (!(PARTS as readonly string[]).includes(name)) out.push(`${l.id}: l10n/parts/${name}.${l.id}.json is no part the German has`)
      }
      for (const part of PARTS) {
        const table = l.parts[part]
        const file = `l10n/parts/${part}.${l.id}.json`
        if (!table) { out.push(`${l.id}: ${file} is missing`); continue }
        const want = new Set(s.germanParts[part])
        // 1.10 B1: minus the part's keys the language has not translated yet (listed `translate` for this part).
        for (const k of s.germanParts[part]) {
          if (!(k in table) && !translatePending(l, k, part)) out.push(`${l.id}: ${file}: no translation of ${J(k)} (l10n/parts/${part}.de.json has it)`)
        }
        for (const k of Object.keys(table)) if (!want.has(k)) out.push(`${l.id}: ${file}: ${J(k)} is not in l10n/parts/${part}.de.json`)
      }
      return out
    },
  },
  T3: {
    title: 'the placeholders — every value keeps the {n} of its key, each as often',
    rule: (s, l) => [
      ...entries(l.bundle).filter(([k, v]) => J(placeholders(v)) !== J(placeholders(k)))
        .map(([k, v]) => `${l.id}: ${BUNDLE(l)}: ${J(k)} has ${J(placeholders(v))}, its key ${J(placeholders(k))}`),
      ...nlsEntries(s, l).filter(([, en, v]) => J(placeholders(v)) !== J(placeholders(en)))
        .map(([k, en, v]) => `${l.id}: ${NLS(l)}: ${k} has ${J(placeholders(v))}, the English ${J(placeholders(en))}`),
    ],
  },
  T4: {
    title: 'the marks — ~ ⚠ ≈ – % × → · as often as the key (the manifest: ~ ⚠ ≈ –); ASCII ~, never ～; no Greek ano teleia, which NFC makes a ·',
    rule: (s, l) => {
      const out: string[] = []
      // 1.11 A3 rule 6: the marks of the NFC form — a Greek ano teleia (U+0387) is the separator · there, and counts so.
      const nfc = (x: string): string => x.normalize('NFC')
      const teleia = (file: string, key: string): string => `${l.id}: ${file}: ${key} writes the Greek ano teleia (U+0387), which NFC makes the separator · — write a comma or a full stop`
      for (const [k, v] of entries(l.bundle)) {
        for (const m of MARKS) if (count(nfc(v), m) !== count(nfc(k), m)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} has ${count(nfc(v), m)} × ${m}, its key ${count(nfc(k), m)}`)
        if (v.includes('～') || v.includes('・')) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} writes ～ or ・ for ~ or ·`)
        if (v.includes(ANO_TELEIA)) out.push(teleia(BUNDLE(l), J(k)))
      }
      for (const [k, en, v] of nlsEntries(s, l)) {
        for (const m of NLS_MARKS) if (count(nfc(v), m) !== count(nfc(en), m)) out.push(`${l.id}: ${NLS(l)}: ${k} has ${count(nfc(v), m)} × ${m}, the English ${count(nfc(en), m)}`)
        if (v.includes('～')) out.push(`${l.id}: ${NLS(l)}: ${k} writes ～ for ~`)
        if (v.includes(ANO_TELEIA)) out.push(teleia(NLS(l), k))
      }
      return out
    },
  },
  T5: {
    title: 'the code — backtick spans, tokenPace ids, codicons, command targets and paragraphs as the key has them; the manifest\'s links, fences and JSON examples too',
    rule: (s, l) => {
      const out: string[] = []
      const same = (what: string, f: (x: string) => unknown, file: string, key: string, en: string, v: string): void => {
        if (J(f(v)) !== J(f(en))) out.push(`${l.id}: ${file}: ${key} — the ${what} differ: ${J(f(v))}, the English ${J(f(en))}`)
      }
      for (const [k, v] of entries(l.bundle)) {
        const key = J(k)
        same('backtick spans', spans, BUNDLE(l), key, k, v)
        same('tokenPace ids', ids, BUNDLE(l), key, k, v)
        same('codicons', codicons, BUNDLE(l), key, k, v)
        same('command targets', commandTargets, BUNDLE(l), key, k, v)
        same('paragraphs', paragraphs, BUNDLE(l), key, k, v)
      }
      const words = new Set(NLS_SPANS_READ_AS_WORDS.map(([w]) => w))
      for (const [k, en, v] of nlsEntries(s, l)) {
        same('setting links', settingLinks, NLS(l), k, en, v)
        same('command links', commandLinks, NLS(l), k, en, v)
        same('fences', (x) => count(x, '```'), NLS(l), k, en, v)
        same('paragraphs', paragraphs, NLS(l), k, en, v)
        same('JSON examples', jsonBlocks, NLS(l), k, en, v)
        same('tokenPace ids', ids, NLS(l), k, en, v)
        same('codicons', codicons, NLS(l), k, en, v)
        same('command targets', commandTargets, NLS(l), k, en, v)
        // Every span that is code stays; a span that is words may be translated, but none is dropped or added.
        const have = spans(v)
        const code = spans(en).filter((x) => !words.has(x))
        const left = [...have]
        const lost = code.filter((x) => { const i = left.indexOf(x); if (i < 0) return true; left.splice(i, 1); return false })
        if (lost.length > 0 || have.length !== spans(en).length) {
          out.push(`${l.id}: ${NLS(l)}: ${k} — the backtick spans differ: ${J(have)}, the English ${J(spans(en))}${lost.length ? ` (lost: ${J(lost)})` : ''}`)
        }
      }
      return out
    },
  },
  T6: {
    title: 'the page\'s words — no <, >, " or & in a translation of a webviewWords() key',
    rule: (s, l) => s.pageWords.filter((k) => typeof l.bundle?.[k] === 'string' && /[<>"&]/.test(l.bundle[k]))
      .map((k) => `${l.id}: ${BUNDLE(l)}: ${J(k)} is a word of the page and its translation carries markup: ${J(l.bundle![k])}`),
  },
  T7: {
    title: 'the tone — no exclamation mark (! ¡ ！) in any value; the manifest keeps only the English\'s own',
    rule: (s, l) => [
      ...entries(l.bundle).filter(([, v]) => /[!¡！]/.test(v)).map(([k, v]) => `${l.id}: ${BUNDLE(l)}: ${J(k)} exclaims: ${J(v)}`),
      ...nlsEntries(s, l).filter(([, en, v]) => /[¡！]/.test(v) || count(v, '!') !== count(en, '!'))
        .map(([k]) => `${l.id}: ${NLS(l)}: ${k} exclaims where the English does not`),
    ],
  },
  T8: {
    title: 'the tables — a key that starts with "| " keeps its pipes',
    rule: (s, l) => entries(l.bundle).filter(([k, v]) => k.startsWith('| ') && count(v, '|') !== count(k, '|'))
      .map(([k, v]) => `${l.id}: ${BUNDLE(l)}: ${J(k)} has ${count(v, '|')} pipes, its key ${count(k, '|')}`),
  },
  T9: {
    title: 'no English left — proper names and code excepted',
    rule: (s, l) => {
      const out: string[] = []
      const left = (en: string, v: string): string | null => {
        const [key, value] = withoutFieldIds(en, v)
        return NON_LATIN.has(l.id) ? nonLatinLeft(value) : latinLeft(key, value)
      }
      for (const [k, v] of entries(l.bundle)) {
        const why = left(k, v)
        if (why) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} ${why}`)
      }
      for (const [k, en, v] of nlsEntries(s, l)) {
        if (en.length >= 40 && v === en) { out.push(`${l.id}: ${NLS(l)}: ${k} is still the English text`); continue }
        const why = left(en, v)
        if (why) out.push(`${l.id}: ${NLS(l)}: ${k} ${why}`)
      }
      return out
    },
  },
  T10: {
    title: 'the registry — the files name a shipped language; its language names translated, the native names and the product\'s name as they are',
    rule: (s, l) => {
      const out: string[] = []
      if (!isLanguageId(l.id)) out.push(`${l.id}: no language of the registry (src/languages.ts) has this id — a file named after it is never read`)
      else if (l.id === 'en') out.push('en: English is the source — its words are the keys and package.nls.json; no file may be named after it')
      if (l.bundle) {
        for (const { english } of s.names) {
          const v = l.bundle[english]
          // 1.11 A3 rule 11 (a): a name the ledger has just added may be absent while the language's list names it `translate`.
          if (v === undefined && translatePending(l, english)) continue
          // 1.11 A3 rule 11 (b): a name the language writes as the English does, by LANGUAGE_NAME_AS_ENGLISH only.
          const asEnglish = LANGUAGE_NAME_AS_ENGLISH.some(([id, name]) => id === l.id && name === english)
          if (typeof v !== 'string' || v === '' || (v === english && !asEnglish)) out.push(`${l.id}: ${BUNDLE(l)}: the language name ${J(english)} is not translated`)
        }
      }
      if (l.nls) {
        for (const e of LANGUAGES) {
          if (l.nls[`config.language.enum.${e.id}`] !== e.native) out.push(`${l.id}: ${NLS(l)}: config.language.enum.${e.id} is not the native name ${J(e.native)}`)
        }
        for (const key of ['displayName', 'command.category']) {
          if (l.nls[key] !== s.english[key]) out.push(`${l.id}: ${NLS(l)}: ${key} is not the English ${J(s.english[key])}`)
        }
      }
      return out
    },
  },
  T11: {
    title: 'the English quotes — the keep-warm consent quotes the terms and the line verbatim; a quoted {n} stays between quotation marks',
    rule: (s, l) => {
      if (!l.bundle) return []
      const out: string[] = []
      const detail = installed(l.bundle, () => new KeepWarmConsent(noMemento, () => undefined, { line: KEEP_WARM_LINE }).disclosure())
      if (!detail.includes(KEEP_WARM_TERMS_PASSAGE)) out.push(`${l.id}: ${BUNDLE(l)}: the keep-warm consent no longer quotes the terms passage verbatim`)
      if (!detail.includes(KEEP_WARM_LINE)) out.push(`${l.id}: ${BUNDLE(l)}: the keep-warm consent no longer quotes the line ${J(KEEP_WARM_LINE)} verbatim`)
      for (const [k, v] of entries(l.bundle)) {
        for (const ph of new Set(placeholders(k))) {
          if (quoted(k, ph) && !quoted(v, ph)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} quotes ${ph}; its translation does not stand it between quotation marks`)
        }
      }
      return out
    },
  },
  T12: {
    title: 'the freshness — every manifest translation was made from today\'s English (scripts/nls-sources.mjs --check)',
    // 1.10 B1: the script calls a key on the pending list pending, not stale; with PENDING_ALLOWED false it runs --strict.
    rule: (_s, l) => freshness(l.root, !l.pendingAllowed).filter((p) => p.startsWith(`${l.id}: `)),
  },
  T13: {
    title: 'the weekday words — Sun … Sat translated in four characters or fewer, as a reader sees them (grapheme clusters; the heat map\'s rows)',
    rule: (s, l) => {
      if (!l.bundle) return []
      const shown = installed(l.bundle, () => weekdayWords())
      // 1.11 A3 rule 2: grapheme clusters, not code points — the column holds what a reader sees (शुक्र: 2, not 5).
      return shown.map((w, i) => [s.weekdays[i], w]).filter(([, w]) => graphemes(w) > 4 || w.length === 0)
        .map(([en, w]) => `${l.id}: ${BUNDLE(l)}: ${J(en)} is ${J(w)}, ${graphemes(w)} characters`)
    },
  },
  T14: {
    title: 'the pending list — its keys in today\'s English and the German parts, the ledger applied to its end, none for German, none once PENDING_ALLOWED is false (1.10 B1)',
    rule: (s, l) => {
      const file = PENDING_FILE(l.id)
      if (l.unreadable.includes(file)) return [`${l.id}: ${file} is not a JSON object`]
      const p = l.pending
      // No list: the language has done everything the ledger asks (its package deletes the list at the end).
      if (!p) return []
      const out: string[] = []
      if (l.id === 'de') out.push(`de: ${file} exists — German is written by the package that changes the English, never pending`)
      if (!l.pendingAllowed) out.push(`${l.id}: ${file} is left — at the join (PENDING_ALLOWED = false) no language has a pending key`)
      if (p.v !== 1) out.push(`${l.id}: ${file}: v is ${J(p.v)}, not 1`)
      if (!Number.isInteger(p.applied) || p.applied < 0) out.push(`${l.id}: ${file}: applied ${J(p.applied)} is no count of entries`)
      else if (l.ledger !== null && p.applied !== l.ledger) {
        out.push(`${l.id}: ${file} has ${p.applied} of the ledger's ${l.ledger} entries applied — run node scripts/l10n-rekey.mjs`)
      }
      const keys = new Set(s.keys)
      if (!isTable(p.bundle)) out.push(`${l.id}: ${file}: bundle is not an object`)
      else {
        for (const [k, e] of Object.entries(p.bundle)) {
          if (!keys.has(k)) out.push(`${l.id}: ${file}: ${J(k)} is no key of src/ (any more)`)
          if (!isTable(e) || !Array.isArray(e.parts) || e.parts.length === 0 || !['translate', 'review'].includes(e.state as string)) {
            out.push(`${l.id}: ${file}: ${J(k)} is no { parts, state, why } entry`)
            continue
          }
          for (const part of e.parts) {
            if (!(PARTS as readonly string[]).includes(part) || !s.germanParts[part as Part].includes(k)) {
              out.push(`${l.id}: ${file}: ${J(k)} is listed for the ${part} part, and l10n/parts/${part}.de.json does not have it`)
            } else if (e.state === 'review' && !own(l.parts[part] ?? {}, k)) {
              out.push(`${l.id}: ${file}: ${J(k)} is listed for review, and l10n/parts/${part}.${l.id}.json has no value to review`)
            }
          }
        }
      }
      if (!isTable(p.nls)) out.push(`${l.id}: ${file}: nls is not an object`)
      else {
        for (const [k, e] of Object.entries(p.nls)) {
          if (!own(s.english, k)) out.push(`${l.id}: ${file}: ${k} is no key of package.nls.json (any more)`)
          if (!isTable(e) || !['translate', 'review'].includes(e.state as string)) out.push(`${l.id}: ${file}: ${k} is no { state, why } entry`)
        }
      }
      return out
    },
  },
  T15: {
    title: 'the bar\'s examples — every example a setting quotes (the reset formats, the densities, the summary periods, the hour cycles) is what the status bar prints for the documented fixture, in the language\'s words and formats (1.10 B3)',
    // A pending manifest key is exempt: the ledger changed its English, and the language's package writes it again.
    rule: (_s, l) => (l.nls ? barExampleProblems(l.id, NLS(l), l.nls, l.bundle, (k) => nlsPending(l, k)) : []),
  },
}

/** T12 runs the script as the gate does, once per directory and mode: its problems, one per line, "<id>: <key> — …". */
const FRESHNESS = new Map<string, string[]>()
function freshness(root: string, strict = false): string[] {
  const cacheKey = `${strict ? 'strict' : 'check'}:${root}`
  const hit = FRESHNESS.get(cacheKey)
  if (hit) return hit
  const args = strict ? ['--check', '--strict'] : ['--check']
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), ...args], { cwd: root, encoding: 'utf8' })
  const lines = r.stderr.split('\n').filter((x) => x.startsWith('nls-sources: ') && !x.includes('translate the named keys')).map((x) => x.slice('nls-sources: '.length))
  if (r.status !== 0 && lines.length === 0) lines.push(`?: nls-sources.mjs ${args.join(' ')} failed: ${r.stderr}`)
  FRESHNESS.set(cacheKey, lines)
  return lines
}

// ---------------------------------------------------------------------------
// The repository: every language on disk, every rule
// ---------------------------------------------------------------------------

const ON_DISK = languagesOnDisk()

test('the frame runs over the languages on disk — German among them — and English has no file of its own (1.9 B3)', () => {
  assert.ok(ON_DISK.includes('de'), `no German files found: ${J(ON_DISK)}`)
  assert.equal(ON_DISK.includes('en'), false)
  // 1.11 P8 (A8): at the join the frame measures every language of the registry but English — German and the twenty-four.
  // 1.12 P1 (pinned and changed: at the join only): every language has its files since 1.11's join, and 1.12's lists at
  // cursor 0 take none away — the frame measures the twenty-five on the build branch too.
  assert.deepEqual(ON_DISK, LANGUAGE_IDS.filter((id) => id !== 'en'))
  assert.equal(ON_DISK.length, 25)
  // 1.10 B1 (pinned and changed: thirteen rules): T14, the pending list, runs over every language too.
  // 1.10 B3 (pinned and changed: fourteen rules): T15, the bar's examples, too — and over the English (below).
  assert.deepEqual(Object.keys(RULES), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15'])
  // The references are what they claim to be.
  const s = src()
  assert.ok(s.keys.length >= 1000, `only ${s.keys.length} t() keys`)
  assert.ok(s.pageWords.length >= 150 && s.pageWords.every((k) => s.keys.includes(k)), `${s.pageWords.length} page words`)
  assert.deepEqual(s.weekdays, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  // 1.11 A3 rule 9 (pinned and changed: the literal 14): one name per language of the registry, whatever its size.
  assert.equal(s.names.length, LANGUAGES.length)
  assert.deepEqual(PARTS.map((p) => s.germanParts[p].length > 100), [true, true, true, true])
})

for (const id of ON_DISK) {
  const name = isLanguageId(id) ? `${languageEntry(id).native} (${id})` : id
  for (const [no, { title, rule }] of Object.entries(RULES)) {
    test(`${no} · ${name}: ${title}`, () => {
      const problems = rule(src(), loadLang(ROOT, id))
      assert.deepEqual(problems, [], `\n${problems.slice(0, 40).join('\n')}${problems.length > 40 ? `\n… and ${problems.length - 40} more` : ''}`)
    })
  }
}

// 1.10 B3: T15 holds the English too — package.nls.json's examples are what the English bar prints.
test(`T15 · English (en): ${RULES.T15.title}`, () => {
  const problems = barExampleProblems('en', 'package.nls.json', src().english, null)
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
})

// ---------------------------------------------------------------------------
// Synthetic languages in a temporary directory — each rule once with the mutation it exists to catch
// ---------------------------------------------------------------------------

const TEMP: string[] = []
after(() => { for (const d of TEMP) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'token-pace-lang-'))
  TEMP.push(d)
  return d
}

/**
 * The English turned into a language of another script: every word 語 (or `word`), everything the rules hold
 * kept — the code, the names, the placeholders, the marks, the quotation marks, the paragraphs.
 */
const PSEUDO_WORD = new RegExp(`[${LATIN_LETTERS}]+(?:['’][${LATIN_LETTERS}]+)*`, 'gu')
function pseudo(english: string, word: string = '語'): string {
  let out = ''
  let at = 0
  for (const m of english.matchAll(PROTECTED)) {
    out += english.slice(at, m.index).replace(PSEUDO_WORD, word)
    out += m[0]
    at = (m.index ?? 0) + m[0].length
  }
  return out + english.slice(at).replace(PSEUDO_WORD, word)
}
/**
 * 1.11 A3 rule 10: the word of the `deva` fixture — Hindi's short Friday as ICU writes it, two grapheme clusters and five
 * code points (श ु क ् र), so every weekday word of the fixture is one a reader sees as two characters.
 */
export const DEVA_WORD = 'शुक्र'

function writeJson(file: string, table: Record<string, string>): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
}

/**
 * A synthetic language `id` in a directory of its own: the English manifest, the four parts (the
 * German's keys), the bundle merged from them, the manifest's translation and its freshness record
 * (made by the script, as a translation package makes it). `german`: the German's words under
 * another id — a Latin-script language that passes every rule; `pseudo`: the English as 語 — a
 * language of another script that passes every rule; `deva` (1.11 A3 rule 10): the English as शुक्र,
 * meant for the id `hi` — Devanagari, whose words are longer in code points than on the screen.
 */
type FixtureKind = 'german' | 'pseudo' | 'deva'
const BASES = new Map<string, string>()
function fixture(kind: FixtureKind, id: string): string {
  const cacheKey = `${kind}:${id}`
  let base = BASES.get(cacheKey)
  if (!base) {
    base = tempDir()
    const s = src()
    const germanBundle = readTable(join(ROOT, 'l10n', 'bundle.l10n.de.json'))
    const germanNls = readTable(join(ROOT, 'package.nls.de.json'))
    writeJson(join(base, 'package.nls.json'), s.english)
    const merged: Record<string, string> = {}
    // 1.11 P2: a language name German writes as the English (LANGUAGE_NAME_AS_ENGLISH — Hindi) is German's alone; under
    // another id the fixture writes it as a word of its own, as that language's translation would.
    const germanWord = (k: string): string => (id !== 'de' && germanBundle[k] === k && LANGUAGE_NAME_AS_ENGLISH.some(([lang, name]) => lang === 'de' && name === k) ? `${k}-Sprache` : germanBundle[k])
    for (const part of PARTS) {
      const table: Record<string, string> = {}
      for (const k of s.germanParts[part]) table[k] = kind === 'german' ? germanWord(k) : pseudo(k, kind === 'deva' ? DEVA_WORD : '語')
      writeJson(join(base, 'l10n', 'parts', `${part}.${id}.json`), table)
      Object.assign(merged, table)
    }
    const bundle: Record<string, string> = {}
    for (const k of Object.keys(merged).sort()) bundle[k] = merged[k]
    writeJson(join(base, 'l10n', `bundle.l10n.${id}.json`), bundle)
    const nls: Record<string, string> = {}
    for (const [k, en] of Object.entries(s.english)) {
      nls[k] = kind === 'german' ? germanNls[k] : k.startsWith('config.language.enum.') && k !== 'config.language.enum.auto' ? en : pseudo(en, kind === 'deva' ? DEVA_WORD : '語')
    }
    writeJson(join(base, `package.nls.${id}.json`), nls)
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), id], { cwd: base, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    BASES.set(cacheKey, base)
  }
  const dir = tempDir()
  cpSync(base, dir, { recursive: true })
  return dir
}

/** Edits one JSON file of a fixture in place. */
function edit(dir: string, file: string, change: (t: Record<string, string>) => void): void {
  const path = join(dir, file)
  const t = readTable(path)
  change(t)
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`, 'utf8')
}

/** Runs one rule over a fixture language; the problems it names. `pendingAllowed` false: as at the join (1.10 B1). */
function run(no: string, dir: string, id: string, pendingAllowed: boolean = PENDING_ALLOWED): string[] {
  return RULES[no].rule(src(), loadLang(dir, id, pendingAllowed))
}

/** A key of the German bundle the mutation can work on: the first one `pick` accepts. */
function keyWhere(pick: (key: string) => boolean): string {
  const k = src().keys.find(pick)
  assert.ok(k, 'no key for the mutation')
  return k
}

/** The bundle and the part that hold a key must change together: the merge would refuse them apart. */
function editKey(dir: string, id: string, key: string, change: (value: string) => string | undefined): void {
  for (const f of [`l10n/bundle.l10n.${id}.json`, ...PARTS.map((p) => `l10n/parts/${p}.${id}.json`)]) {
    edit(dir, f, (t) => {
      if (!(key in t)) return
      const next = change(t[key])
      if (next === undefined) delete t[key]
      else t[key] = next
    })
  }
}

/** The mutation fails the rule, and names the language and the key; the unbroken fixture passes it. */
function caught(no: string, dir: string, id: string, clean: string, ...needles: string[]): void {
  caughtAs(PENDING_ALLOWED, no, dir, id, clean, ...needles)
}
/** `caught`, with the rules reading pending lists or not (1.10 B1: the build branch, or the join) whatever PENDING_ALLOWED says. */
function caughtAs(pendingAllowed: boolean, no: string, dir: string, id: string, clean: string, ...needles: string[]): void {
  assert.deepEqual(run(no, clean, id, pendingAllowed), [], `${no} fails the unbroken ${id} fixture`)
  const problems = run(no, dir, id, pendingAllowed)
  assert.ok(problems.length > 0, `${no} did not catch the mutation`)
  for (const needle of [`${id}: `, ...needles]) {
    assert.ok(problems.some((p) => p.includes(needle)), `${no} does not name ${J(needle)}:\n${problems.join('\n')}`)
  }
}

test('the three synthetic languages — the German under fr, the English as 語 under ja, the English as शुक्र under hi — pass every rule (1.11 A3 rule 10: the third)', () => {
  for (const [kind, id] of [['german', 'fr'], ['pseudo', 'ja'], ['deva', 'hi']] as const) {
    const dir = fixture(kind, id)
    // 1.10 B3: but T15, which reads the bar under the id's own locale — the German's “Mo 06:00” is not what a French bar
    // prints (“lun. 06:00”), nor 語 a Japanese weekday. T15 runs over the real files and its own fixtures (below).
    // 1.11 P1: and T10 for `hi` until the registry has it (1.11 P2) — T10 names a file after no registry id, by design.
    const rules = Object.keys(RULES).filter((x) => x !== 'T15' && (x !== 'T10' || isLanguageId(id)))
    for (const no of rules) assert.deepEqual(run(no, dir, id), [], `${no} fails the unbroken ${kind} fixture ${id}`)
  }
  assert.ok(isLanguageId('hi') || run('T10', fixture('deva', 'hi'), 'hi').every((p) => p.startsWith('hi: no language of the registry')),
    'T10 names something of the deva fixture beyond its unregistered id')
})

test('T1 catches a bundle key gone, a key src/ does not have, and a manifest out of order', () => {
  const clean = fixture('pseudo', 'ja')
  const key = keyWhere((k) => k === 'Refresh')
  const dir = fixture('pseudo', 'ja')
  edit(dir, 'l10n/bundle.l10n.ja.json', (t) => { delete t[key]; t['A key no source has'] = '語' })
  caught('T1', dir, 'ja', clean, 'no translation of "Refresh"', '"A key no source has" is no key of src/')
  const order = fixture('pseudo', 'ja')
  edit(order, 'package.nls.ja.json', (t) => {
    const { displayName, ...rest } = t
    for (const k of Object.keys(t)) delete t[k]
    Object.assign(t, rest, { displayName })
  })
  caught('T1', order, 'ja', clean, 'not in its order')
})

test('T2 catches a key deleted from one Polish part (§3 B3\'s mutation)', () => {
  const clean = fixture('pseudo', 'pl')
  const dir = fixture('pseudo', 'pl')
  const key = src().germanParts.model[0]
  edit(dir, 'l10n/parts/model.pl.json', (t) => { delete t[key] })
  caught('T2', dir, 'pl', clean, 'l10n/parts/model.pl.json', `no translation of ${J(key)}`)
})

test('T3 catches a {1} lost in one French value (§3 B3\'s mutation)', () => {
  const clean = fixture('german', 'fr')
  const key = keyWhere((k) => k.includes('{1}') && !k.includes('{2}'))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', key, (v) => v.replace('{1}', ''))
  caught('T3', dir, 'fr', clean, J(key))
})

test('T4 catches ～ for ~ in Japanese (§3 B3\'s mutation)', () => {
  const clean = fixture('pseudo', 'ja')
  const key = keyWhere((k) => k.includes('~'))
  const dir = fixture('pseudo', 'ja')
  editKey(dir, 'ja', key, (v) => v.replace('~', '～'))
  caught('T4', dir, 'ja', clean, J(key), '× ~')
})

test('T5 catches a translated setting value in backticks, a setting id lost, a manifest span translated and a codicon lost', () => {
  const clean = fixture('german', 'fr')
  const tick = keyWhere((k) => /`[a-z]+`/.test(k))
  const id = keyWhere((k) => /tokenPace\.[a-z]/.test(k) && !/`[^`]*tokenPace/.test(k) && k !== tick)
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', tick, (v) => v.replace(/`([a-z]+)`/, '`$1-traduit`'))
  editKey(dir, 'fr', id, (v) => v.replace(/tokenPace\.[A-Za-z0-9_.]*[A-Za-z0-9_]/, 'le réglage'))
  caught('T5', dir, 'fr', clean, J(tick), J(id), 'backtick spans', 'tokenPace ids')
  // The bundle's keys carry no codicon today; the manifest's examples do (`$(history)`).
  const nls = fixture('german', 'fr')
  edit(nls, 'package.nls.fr.json', (t) => {
    t['config.pace.sensitivity.description'] = t['config.pace.sensitivity.description'].replace('`custom`', '`personnalisé`')
    t['config.showAgeInItem.enum.always'] = t['config.showAgeInItem.enum.always'].replace(/\$\([a-z-]+\)/, '')
  })
  caught('T5', nls, 'fr', clean, 'config.pace.sensitivity.description', 'lost: ["custom"]', 'config.showAgeInItem.enum.always', 'codicons')
})

test('T6 catches markup in a translation of one of the page\'s words — each of <, >, " and & on its own', () => {
  const clean = fixture('pseudo', 'ja')
  const dir = fixture('pseudo', 'ja')
  const words = src().pageWords.slice(0, 4)
  words.forEach((k, i) => editKey(dir, 'ja', k, (v) => `${v} ${'<>"&'[i]} 語`))
  caught('T6', dir, 'ja', clean, ...words.map((k) => J(k)))
})

test('T7 catches an exclamation mark — ！ in Japanese, ! in French', () => {
  const ja = fixture('pseudo', 'ja')
  const cleanJa = fixture('pseudo', 'ja')
  editKey(ja, 'ja', 'Refresh', (v) => `${v}！`)
  caught('T7', ja, 'ja', cleanJa, '"Refresh"')
  const fr = fixture('german', 'fr')
  const cleanFr = fixture('german', 'fr')
  edit(fr, 'package.nls.fr.json', (t) => { t.description = `${t.description}!` })
  caught('T7', fr, 'fr', cleanFr, 'description')
})

test('T8 catches a table header row that lost a pipe', () => {
  const clean = fixture('german', 'fr')
  const key = keyWhere((k) => k.startsWith('| '))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', key, (v) => v.replace(/ \| [^|]+ \|$/, ' |'))
  caught('T8', dir, 'fr', clean, J(key))
})

test('T9 catches a copied English sentence — in a French value (§3 B3\'s mutation), in a Japanese one, in a manifest entry', () => {
  const cleanFr = fixture('german', 'fr')
  const key = keyWhere((k) => k === 'Not enough data for a summary yet.')
  const fr = fixture('german', 'fr')
  editKey(fr, 'fr', key, () => 'Not enough data for a summary yet.')
  caught('T9', fr, 'fr', cleanFr, J(key), 'is its own key')
  // A sentence of the English inside an otherwise French value.
  const inside = fixture('german', 'fr')
  editKey(inside, 'fr', key, (v) => `${v} Not enough data for a summary.`)
  caught('T9', inside, 'fr', cleanFr, J(key), 'four English words in a row')
  const cleanJa = fixture('pseudo', 'ja')
  const ja = fixture('pseudo', 'ja')
  editKey(ja, 'ja', key, () => '語: not enough data yet')
  caught('T9', ja, 'ja', cleanJa, J(key), 'three Latin words in a row')
  const nls = fixture('german', 'fr')
  edit(nls, 'package.nls.fr.json', (t) => { t.description = readTable(join(ROOT, 'package.nls.json')).description })
  caught('T9', nls, 'fr', cleanFr, 'package.nls.fr.json: description')
})

test('T9 lets the field ids a key lists stand in a language of another script — O2\'s Japanese, Korean and Russian values —, and catches English beside them and the same four words in another key (1.12 O2, the lead at the merge)', () => {
  assert.equal(FIELD_IDS_OF_A_KEY.length, 1)
  const [key, ids, why] = FIELD_IDS_OF_A_KEY[0]
  assert.equal(key, 'Set host, user, from and to in tokenPace.notifications.email first.')
  assert.deepEqual([...ids], ['host', 'user', 'from', 'to'])
  assert.ok(why.trim().length > 10, 'no reason')
  for (const [k] of FIELD_IDS_OF_A_KEY) assert.ok(src().keys.includes(k), `${J(k)} is not a key of the bundle`)
  // Whole words only: hosted, users and fromage are none of the ids; the ids of a key stay in every other key.
  assert.deepEqual(wordsOf(withoutFieldIds(key, 'vor host nach hosted users fromage to')[1]), ['vor', 'nach', 'hosted', 'users', 'fromage'])
  assert.deepEqual(withoutFieldIds('another key', 'host user from to'), ['another key', 'host user from to'])
  const clean = fixture('pseudo', 'ja')
  for (const value of [
    '先に tokenPace.notifications.email で host、user、from、to を設定してください。',
    '먼저 tokenPace.notifications.email에서 host, user, from, to를 설정하십시오.',
    'Сначала задайте host, user, from и to в tokenPace.notifications.email.',
  ]) {
    const dir = fixture('pseudo', 'ja')
    editKey(dir, 'ja', key, () => value)
    assert.deepEqual(run('T9', dir, 'ja'), [], value)
  }
  const beside = fixture('pseudo', 'ja')
  editKey(beside, 'ja', key, () => '先に host、user、from、to in the settings を設定してください。')
  caught('T9', beside, 'ja', clean, J(key), 'three Latin words in a row: "in the settings"')
  const other = keyWhere((k) => k === 'Not enough data for a summary yet.')
  const elsewhere = fixture('pseudo', 'ja')
  editKey(elsewhere, 'ja', other, (v) => `${v} host user from`)
  caught('T9', elsewhere, 'ja', clean, J(other), 'three Latin words in a row: "host user from"')
})

/**
 * Review L 1.12, finding 1 (the lead, before the fix pass): no rule held what a language KEEPS — T9 takes the names of
 * SAME_IN_EVERY_LANGUAGE out before it compares, so a translated "Telegram" or a « sécurité » for macOS's `security` tool
 * passed (the common part's mutations M5 and M9), and nothing read the notification texts for a markdown mark (M10). The
 * two tests below hold it over every language on disk: (1) a name of NAMES_OF_1_12 and the word `security` stand in a
 * value at least as often as in its key — a name may be repeated, never lost; (2) the host part's notification texts (the
 * ledger's n=59–75: the six titles, the nine event sentences, the test message and its answer — P7-D3: they go to chat
 * services as they are) carry no `*`, `_`, `~` or backtick the key does not have. The brief's 1.12 section says so.
 */
const KEPT_NAMES: ReadonlyArray<string> = [...NAMES_OF_1_12.map(([w]) => w), 'security']
const NOTIFY_TEXT_RANGE: readonly [number, number] = [59, 75]
const MARKDOWN_MARKS: ReadonlyArray<string> = ['*', '_', '~', '`']
/**
 * How often a name stands in a text, whole: no Latin letter or digit joined to it (that would be another word), while a
 * hyphen, a quotation mark or a particle of another script beside it is fine — Korean glues its particles (ntfy에서,
 * BotFather에게), and the name is kept.
 */
function keptCount(text: string, name: string): number {
  return (text.match(new RegExp(`(?<![${LATIN_LETTERS}0-9])${namePattern(name)}(?![${LATIN_LETTERS}0-9])`, 'gu')) ?? []).length
}
/** The notification texts' keys: the ledger's host-part additions n=59–75. */
function notifyTextKeys(): string[] {
  const ledger = JSON.parse(readFileSync(join(ROOT, 'l10n', 'rekey.json'), 'utf8')) as { entries: LedgerEntry[] }
  return ledger.entries.filter((e) => e.kind === 'add' && e.part === 'host' && e.n >= NOTIFY_TEXT_RANGE[0] && e.n <= NOTIFY_TEXT_RANGE[1] && typeof e.key === 'string').map((e) => e.key as string)
}
/** One language's problems: a name lost from a bundle or manifest value, a markdown mark added to a notification text. */
function keptNamesLeft(s: Source, l: LangFiles, notifyKeys: readonly string[]): string[] {
  const out: string[] = []
  for (const [k, v] of entries(l.bundle)) {
    for (const name of KEPT_NAMES) {
      const want = keptCount(k, name)
      if (want > 0 && keptCount(v, name) < want) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} keeps ${name} ${keptCount(v, name)}× — the key ${want}×`)
    }
  }
  for (const [k, en, v] of nlsEntries(s, l)) {
    for (const name of KEPT_NAMES) {
      const want = keptCount(en, name)
      if (want > 0 && keptCount(v, name) < want) out.push(`${l.id}: ${NLS(l)}: ${k} keeps ${name} ${keptCount(v, name)}× — the English ${want}×`)
    }
  }
  for (const k of notifyKeys) {
    const v = l.bundle?.[k]
    if (v === undefined) continue // T1 names a missing key or a missing bundle
    for (const m of MARKDOWN_MARKS) if (v.includes(m) && !k.includes(m)) out.push(`${l.id}: ${BUNDLE(l)}: ${J(k)} carries ${J(m)}, which the key does not — the text goes to a chat service as it is (P7-D3)`)
  }
  return out
}

test('the names of 1.12 and `security` are kept in every language on disk, and the notification texts carry no markdown mark the key lacks (Review L 1.12 finding 1)', () => {
  const s = src()
  const keys = notifyTextKeys()
  assert.equal(keys.length, 17, 'the ledger\'s n=59–75 are the seventeen notification texts')
  for (const k of keys) assert.ok(s.keys.includes(k), `${J(k)} is not a bundle key`)
  assert.equal(KEPT_NAMES.length, 14)
  // Most names stand in the English (STARTTLS was listed before a text used it — P1, E1 rule 2); the check holds the ones that do.
  const standing = KEPT_NAMES.filter((name) => s.keys.some((k) => keptCount(k, name) > 0) || Object.values(s.english).some((en) => keptCount(en, name) > 0))
  assert.ok(standing.length >= 12, `only ${standing.length} of the names stand in an English text: ${J(standing)}`)
  const problems: string[] = []
  for (const id of ON_DISK) problems.push(...keptNamesLeft(s, loadLang(ROOT, id), keys))
  assert.deepEqual(problems, [])
})

test('the kept-names guard catches a translated name, a translated `security` and a markdown mark in a notification text — and lets a repeated name and a hyphenated one pass (the common part\'s M5, M9, M10)', () => {
  const s = src()
  const keys = notifyTextKeys()
  const clean = fixture('german', 'fr')
  assert.deepEqual(keptNamesLeft(s, loadLang(clean, 'fr'), keys), [], 'the German under fr keeps every name')
  const telegram = keyWhere((k) => keptCount(k, 'Telegram') > 0)
  const m5 = fixture('german', 'fr')
  editKey(m5, 'fr', telegram, (v) => v.replace(/Telegram/g, 'Télégram'))
  assert.ok(keptNamesLeft(s, loadLang(m5, 'fr'), keys).some((p) => p.includes(J(telegram)) && p.includes('keeps Telegram 0×')), 'M5: a translated Telegram')
  const security = keyWhere((k) => keptCount(k, 'security') > 0)
  const m9 = fixture('german', 'fr')
  editKey(m9, 'fr', security, (v) => v.replace(/security/g, 'sécurité'))
  assert.ok(keptNamesLeft(s, loadLang(m9, 'fr'), keys).some((p) => p.includes(J(security)) && p.includes('keeps security')), 'M9: a translated security')
  const waiting = keys.find((k) => k.startsWith('{0} is waiting for your permission')) ?? ''
  assert.ok(waiting, 'the agentWaiting sentence is one of the notification texts')
  const m10 = fixture('german', 'fr')
  editKey(m10, 'fr', waiting, (v) => v.replace('{0}', '*{0}*'))
  assert.ok(keptNamesLeft(s, loadLang(m10, 'fr'), keys).some((p) => p.includes(J(waiting)) && p.includes('carries "*"')), 'M10: a markdown mark')
  // A name said twice, or joined by a hyphen (the German's "security-Werkzeug"), is kept.
  const more = fixture('german', 'fr')
  editKey(more, 'fr', telegram, (v) => `${v} Telegram`)
  editKey(more, 'fr', security, (v) => v.replace(/security/, 'security-outil'))
  assert.deepEqual(keptNamesLeft(s, loadLang(more, 'fr'), keys), [])
})

test('T10 catches a file named after no shipped language, an untranslated language name, a translated native name and a translated product name', () => {
  const clean = fixture('german', 'fr')
  const xx = fixture('german', 'xx')
  assert.ok(run('T10', xx, 'xx').some((p) => p.startsWith('xx: no language of the registry')))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', 'Japanese', () => 'Japanese')
  edit(dir, 'package.nls.fr.json', (t) => { t['config.language.enum.de'] = 'Allemand'; t.displayName = 'Token Pace — Claude Code et Codex' })
  caught('T10', dir, 'fr', clean, 'the language name "Japanese" is not translated', 'config.language.enum.de', 'displayName')
})

test('T11 catches the terms passage dropped from the consent, and a quoted {0} without its quotation marks', () => {
  const clean = fixture('german', 'fr')
  const terms = keyWhere((k) => k.startsWith('Terms: section 3 of Anthropic'))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', terms, (v) => v.replace(/„\{0\}“/, ''))
  caught('T11', dir, 'fr', clean, 'the terms passage')
  const marks = fixture('german', 'fr')
  editKey(marks, 'fr', terms, (v) => v.replace(/„\{0\}“/, '{0}'))
  caught('T11', marks, 'fr', clean, J(terms), 'between quotation marks')
})

test('T12 catches a changed English manifest value without a new record (§3 B3\'s mutation)', () => {
  const clean = fixture('german', 'fr')
  const dir = fixture('german', 'fr')
  edit(dir, 'package.nls.json', (t) => { t['config.language.enum.auto'] = `${t['config.language.enum.auto']} (changed)` })
  caught('T12', dir, 'fr', clean, 'config.language.enum.auto', 'the English changed since its translation')
  // The script is the gate: it exits 1 there, and 0 once the language is recorded again.
  const again = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), 'fr'], { cwd: dir, encoding: 'utf8' })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), '--check'], { cwd: dir, encoding: 'utf8' }).status, 0)
})

test('T13 catches a weekday word too long for the heat map\'s column', () => {
  const clean = fixture('german', 'fr')
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', 'Mon', () => 'Montag')
  caught('T13', dir, 'fr', clean, '"Mon" is "Montag"')
})

// ---------------------------------------------------------------------------
// The freshness script itself (scripts/nls-sources.mjs)
// ---------------------------------------------------------------------------

test('nls-sources writes a record in the English\'s key order, and --check names a missing record, an orphan record, a key never recorded and a key gone', () => {
  const dir = tempDir()
  const script = join(ROOT, 'scripts', 'nls-sources.mjs')
  const cli = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea' })
  writeJson(join(dir, 'package.nls.fr.json'), { b: 'Abeille', a: 'A', c: 'Mer' })
  assert.equal(cli('--check').status, 1, 'a translation without a record is not fresh')
  assert.match(cli('--check').stderr, /fr: package\.nls\.fr\.json has no record/)
  // A tag that is no language — a path among them — writes nothing.
  for (const bad of ['../x', 'FR', 'fr/../../x', '']) {
    const r = cli(bad)
    assert.equal(r.status, 1, `nls-sources ${J(bad)}`)
  }
  assert.equal(existsSync(join(dir, 'l10n')), false, 'a refused tag wrote a file')
  const w = cli('fr')
  assert.equal(w.status, 0, w.stderr)
  const record = readFileSync(join(dir, 'l10n', 'nls-sources', 'fr.json'), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(record)), ['b', 'a', 'c'])
  assert.match(record, /^\{\n {2}"b": "[0-9a-f]{16}",\n/)
  assert.ok(record.endsWith('}\n'))
  assert.equal(cli('--check').status, 0)
  // An English key added after the translation: never recorded.
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea', d: 'Dee' })
  assert.match(cli('--check').stderr, /fr: d — no record of the English it was translated from/)
  // An English key removed: recorded, but gone.
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay' })
  assert.match(cli('--check').stderr, /fr: c — recorded, but package\.nls\.json has no such key any more/)
  // A record left behind by a translation that was removed.
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea' })
  writeJson(join(dir, 'l10n', 'nls-sources', 'it.json'), { b: '0000000000000000' })
  assert.match(cli('--check').stderr, /it: l10n[\\/]nls-sources[\\/]it\.json has no package\.nls\.it\.json beside it/)
})

test('German\'s record is the one the script makes from today\'s files, and the records are not shipped', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'nls-sources.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const record = readTable(join(ROOT, 'l10n', 'nls-sources', 'de.json'))
  assert.deepEqual(Object.keys(record), Object.keys(src().english))
  // .vscodeignore ships nothing under l10n/ but the bundles: no part, no record, no brief.
  const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8')
  const negations = ignore.split('\n').filter((l) => l.startsWith('!l10n'))
  assert.deepEqual(negations, ['!l10n/bundle.l10n.*.json'])
  assert.ok(existsSync(join(ROOT, 'l10n', 'TRANSLATING.md')), 'the brief is missing')
})

test('the brief names every rule of the frame, the files a package owns, the gates and the scripts (1.9 B2)', () => {
  const brief = readFileSync(join(ROOT, 'l10n', 'TRANSLATING.md'), 'utf8')
  for (const needed of [
    'l10n/parts/dashboard.<id>.json', 'l10n/parts/host.<id>.json', 'l10n/parts/model.<id>.json', 'l10n/parts/text.<id>.json',
    'l10n/bundle.l10n.<id>.json', 'package.nls.<id>.json', 'l10n/nls-sources/<id>.json',
    'node scripts/merge-l10n.mjs', 'node scripts/nls-sources.mjs <id>', 'node scripts/nls-sources.mjs --check', 'node scripts/l10n-extract.mjs --json',
    'out-test/l10n.languages.test.js', 'SAME_IN_EVERY_LANGUAGE', 'Ignore this message. No action. No response.',
    'never translate the German', '30 hardest terms', '260 px',
  ]) assert.ok(brief.includes(needed), `l10n/TRANSLATING.md does not say: ${needed}`)
  for (const no of Object.keys(RULES)) assert.ok(new RegExp(`\\*\\*${no} `).test(brief), `the brief does not describe ${no}`)
  // The marks, as the rules count them; the product names, as T9 excepts them.
  for (const m of MARKS) assert.ok(brief.includes(`\`${m}\``), `the brief does not name the mark ${m}`)
  for (const [w] of SAME_IN_EVERY_LANGUAGE.slice(0, 15)) assert.ok(brief.includes(w), `the brief does not name ${w}`)
  // 1.9 B5 (P19): every word added at the join, and every manifest span that is words, is named in the brief — a
  // translation of a later language must not meet an exception it cannot read about.
  for (const [w] of ADDED_AT_THE_JOIN) assert.ok(brief.includes(`\`${w}\``), `the brief does not name the join's ${w}`)
  // 1.12 O2 (the lead, at the merge): the key whose field ids T9 lets stand is named in the brief, in quotation marks, with its ids.
  for (const [k, ids] of FIELD_IDS_OF_A_KEY) {
    assert.ok(brief.includes(`"${k}"`), `the brief does not name the key ${J(k)}`)
    assert.ok(brief.includes(`\`${ids.join('\`, \`')}\``), `the brief does not name the ids of ${J(k)}`)
  }
  for (const [w] of NLS_SPANS_READ_AS_WORDS) assert.ok(brief.includes(`\`${w}\``), `the brief does not name the span ${w}`)
  assert.ok(brief.replace(/\s+/g, ' ').includes(`There are ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][NLS_SPANS_READ_AS_WORDS.length]}, and the test names them`),
    'the brief does not count the spans that are words')
})

// ---------------------------------------------------------------------------
// 1.10 B3: T15, the bar's examples
// ---------------------------------------------------------------------------

/** A language's own files from the repository, in a temporary directory of their own (T15's mutations). */
function realFiles(id: string): string {
  const dir = tempDir()
  const copy = (file: string): void => {
    if (!existsSync(join(ROOT, file))) return
    mkdirSync(join(dir, file, '..'), { recursive: true })
    cpSync(join(ROOT, file), join(dir, file))
  }
  for (const f of ['package.nls.json', `package.nls.${id}.json`, `l10n/bundle.l10n.${id}.json`, PENDING_FILE(id), 'l10n/rekey.json',
    ...PARTS.map((p) => `l10n/parts/${p}.${id}.json`)]) copy(f)
  return dir
}

/** Sets one manifest value of a copied language, and takes the key off its pending list (as its package would). */
function settle(dir: string, id: string, key: string, value: string): void {
  edit(dir, `package.nls.${id}.json`, (t) => { t[key] = value })
  const pending = join(dir, PENDING_FILE(id))
  if (existsSync(pending)) {
    const p = JSON.parse(readFileSync(pending, 'utf8')) as Pending
    delete p.nls[key]
    mkdirSync(join(pending, '..'), { recursive: true }) // the copy has no l10n/pending/ once the language's list is gone (P19's finding)
    writeFileSync(pending, `${JSON.stringify(p, null, 2)}\n`, 'utf8')
  }
}

test('T15: an apostrophe between two letters is part of the word, not a closing mark — “aujourd’hui” stays one example; a real closing mark still ends one', () => {
  assert.deepEqual(quotedExamples('Aujourd’hui — « Σ 3,1M · aujourd’hui »'), ['Σ 3,1M · aujourd’hui'])
  assert.deepEqual(quotedExamples("Oggi — “Σ 3,1M · dell'ora”"), ["Σ 3,1M · dell'ora"])
  assert.deepEqual(quotedExamples('‘Σ 3.1M · today’ and ‘x’'), ['Σ 3.1M · today', 'x'])
  assert.deepEqual(quotedExamples('“a” « b »'), ['a', 'b'])
})

test('T15: the fixture builds the English examples of package.nls.json word for word — the bar\'s reset word, the weekday beyond a day, the pace glyph, the period (1.10 B3)', () => {
  const english = src().english
  const all = Object.keys(BAR_EXAMPLE_KEYS).flatMap((k) => quotedExamples(english[k]))
  assert.deepEqual(all, [
    'CC 5h 25% · resets 2h14m', 'CC 5h 25% · resets at 06:00', '· resets at Mo 06:00', 'CC 5h 25% · resets at 06:00 (in 2h14m)',
    'CC 5h ██▁▁▁▁▁▁ 25% · resets 2h14m', 'CC 25%·2h14m | 69%·6d', 'TP 25% ▲',
    'Σ 3.1M · today', 'Σ 12.3M · 7d', 'Σ 48.9M · 30d', '06:00 AM', '06:00',
    // 1.12 D5 (pinned and changed: the budget key joined BAR_EXAMPLE_KEYS): the budget entry's own figure, no space.
    'budget 63%',
  ])
  assert.deepEqual(BAR_EXEMPT, [])
  // The German bar's words (§3 B3): „Reset in 2h14m", „Reset um 06:00", „heute" — T15 over the German files holds them.
  const de = readTable(join(ROOT, 'package.nls.de.json'))
  assert.deepEqual(Object.keys(BAR_EXAMPLE_KEYS).flatMap((k) => quotedExamples(de[k])), [
    'CC 5h 25% · Reset in 2h14m', 'CC 5h 25% · Reset um 06:00', '· Reset um Mo 06:00', 'CC 5h 25% · Reset um 06:00 (in 2h14m)',
    'CC 5h ██▁▁▁▁▁▁ 25% · Reset in 2h14m', 'CC 25%·2h14m | 69%·6d', 'TP 25% ▲',
    'Σ 3,1M · heute', 'Σ 12,3M · 7d', 'Σ 48,9M · 30d', '06:00 AM', '06:00',
    'Budget 63%',
  ])
  assert.deepEqual(barExampleProblems('de', 'package.nls.de.json', de, readTable(join(ROOT, 'l10n', 'bundle.l10n.de.json'))), [])
})

test('T15 catches an example the bar does not print — the English relative example without its "resets", cs\'s "Σ 3.1M" where the Czech bar prints 3,1M, an example dropped — and exempts a key on the pending list until the join (1.10 B3)', () => {
  // The English (§3 B3's mutation): the example as 1.9 wrote it, without the word the bar adds.
  const english = { ...src().english, 'config.resetFormat.enum.relative': 'Time left — “CC 5h 25% · 2h14m”' }
  assert.ok(barExampleProblems('en', 'package.nls.json', english, null)
    .some((p) => p.startsWith('en: package.nls.json: config.resetFormat.enum.relative quotes "CC 5h 25% · 2h14m", and the bar prints')))
  const dropped = { ...src().english, 'config.resetFormat.enum.absolute': 'Clock time, with the weekday beyond 24 h — “CC 5h 25% · resets at 06:00”' }
  assert.ok(barExampleProblems('en', 'package.nls.json', dropped, null)
    .some((p) => p.includes('config.resetFormat.enum.absolute quotes 1 example(s), the English 2')))
  // Czech (§3 B3's mutation): the English decimal point where the Czech bar writes a comma.
  const today = readTable(join(ROOT, 'l10n', 'bundle.l10n.cs.json'))['today'] ?? 'today'
  const key = 'config.summary.period.enum.today'
  const clean = realFiles('cs')
  settle(clean, 'cs', key, `Dnes — „Σ 3,1M · ${today}“`)
  const dir = realFiles('cs')
  settle(dir, 'cs', key, `Dnes — „Σ 3.1M · ${today}“`)
  caught('T15', dir, 'cs', clean, `${key} quotes "Σ 3.1M · ${today}"`)
  // A key on the pending list is exempt while PENDING_ALLOWED is true; at the join it is held like every other.
  const listed = realFiles('cs')
  settle(listed, 'cs', key, 'Dnes — „Σ 3,1M“')
  const pending = join(listed, PENDING_FILE('cs'))
  const p: Pending = existsSync(pending) ? JSON.parse(readFileSync(pending, 'utf8')) as Pending : { v: 1, applied: 0, bundle: {}, nls: {} }
  p.nls[key] = { state: 'review', why: 'the example now names the period' }
  mkdirSync(join(pending, '..'), { recursive: true }) // the copy has no l10n/pending/ once the language's list is gone (P19's finding)
  writeFileSync(pending, `${JSON.stringify(p, null, 2)}\n`, 'utf8')
  assert.equal(run('T15', listed, 'cs', true).some((x) => x.includes(key)), false)
  assert.ok(run('T15', listed, 'cs', false).some((x) => x.includes(`${key} quotes "Σ 3,1M"`)))
})

// ---------------------------------------------------------------------------
// 1.10 B1: the re-key ledger, the pending lists (T14), T9's × and ÷
// ---------------------------------------------------------------------------

const REKEY = join(ROOT, 'scripts', 'l10n-rekey.mjs')

/** An entry of l10n/rekey.json (scripts/l10n-rekey.mjs ENTRY_FIELDS). */
interface LedgerEntry { n: number; by: string; kind: string; part?: string; from?: string; old?: string; key?: string; carry?: boolean; why: string }
/** l10n/rekey-base.json: the tree the ledger starts from. */
interface RekeyBase { v: number; base: string; keys: Record<string, string[]>; nls: Record<string, string> }
/** What the ledger's test compares the replay with: the German parts' keys, the t() keys, the English manifest. */
interface Tree { parts: Record<Part, string[]>; keys: string[]; english: Record<string, string> }

const hash16 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)

/**
 * The ledger's own test: the base's key sets, the entries replayed on them one by one (each where it can apply — a
 * reworded or removed key in its part, an added one not yet there), and the result against today's tree. So an English
 * change without its entry fails in the package that made it: a new t() key, a key gone, a key moved between parts, a
 * manifest key added or gone, a manifest value whose English changed.
 */
function ledgerProblems(base: RekeyBase, entries: readonly LedgerEntry[], today: Tree): string[] {
  const out: string[] = []
  const parts = {} as Record<Part, Set<string>>
  for (const p of PARTS) parts[p] = new Set()
  for (const [k, ps] of Object.entries(base.keys)) for (const p of ps) parts[p as Part]?.add(k)
  const nls = new Set(Object.keys(base.nls))
  const changed = new Set<string>()
  for (const e of entries) {
    const at = `l10n/rekey.json: entry ${e.n} (${e.kind})`
    const part = (PARTS as readonly string[]).includes(e.part ?? '') ? parts[e.part as Part] : null
    if (!e.kind.startsWith('nls-') && part === null) { out.push(`${at}: the part ${J(e.part)} does not exist`); continue }
    const put = (key: string): void => { if (part!.has(key)) out.push(`${at}: the ${e.part} part has ${J(key)} already`); else part!.add(key) }
    const take = (key: string): void => { if (!part!.has(key)) out.push(`${at}: the ${e.part} part has no ${J(key)}`); else part!.delete(key) }
    switch (e.kind) {
      case 'add': put(e.key!); break
      case 'reword': take(e.old!); put(e.key!); break
      case 'remove': take(e.old!); break
      case 'copy':
        if (!(PARTS as readonly string[]).includes(e.from ?? '') || !parts[e.from as Part].has(e.key!)) out.push(`${at}: the ${e.from} part has no ${J(e.key)} to copy`)
        put(e.key!)
        break
      case 'review': if (!part!.has(e.key!)) out.push(`${at}: the ${e.part} part has no ${J(e.key)} to review`); break
      case 'nls-add': if (nls.has(e.key!)) out.push(`${at}: the manifest has ${e.key} already`); else { nls.add(e.key!); changed.add(e.key!) } break
      case 'nls-reword': if (!nls.has(e.key!)) out.push(`${at}: the manifest has no ${e.key}`); else changed.add(e.key!); break
      case 'nls-remove': if (!nls.has(e.key!)) out.push(`${at}: the manifest has no ${e.key}`); else { nls.delete(e.key!); changed.delete(e.key!) } break
      default: out.push(`${at}: no such kind`)
    }
  }
  const union = new Set<string>()
  for (const p of PARTS) {
    const want = new Set(today.parts[p])
    for (const k of today.parts[p]) {
      if (!parts[p].has(k)) out.push(`l10n/parts/${p}.de.json has ${J(k)}, which neither the base (${base.base}) nor an entry of l10n/rekey.json puts there — append an add, reword or copy entry`)
    }
    for (const k of parts[p]) {
      union.add(k)
      if (!want.has(k)) out.push(`l10n/parts/${p}.de.json lacks ${J(k)}, which the ledger keeps there — append a remove or reword entry`)
    }
  }
  const keys = new Set(today.keys)
  for (const k of today.keys) if (!union.has(k)) out.push(`src/ has the t() key ${J(k)}, which no entry of l10n/rekey.json adds`)
  for (const k of union) if (!keys.has(k)) out.push(`the ledger keeps ${J(k)}, which src/ no longer has — append a remove or reword entry`)
  for (const [k, en] of Object.entries(today.english)) {
    if (!nls.has(k)) out.push(`package.nls.json has ${k}, which no nls-add entry of l10n/rekey.json adds`)
    else if (!changed.has(k) && base.nls[k] !== hash16(en)) out.push(`the English of ${k} changed since ${base.base}, and no nls-reword entry of l10n/rekey.json says so`)
  }
  for (const k of nls) if (!own(today.english, k)) out.push(`package.nls.json lacks ${k}, which no nls-remove entry of l10n/rekey.json takes out`)
  return out
}

test('the ledger explains every English change since its base: rekey-base.json with the entries of l10n/rekey.json replayed is today\'s German parts, t() keys and manifest (1.10 B1)', () => {
  const base = JSON.parse(readFileSync(join(ROOT, 'l10n', 'rekey-base.json'), 'utf8')) as RekeyBase
  const ledger = JSON.parse(readFileSync(join(ROOT, 'l10n', 'rekey.json'), 'utf8')) as { v: number; base: string; entries: LedgerEntry[] }
  assert.deepEqual(Object.keys(ledger), ['v', 'base', 'entries'])
  assert.deepEqual([ledger.v, base.v], [1, 1])
  assert.equal(base.base, ledger.base, 'the base file and the ledger name two commits')
  assert.match(base.base, /^[0-9a-f]{7,40}$/)
  // The base is a tree: every t() key with the German parts it stood in, every manifest key with its English's hash.
  for (const [k, ps] of Object.entries(base.keys)) {
    assert.ok(ps.length > 0 && ps.every((p) => (PARTS as readonly string[]).includes(p)) && new Set(ps).size === ps.length, `${J(k)}: ${J(ps)}`)
  }
  for (const [k, h] of Object.entries(base.nls)) assert.match(h, /^[0-9a-f]{16}$/, k)
  ledger.entries.forEach((e, i) => assert.equal(e.n, i + 1, `entry ${i + 1} has n ${e.n}`))
  const s = src()
  const problems = ledgerProblems(base, ledger.entries, { parts: s.germanParts, keys: s.keys, english: s.english })
  assert.deepEqual(problems, [], `\n${problems.slice(0, 40).join('\n')}`)
  // The gate itself: every entry well-formed, and applied to every language.
  const r = spawnSync(process.execPath, [REKEY, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('the ledger\'s test fails an English change without its entry — a new t() key, a key reworded, a key leaving one part, a manifest key added, a manifest value changed — and passes it with the entry (1.10 B1)', () => {
  const base: RekeyBase = {
    v: 1, base: 'abc1234',
    keys: { 'Alpha': ['model'], 'Beta {0}': ['dashboard', 'text'], 'Gamma': ['host'] },
    nls: { a: hash16('Ay'), b: hash16('Bee') },
  }
  const tree = (over: Partial<Record<Part, string[]>>, english: Record<string, string> = { a: 'Ay', b: 'Bee' }): Tree => {
    const parts = { dashboard: ['Beta {0}'], host: ['Gamma'], model: ['Alpha'], text: ['Beta {0}'], ...over } as Record<Part, string[]>
    return { parts, keys: [...new Set(PARTS.flatMap((p) => parts[p]))], english }
  }
  const entry = (n: number, e: Omit<LedgerEntry, 'n' | 'by' | 'why'>): LedgerEntry => ({ n, by: 'P1', why: 'a test', ...e })
  assert.deepEqual(ledgerProblems(base, [], tree({})), [])
  // A new t() key: named until an add entry puts it into its part.
  const added = tree({ model: ['Alpha', 'Delta'] })
  const noEntry = ledgerProblems(base, [], added)
  assert.ok(noEntry.some((p) => p.includes('l10n/parts/model.de.json has "Delta"')) && noEntry.some((p) => p.includes('src/ has the t() key "Delta"')), noEntry.join('\n'))
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'add', part: 'model', key: 'Delta' })], added), [])
  // A key reworded: the new one unexplained, the old one kept.
  const reworded = tree({ model: ['Alpha now'] })
  assert.ok(ledgerProblems(base, [], reworded).some((p) => p.includes('lacks "Alpha"')))
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'reword', part: 'model', old: 'Alpha', key: 'Alpha now', carry: true })], reworded), [])
  // A key that leaves one part and stays in another (1.10 D2's shape): src/ still has it, the part does not.
  const moved = tree({ dashboard: [] })
  assert.ok(ledgerProblems(base, [], moved).some((p) => p.includes('l10n/parts/dashboard.de.json lacks "Beta {0}"')))
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'remove', part: 'dashboard', old: 'Beta {0}' })], moved), [])
  // A copy into a second part, and a review, apply where the key is.
  const copied = tree({ model: ['Alpha', 'Gamma'] })
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'copy', from: 'host', part: 'model', key: 'Gamma' }), entry(2, { kind: 'review', part: 'host', key: 'Gamma' })], copied), [])
  assert.ok(ledgerProblems(base, [entry(1, { kind: 'copy', from: 'text', part: 'model', key: 'Gamma' })], copied).some((p) => p.includes('the text part has no "Gamma" to copy')))
  // The manifest: a key added, a value changed.
  const nlsAdded = tree({}, { a: 'Ay', c: 'Sea', b: 'Bee' })
  assert.ok(ledgerProblems(base, [], nlsAdded).some((p) => p.includes('package.nls.json has c, which no nls-add entry')))
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'nls-add', key: 'c' })], nlsAdded), [])
  const nlsChanged = tree({}, { a: 'Ay, now', b: 'Bee' })
  assert.ok(ledgerProblems(base, [], nlsChanged).some((p) => p.includes('the English of a changed since abc1234')))
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'nls-reword', key: 'a' })], nlsChanged), [])
  const nlsGone = tree({}, { b: 'Bee' })
  assert.ok(ledgerProblems(base, [], nlsGone).some((p) => p.includes('package.nls.json lacks a')))
  assert.deepEqual(ledgerProblems(base, [entry(1, { kind: 'nls-remove', key: 'a' })], nlsGone), [])
  // An entry that cannot apply is named itself: a reworded key its part does not have.
  assert.ok(ledgerProblems(base, [entry(1, { kind: 'reword', part: 'host', old: 'Alpha', key: 'Alpha now', carry: false })], reworded)
    .some((p) => p.includes('l10n/rekey.json: entry 1 (reword): the host part has no "Alpha"')))
})

/**
 * Makes a fixture directory a tree the re-key script runs in, as `--start` leaves one: the registry (package.json's
 * language enum), the German parts (the script names the parts by them), a ledger with `entries`, its base, and the
 * language's pending list at cursor 0.
 */
function rekeyTree(dir: string, id: string, entries: LedgerEntry[]): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ contributes: { configuration: [{ properties: { 'tokenPace.language': { enum: ['auto', ...LANGUAGE_IDS] } } }] } }))
  for (const part of PARTS) cpSync(join(ROOT, 'l10n', 'parts', `${part}.de.json`), join(dir, 'l10n', 'parts', `${part}.de.json`))
  writeFileSync(join(dir, 'l10n', 'rekey.json'), `${JSON.stringify({ v: 1, base: 'abc1234', entries }, null, 2)}\n`)
  writeFileSync(join(dir, 'l10n', 'rekey-base.json'), `${JSON.stringify({ v: 1, base: 'abc1234', keys: {}, nls: {} }, null, 2)}\n`)
  mkdirSync(join(dir, 'l10n', 'pending'), { recursive: true })
  writeFileSync(join(dir, PENDING_FILE(id)), `${JSON.stringify({ v: 1, applied: 0, bundle: {}, nls: {} }, null, 2)}\n`)
}

/** Every file under a directory, path → bytes: what "a second run changes no byte" compares. */
function snapshot(dir: string, at = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, snapshot(dir, rel))
    else out[rel] = readFileSync(join(dir, rel), 'utf8')
  }
  return out
}

test('the re-key script over a whole language: a key added, a key reworded with its translation carried, a key removed, a manifest key added and one reworded — pending, T1–T14 green while PENDING_ALLOWED, and at the join each rule names what is pending (1.10 B1)', () => {
  const s = src()
  const partsOf = (k: string): Part[] => PARTS.filter((p) => s.germanParts[p].includes(k))
  const dir = fixture('german', 'fr')
  const added = 'Refresh'
  const carried = 'Not enough data for a summary yet.'
  const old = 'Not enough data for a summary so far.'
  const removed = 'A key src/ no longer has'
  const reworded = 'config.dashboard.sections.description'
  assert.ok(partsOf(added).length > 0 && partsOf(carried).length > 0 && s.english[reworded].split('\n\n').length > 1)
  // The language as it was before the English changed: the added key not there yet, the carried one under its old
  // English, a key the English has dropped since; `description` not in the manifest yet, and the reworded value a
  // translation of the English before its last paragraph.
  const carriedValue = readTable(join(dir, 'l10n', 'bundle.l10n.fr.json'))[carried]
  editKey(dir, 'fr', added, () => undefined)
  editKey(dir, 'fr', carried, () => undefined)
  for (const p of partsOf(carried)) edit(dir, `l10n/parts/${p}.fr.json`, (t) => { t[old] = carriedValue })
  edit(dir, 'l10n/parts/model.fr.json', (t) => { t[removed] = 'Une clé que src/ n’a plus' })
  edit(dir, 'package.nls.fr.json', (t) => { delete t.description; t[reworded] = t[reworded].split('\n\n').slice(0, -1).join('\n\n') })
  edit(dir, 'l10n/nls-sources/fr.json', (t) => { delete t.description; t[reworded] = '0000000000000000' })
  const entries = [
    ...partsOf(added).map((part) => ({ kind: 'add', part, key: added, why: 'a new button' })),
    ...partsOf(carried).map((part) => ({ kind: 'reword', part, old, key: carried, carry: true, why: 'a clearer word' })),
    { kind: 'remove', part: 'model', old: removed, why: 'no call site any more' },
    { kind: 'nls-add', key: 'description', why: 'a new manifest string' },
    { kind: 'nls-reword', key: reworded, why: 'a paragraph added' },
  ].map((e, i): LedgerEntry => ({ n: i + 1, by: 'P1', ...e }))
  rekeyTree(dir, 'fr', entries)
  const r = spawnSync(process.execPath, [REKEY], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)

  // While PENDING_ALLOWED, every rule holds: the list is what is left to do (a key the script failed to take out, T1
  // names: "… is no key of src/ (any more)"). 1.10 B3: T15 aside — it reads the bar under the id's own locale, and the
  // German under fr quotes “Mo 06:00” where a French bar prints “lun. 06:00” (the synthetic languages' test says so).
  for (const no of Object.keys(RULES).filter((x) => x !== 'T15')) {
    const problems = run(no, dir, 'fr', true)
    assert.deepEqual(problems, [], `${no} with the pending list:\n${problems.join('\n')}`)
  }
  // The list says what is left, the files say what the ledger did.
  const pending = JSON.parse(readFileSync(join(dir, PENDING_FILE('fr')), 'utf8')) as Pending
  assert.equal(pending.applied, entries.length)
  assert.deepEqual(pending.bundle, {
    [added]: { parts: partsOf(added), state: 'translate', why: 'a new button' },
    [carried]: { parts: partsOf(carried), state: 'review', why: 'a clearer word' },
  })
  assert.deepEqual(pending.nls, { description: { state: 'translate', why: 'a new manifest string' }, [reworded]: { state: 'review', why: 'a paragraph added' } })
  const fr = loadLang(dir, 'fr')
  assert.equal(fr.bundle![carried], carriedValue, 'the carried translation did not move to the new key')
  assert.deepEqual([own(fr.bundle!, old), own(fr.bundle!, added), own(fr.bundle!, removed), own(fr.parts.model!, removed)], [false, false, false, false])
  assert.deepEqual(Object.keys(fr.nls!), Object.keys(s.english), 'the added manifest key is not at the English file\'s position')
  assert.equal(fr.nls!.description, s.english.description)
  assert.equal(own(readTable(join(dir, 'l10n', 'nls-sources', 'fr.json')), 'description'), false, 'the added key was recorded as translated')

  // At the join, each rule names the key it holds.
  const strict = (no: string, ...needles: string[]): void => {
    const problems = run(no, dir, 'fr', false)
    for (const needle of needles) assert.ok(problems.some((p) => p.includes(needle)), `${no} at the join does not name ${J(needle)}:\n${problems.join('\n')}`)
  }
  strict('T1', `no translation of ${J(added)}`)
  strict('T2', `no translation of ${J(added)}`)
  strict('T5', `${reworded} — the paragraphs differ`)
  strict('T9', 'package.nls.fr.json: description is still the English text')
  strict('T12', 'fr: description — no record of the English it was translated from', `fr: ${reworded} — the English changed since its translation`)
  strict('T14', 'l10n/pending/fr.json is left')

  // Idempotent: a second run changes no byte.
  const before = snapshot(dir)
  const again = spawnSync(process.execPath, [REKEY], { cwd: dir, encoding: 'utf8' })
  assert.equal(again.status, 0, again.stderr)
  assert.deepEqual(snapshot(dir), before)
  assert.equal(spawnSync(process.execPath, [REKEY, '--check'], { cwd: dir, encoding: 'utf8' }).status, 0)
})

test('T14 catches a pending list for German, a cursor behind the ledger, a key src/ does not have, a part the German lacks, a review with nothing to review, a manifest key gone — and at the join any list at all (1.10 B1)', () => {
  // The build branch's rules (the lists read) whatever PENDING_ALLOWED says now; the join's last.
  const clean = fixture('german', 'fr')
  rekeyTree(clean, 'fr', [])
  assert.deepEqual(run('T14', clean, 'fr', true), [])
  const list = (dir: string, change: (p: Pending) => void): void => {
    const file = join(dir, PENDING_FILE('fr'))
    const p = JSON.parse(readFileSync(file, 'utf8')) as Pending
    change(p)
    writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`)
  }
  // An entry the script has not applied yet.
  const behind = fixture('german', 'fr')
  rekeyTree(behind, 'fr', [{ n: 1, by: 'P1', kind: 'add', part: 'dashboard', key: 'Refresh', why: 'x' }])
  caughtAs(true, 'T14', behind, 'fr', clean, 'has 0 of the ledger\'s 1 entries applied')
  // Keys the list may not name.
  const orphan = fixture('german', 'fr')
  rekeyTree(orphan, 'fr', [])
  list(orphan, (p) => {
    p.bundle['A key no source has'] = { parts: ['model'], state: 'translate', why: 'x' }
    p.bundle.Refresh = { parts: ['model'], state: 'translate', why: 'x' }
    p.nls['config.gone'] = { state: 'translate', why: 'x' }
  })
  caughtAs(true, 'T14', orphan, 'fr', clean, '"A key no source has" is no key of src/', '"Refresh" is listed for the model part, and l10n/parts/model.de.json does not have it',
    'config.gone is no key of package.nls.json')
  // A review with no value to review.
  const review = fixture('german', 'fr')
  rekeyTree(review, 'fr', [])
  editKey(review, 'fr', 'Mon', () => undefined)
  list(review, (p) => { p.bundle.Mon = { parts: ['model'], state: 'review', why: 'x' } })
  caughtAs(true, 'T14', review, 'fr', clean, '"Mon" is listed for review, and l10n/parts/model.fr.json has no value to review')
  // A list that is no JSON object.
  const broken = fixture('german', 'fr')
  rekeyTree(broken, 'fr', [])
  writeFileSync(join(broken, PENDING_FILE('fr')), '[1, 2]')
  caughtAs(true, 'T14', broken, 'fr', clean, 'l10n/pending/fr.json is not a JSON object')
  // German: never pending.
  const german = fixture('german', 'fr')
  rekeyTree(german, 'fr', [])
  writeFileSync(join(german, PENDING_FILE('de')), `${JSON.stringify({ v: 1, applied: 0, bundle: {}, nls: {} })}\n`)
  assert.ok(run('T14', german, 'de', true).some((p) => p.startsWith('de: l10n/pending/de.json exists')))
  // At the join (P20: PENDING_ALLOWED = false) an empty list is one too many.
  assert.ok(run('T14', clean, 'fr', false).some((p) => p.includes('fr: l10n/pending/fr.json is left')))
})

test('T9: a × or ÷ between two Latin words ends the run in a language of another script — zh-tw may write `scope × period × unit`, never `scope period unit` (1.10 B1, forLead 3, §7a Q19)', () => {
  const key = 'config.budgets.description'
  assert.ok(src().english[key].includes('one per scope × period × unit'), 'the English no longer names scope × period × unit')
  const clean = fixture('pseudo', 'zh-tw')
  const words = (dir: string, text: string): void => edit(dir, 'package.nls.zh-tw.json', (t) => {
    assert.ok(t[key].includes('語 × 語 × 語'), t[key])
    t[key] = t[key].replace('語 × 語 × 語', text)
  })
  for (const mark of ['×', '÷']) {
    const dir = fixture('pseudo', 'zh-tw')
    words(dir, `scope ${mark} period ${mark} unit`)
    assert.deepEqual(run('T9', dir, 'zh-tw'), [], `T9 fails \`scope ${mark} period ${mark} unit\``)
  }
  // No other mark ends a run, and a space least of all.
  for (const text of ['scope period unit', 'scope, period, unit', 'scope / period / unit', 'scope · period · unit']) {
    const dir = fixture('pseudo', 'zh-tw')
    words(dir, text)
    caught('T9', dir, 'zh-tw', clean, key, 'three Latin words in a row: "scope period unit"')
  }
})

test('the brief\'s 1.10 section: the pending list, --print, translate and review, the manifest keys and their record, the file deleted, the gates, and the notes the 1.10 keys need (1.10 B1)', () => {
  const brief = readFileSync(join(ROOT, 'l10n', 'TRANSLATING.md'), 'utf8')
  const flat = brief.replace(/\s+/g, ' ')
  for (const needed of [
    '## Working through your pending list (1.10)', '`l10n/pending/<id>.json`', 'node scripts/l10n-rekey.mjs --print <id>',
    '`translate`', '`review`', 'node scripts/nls-sources.mjs <id>', 'node scripts/nls-sources.mjs --check --strict <id>',
    'node scripts/l10n-rekey.mjs --check', 'test ! -e l10n/pending/<id>.json', 'out-test/prompts.test.js', 'PENDING_ALLOWED',
    // The notes of §3 B1 "Brief".
    '`{0} :`', 'U+00A0', '`{0}：`', '`（）`', '`、`', '`25%`', '`{0} ~ends at {1}%`', '*Records*', '*Agent entries*', 'run record',
    'press to cancel', '`×` between Latin words',
  ]) assert.ok(flat.includes(needed), `l10n/TRANSLATING.md does not say: ${needed}`)
  // The pending list is among the files a language package owns, and the brief says the English is frozen for it.
  assert.ok(flat.includes('| `l10n/pending/<id>.json` |'), 'the files table has no row for the pending list')
  assert.ok(flat.includes('the English is frozen while the languages are translated'))
})

// ---------------------------------------------------------------------------
// 1.10 B1: the freshness script and the pending lists
// ---------------------------------------------------------------------------

test('nls-sources --check calls a key on the pending list pending, not stale, and counts it; --strict — for every language or the ones named — counts it as a problem (1.10 B1)', () => {
  const dir = tempDir()
  const script = join(ROOT, 'scripts', 'nls-sources.mjs')
  const cli = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay', c: 'Sea' })
  writeJson(join(dir, 'package.nls.fr.json'), { b: 'Abeille', a: 'A', c: 'Mer' })
  writeJson(join(dir, 'package.nls.ja.json'), { b: '蜂', a: 'エー', c: '海' })
  assert.equal(cli('fr', 'ja').status, 0)
  // The English changes — `a` reworded, `d` added. Japanese is translated and recorded again; French has both on its
  // list, as scripts/l10n-rekey.mjs leaves them (the added key with the English value).
  writeJson(join(dir, 'package.nls.json'), { b: 'Bee', a: 'Ay, now', d: 'Dee', c: 'Sea' })
  writeJson(join(dir, 'package.nls.fr.json'), { b: 'Abeille', a: 'A', d: 'Dee', c: 'Mer' })
  writeJson(join(dir, 'package.nls.ja.json'), { b: '蜂', a: 'エー、今', d: 'ディー', c: '海' })
  assert.equal(cli('ja').status, 0)
  mkdirSync(join(dir, 'l10n', 'pending'), { recursive: true })
  const listed = (nls: Record<string, { state: string; why: string }>): void =>
    writeFileSync(join(dir, 'l10n', 'pending', 'fr.json'), `${JSON.stringify({ v: 1, applied: 2, bundle: {}, nls }, null, 2)}\n`)
  listed({ a: { state: 'review', why: 'reworded' }, d: { state: 'translate', why: 'added' } })
  const tolerant = cli('--check')
  assert.equal(tolerant.status, 0, tolerant.stderr)
  assert.match(tolerant.stdout, /nls-sources: fr: 2 key\(s\) pending in l10n\/pending\/fr\.json/)
  assert.match(tolerant.stdout, /nls-sources: every record is fresh \(2 language\(s\); 2 key\(s\) pending in 1\)/)
  const strict = cli('--check', '--strict')
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /fr: a — the English changed since its translation \(pending in l10n\/pending\/fr\.json; --strict allows none\)/)
  assert.match(strict.stderr, /fr: d — no record of the English it was translated from \(pending in l10n\/pending\/fr\.json/)
  // A language's own gate holds that language to every key, and the others as the build branch allows.
  assert.equal(cli('--check', '--strict', 'fr').status, 1)
  assert.equal(cli('--check', '--strict', 'ja').status, 0)
  assert.equal(cli('--strict', 'ja').status, 0, '--strict is a --check')
  assert.equal(cli('--check', 'fr').status, 1, 'a language is named only with --strict')
  assert.match(cli('--check', '--strict', 'xx').stderr, /xx: no package\.nls\.xx\.json/)
  // A stale key the list does not name is a problem, strict or not.
  listed({ d: { state: 'translate', why: 'added' } })
  const unlisted = cli('--check')
  assert.equal(unlisted.status, 1)
  assert.match(unlisted.stderr, /^nls-sources: fr: a — the English changed since its translation$/m)
  // Translated, recorded, the list deleted: fresh, strict or not.
  writeJson(join(dir, 'package.nls.fr.json'), { b: 'Abeille', a: 'A, maintenant', d: 'Dé', c: 'Mer' })
  assert.equal(cli('fr').status, 0)
  rmSync(join(dir, 'l10n', 'pending', 'fr.json'))
  const done = cli('--check', '--strict')
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /every record is fresh \(2 language\(s\)\)$/m)
})

// ---------------------------------------------------------------------------
// 1.11 A3: the frame learns the twelve new languages — before a single one is written
// ---------------------------------------------------------------------------

/** The thirteen languages on disk when 1.11 began (German and the twelve of 1.10): the ones whose verdicts must not change. */
const LANGUAGES_OF_1_10 = ['de', 'fr', 'es', 'pt-br', 'it', 'ja', 'ko', 'zh-cn', 'zh-tw', 'ru', 'tr', 'pl', 'cs'] as const
/** 1.11 §2.1: the twelve new languages' native names, in the collect row's order — the script each is written in. */
const NEW_IN_1_11: ReadonlyArray<readonly [string, string]> = [
  ['nl', 'Nederlands'], ['uk', 'Українська'], ['sv', 'Svenska'], ['nb', 'Norsk'], ['da', 'Dansk'], ['fi', 'Suomi'],
  ['hi', 'हिन्दी'], ['id', 'Bahasa Indonesia'], ['vi', 'Tiếng Việt'], ['el', 'Ελληνικά'], ['hu', 'Magyar'], ['ro', 'Română'],
]
/** Whether a native name is written in Latin letters: every letter of it one LATIN_WORD matches. */
const latinName = (native: string): boolean => (native.match(/[\p{L}\p{M}]+/gu) ?? []).every((w) => LATIN_WORD.test(w))

test('T9: NON_LATIN is the languages whose native name is not in Latin letters — the registry\'s and the twelve of 1.11 (Ukrainian, Greek, Hindi join; Vietnamese stays Latin: LATIN_WORD takes both words of "Tiếng Việt") (1.11 A3 rule 1)', () => {
  assert.deepEqual(['Tiếng', 'Việt'].map((w) => LATIN_WORD.test(w)), [true, true])
  const all = new Map<string, string>([...LANGUAGES.map((e): [string, string] => [e.id, e.native]), ...NEW_IN_1_11])
  assert.equal(all.size, LANGUAGES.length + NEW_IN_1_11.filter(([id]) => !isLanguageId(id)).length, 'a new id collides with another')
  for (const [id, native] of all) {
    if (id === 'en') continue
    assert.equal(NON_LATIN.has(id), !latinName(native), `${id} (${native}): ${NON_LATIN.has(id) ? 'in' : 'not in'} NON_LATIN`)
  }
  assert.deepEqual([...NON_LATIN].filter((id) => !all.has(id)), [], 'NON_LATIN names a language nobody plans')
  for (const id of ['uk', 'el', 'hi']) assert.ok(NON_LATIN.has(id), id)
})

test('T9 catches three Latin words in a row in the Devanagari fixture under hi — and a Hindi value written in Devanagari passes (1.11 A3 rules 1, 10)', () => {
  const clean = fixture('deva', 'hi')
  const key = keyWhere((k) => k === 'Not enough data for a summary yet.')
  const dir = fixture('deva', 'hi')
  editKey(dir, 'hi', key, () => `${DEVA_WORD}: not enough data yet`)
  caught('T9', dir, 'hi', clean, J(key), 'three Latin words in a row: "not enough data"')
  // Two Latin words and a code span are fine, as in every language of another script.
  const two = fixture('deva', 'hi')
  editKey(two, 'hi', key, () => `${DEVA_WORD} Claude Code ${DEVA_WORD} \`tokenPace.x\` data yet`)
  assert.deepEqual(run('T9', two, 'hi'), [])
})

test('T13 counts grapheme clusters: शुक्र is two, not five — the Devanagari fixture passes, a weekday word of five clusters fails (1.11 A3 rules 2, 10)', () => {
  assert.deepEqual([graphemes(DEVA_WORD), [...DEVA_WORD].length], [2, 5])
  assert.deepEqual(['मंगलवार', 'tirs.', 'Thứ 2', 'ti.', 'T2', 'Sze'].map(graphemes), [5, 5, 5, 3, 2, 3])
  const clean = fixture('deva', 'hi')
  assert.deepEqual(run('T13', clean, 'hi'), [], 'T13 fails a weekday word of two clusters and five code points')
  const dir = fixture('deva', 'hi')
  editKey(dir, 'hi', 'Mon', () => 'मंगलवार')
  caught('T13', dir, 'hi', clean, '"Mon" is "मंगलवार", 5 characters')
})

test('T13\'s two counts agree on the thirteen languages of 1.10: every weekday word of their bundles has as many grapheme clusters as code points, so no verdict changed (1.11 A3 rule 2)', () => {
  for (const id of LANGUAGES_OF_1_10) {
    const file = join(ROOT, 'l10n', `bundle.l10n.${id}.json`)
    assert.ok(existsSync(file), `${id}: no bundle`)
    const words = installed(readTable(file), () => weekdayWords())
    assert.equal(words.length, 7, id)
    for (const w of words) assert.equal(graphemes(w), [...w].length, `${id}: ${J(w)}`)
  }
})

test('T11/T15: ” opens a quotation — Swedish and Finnish ”…” and »…» quote an example and hold a {n}; the files on disk quote the same examples and hold the same {n} as with 1.10\'s marks (1.11 A3 rule 3)', () => {
  assert.deepEqual(quotedExamples('”CC 5h 25% · x” och »y»'), ['CC 5h 25% · x', 'y'])
  // With 1.10's openers the Swedish ”…” was no quotation at all (»…» was one already).
  assert.deepEqual(quotedExamples('”CC 5h 25% · x” och »y»', OPEN_QUOTES_1_10), ['y'])
  assert.equal(quoted('Kör ”{0}”', '{0}', OPEN_QUOTES_1_10), false)
  for (const [text, ph] of [['Kör ”{0}”', '{0}'], ['Kör »{0}»', '{0}'], ['Aja ”{1}”', '{1}'], ['Kør »{0}«', '{0}'], ['Kjør «{0}»', '{0}'], ['Rulați „{0}”', '{0}']] as const) {
    assert.ok(quoted(text, ph), `${text}: the {n} is not read as quoted`)
  }
  assert.equal(quoted('Kör {0}', '{0}'), false)
  // The files on disk: the English, German and the twelve 1.10 languages quote exactly what they quoted before.
  const manifests = [{ id: 'en', file: 'package.nls.json' }, ...LANGUAGES_OF_1_10.map((id) => ({ id, file: `package.nls.${id}.json` }))]
  let examples = 0
  for (const { file } of manifests) {
    for (const [k, v] of Object.entries(readTable(join(ROOT, file)))) {
      const now = quotedExamples(v)
      assert.deepEqual(now, quotedExamples(v, OPEN_QUOTES_1_10), `${file}: ${k}`)
      examples += now.length
    }
  }
  assert.ok(examples >= 14 * 12, `only ${examples} examples in the manifests`)
  let held = 0
  for (const id of LANGUAGES_OF_1_10) {
    for (const [k, v] of Object.entries(readTable(join(ROOT, 'l10n', `bundle.l10n.${id}.json`)))) {
      for (const ph of new Set(placeholders(k))) {
        assert.equal(quoted(v, ph), quoted(v, ph, OPEN_QUOTES_1_10), `${id}: ${J(k)} ${ph}`)
        assert.equal(quoted(k, ph), quoted(k, ph, OPEN_QUOTES_1_10), `the English ${J(k)} ${ph}`)
        if (quoted(k, ph)) held++
      }
    }
  }
  assert.ok(held > 0, 'no quoted {n} in any key')
})

test('T4 counts the marks of the NFC form and names the Greek ano teleia — NFC makes U+0387 the separator · (1.11 A3 rule 6)', () => {
  assert.equal(ANO_TELEIA.normalize('NFC'), '·')
  const clean = fixture('pseudo', 'el')
  // An ano teleia where the key has no separator: one · too many once normalised, and the mark named.
  const extra = fixture('pseudo', 'el')
  editKey(extra, 'el', 'Refresh', (v) => `${v}${ANO_TELEIA} 語`)
  caught('T4', extra, 'el', clean, '"Refresh" has 1 × ·, its key 0', '"Refresh" writes the Greek ano teleia (U+0387)')
  // An ano teleia for the key's own separator: the count holds after NFC, the mark is still named.
  const key = keyWhere((k) => count(k, '·') === 1)
  const swapped = fixture('pseudo', 'el')
  editKey(swapped, 'el', key, (v) => v.replace('·', ANO_TELEIA))
  const problems = run('T4', swapped, 'el')
  assert.deepEqual(problems, [`el: l10n/bundle.l10n.el.json: ${J(key)} writes the Greek ano teleia (U+0387), which NFC makes the separator · — write a comma or a full stop`])
  // In the manifest too, where · is not a counted mark.
  const nls = fixture('pseudo', 'el')
  edit(nls, 'package.nls.el.json', (t) => { t.description = `${t.description}${ANO_TELEIA}` })
  caught('T4', nls, 'el', clean, 'package.nls.el.json: description writes the Greek ano teleia')
})

test('T10 lets a language name the ledger just added be absent while its list names it `translate` — never at the join, never unlisted (1.11 A3 rule 11 a)', () => {
  // 1.11 P2: Dutch is a name of the registry now, and German has it — the fixture drops it, as a 1.10 language lacks it.
  const names = src().names.some((n) => n.english === 'Dutch') ? src().names : [...src().names, { id: 'nl', english: 'Dutch' }]
  const t10 = (dir: string, id: string, allowed: boolean): string[] => RULES.T10.rule({ ...src(), names }, loadLang(dir, id, allowed))
  const dir = fixture('german', 'fr')
  editKey(dir, 'fr', 'Dutch', () => undefined)
  assert.deepEqual(t10(dir, 'fr', true), ['fr: l10n/bundle.l10n.fr.json: the language name "Dutch" is not translated'], 'an unlisted name passed')
  mkdirSync(join(dir, 'l10n', 'pending'), { recursive: true })
  writeFileSync(join(dir, PENDING_FILE('fr')), `${JSON.stringify({ v: 1, applied: 1, bundle: { Dutch: { parts: ['model'], state: 'translate', why: 'a new language' } }, nls: {} }, null, 2)}\n`)
  assert.deepEqual(t10(dir, 'fr', true), [])
  assert.deepEqual(t10(dir, 'fr', false), ['fr: l10n/bundle.l10n.fr.json: the language name "Dutch" is not translated'])
  // Listed for review, the name must be there, translated.
  writeFileSync(join(dir, PENDING_FILE('fr')), `${JSON.stringify({ v: 1, applied: 1, bundle: { Dutch: { parts: ['model'], state: 'review', why: 'a new language' } }, nls: {} }, null, 2)}\n`)
  assert.deepEqual(t10(dir, 'fr', true), ['fr: l10n/bundle.l10n.fr.json: the language name "Dutch" is not translated'])
})

test('T10 takes a name equal to the English only by LANGUAGE_NAME_AS_ENGLISH — German\'s Hindi passes by its entry, a German Dutch or a Czech Hindi fails (1.11 A3 rule 11 b)', () => {
  // 1.11 L1 (pinned and changed: [['de', 'Hindi']]): the Latin-script languages of tier 2 write Hindi as the English does —
  // the lead's entries at L1's merge, each with its dictionary; a new entry is a deliberate change of this line.
  assert.deepEqual(LANGUAGE_NAME_AS_ENGLISH.map(([id, name]) => [id, name]),
    [['de', 'Hindi'], ['nl', 'Hindi'], ['da', 'Hindi'], ['sv', 'Hindi'], ['nb', 'Hindi'], ['fi', 'Hindi'], ['hu', 'Hindi'], ['ro', 'Hindi'], ['id', 'Hindi'],
      ['fr', 'Hindi'], ['es', 'Hindi'], ['pt-br', 'Hindi'], ['it', 'Hindi']])
  for (const [id, name, why] of LANGUAGE_NAME_AS_ENGLISH) {
    assert.ok(isLanguageId(id) && id !== 'en', `${id} is no language that translates`)
    assert.ok(name.length > 0 && why.trim().length > 0 && !why.includes('; '), `${id} ${name}: no reason`)
  }
  // 1.11 P2: Hindi and Dutch are names of the registry now — added only where it lacks them.
  const names = [...src().names, ...[{ id: 'hi', english: 'Hindi' }, { id: 'nl', english: 'Dutch' }].filter((x) => !src().names.some((n) => n.english === x.english))]
  const t10 = (dir: string, id: string): string[] => RULES.T10.rule({ ...src(), names }, loadLang(dir, id))
  const de = fixture('german', 'de')
  edit(de, 'l10n/bundle.l10n.de.json', (t) => { t.Hindi = 'Hindi'; t.Dutch = 'Niederländisch' })
  assert.deepEqual(t10(de, 'de'), [])
  edit(de, 'l10n/bundle.l10n.de.json', (t) => { t.Dutch = 'Dutch' })
  assert.deepEqual(t10(de, 'de'), ['de: l10n/bundle.l10n.de.json: the language name "Dutch" is not translated'])
  // 1.11 L5 (pinned and changed: the French case): French is on the list since L5's merge, so the language without an
  // entry is Czech (Hindština) — its "Hindi" must still fail.
  const cs = fixture('german', 'cs')
  edit(cs, 'l10n/bundle.l10n.cs.json', (t) => { t.Hindi = 'Hindi'; t.Dutch = 'Nizozemština' })
  assert.deepEqual(t10(cs, 'cs'), ['cs: l10n/bundle.l10n.cs.json: the language name "Hindi" is not translated'])
})

test('the brief\'s 1.11 sections: a new language, whole — the files, the register per language, Enter, the weekday words in graphemes, the quotation marks, the plurals, the marks, T15\'s message, the gates; and your pending list (1.11 A3, P1)', () => {
  const brief = readFileSync(join(ROOT, 'l10n', 'TRANSLATING.md'), 'utf8')
  const flat = brief.replace(/\s+/g, ' ')
  const whole = flat.indexOf('## 1.11: a new language, whole')
  const list = flat.indexOf('## 1.11: your pending list')
  assert.ok(whole > 0 && list > whole, 'the brief lacks its two 1.11 sections, in this order')
  const a = flat.slice(whole, list)
  for (const needed of [
    // The files, whole, and no list.
    'l10n/parts/<part>.<id>.json', 'package.nls.<id>.json', 'node scripts/merge-l10n.mjs', 'node scripts/nls-sources.mjs <id>',
    'never a pending list', 'the English at the frozen tip', 'the German as a second reference',
    // Register (§3 A4 rule 3, §7a Q16).
    '*ви*', '*आप*', '*Anda*', '*dumneavoastră*', '*Ön*', 'Finnish', 'passive', 'Vietnamese', '*u* or *je*', '**du**',
    'not verified against a style guide',
    // Key names (§3 D5, §7a Q19).
    '`Enter`', '`Ctrl+Enter`', '`⌘+Enter`',
    // Weekday words in graphemes (rule 2), quotation marks (rule 3), T15 (rule 4).
    'grapheme clusters', '`शुक्र`', '`tirs.`', '`tors.`', '`Thứ 2`', '`”…”`', '`»…»`', 'copy what T15 prints',
    // Plurals (rule 5), marks (rule 6), percent (rule 7).
    'Ukrainian', 'Romanian', 'one/few/many/other', 'one/few/other', 'Indonesian and Vietnamese have no plural',
    'U+0387', 'the separator `·`', '`।`', '`;`', 'em dash `—`', '`12,34,567`',
    // The five terms a package names, the report's first line, the gates of A4 rule 6.
    '"prompt"', '"record"', '"entry"', '"keep-warm"', '"cold start"', 'Not a native speaker: the translations are an AI agent\'s.',
    'node scripts/nls-sources.mjs --check --strict <id>', 'node scripts/l10n-rekey.mjs --check', 'test ! -e l10n/pending/<id>.json',
    'systemd-run --user --scope',
  ]) assert.ok(a.includes(needed), `the brief's "a new language, whole" does not say: ${needed}`)
  const b = flat.slice(list, flat.indexOf('## The gates', list))
  assert.ok(flat.indexOf('## The gates', list) > list, 'the gates no longer follow the 1.11 sections')
  for (const needed of ['node scripts/l10n-rekey.mjs --print <id>', '`translate`', '`review`', 'twelve language names', 'nls-add',
    'config.language.description', 'node scripts/nls-sources.mjs <id>', 'test ! -e l10n/pending/<id>.json', 'not answered in 1.11']) {
    assert.ok(b.includes(needed), `the brief's "your pending list" does not say: ${needed}`)
  }
  // The ids a package may own: the registry's twenty-six, the twelve new ones among them.
  for (const [id] of NEW_IN_1_11) assert.ok(flat.includes(`\`${id}\``), `the brief's file table does not name ${id}`)
})

// ---------------------------------------------------------------------------
// 1.12 P1: the frame for 1.12's texts — the names they carry, a name across a line break, the session-name placeholders
// ---------------------------------------------------------------------------

test('T9 takes a name of several words across any run of whitespace — "Claude\\n  Code" is Claude Code, never the name Claude and the English word Code; every name of SAME_IN_EVERY_LANGUAGE so (1.12 D4, L1-O2)', () => {
  assert.deepEqual(wordsOf('Der Claude\n  Code-Client'), ['Der', 'Client'])
  assert.deepEqual(wordsOf('Der Claude Code-Client'), ['Der', 'Client'])
  // The status-line consent's English breaks the name at a line's end: its words hold neither half of it.
  const consent = keyWhere((k) => /Claude\nCode's status line/.test(k))
  assert.equal(wordsOf(consent).some((w) => w === 'Code'), false, 'the consent\'s "Claude\\nCode" leaves the word Code')
  // Every name of several words, split by a line break, an indented one, a no-break space: no word of it is left.
  const spaced = SAME_IN_EVERY_LANGUAGE.map(([w]) => w).filter((w) => w.includes(' '))
  assert.ok(spaced.length >= 10, `only ${spaced.length} names of several words`)
  for (const name of spaced) {
    for (const gap of ['\n', '\n  ', ' ', ' \n']) {
      const text = `語 ${name.replace(/ /g, gap)} 語`
      assert.deepEqual(wordsOf(text), [], `${J(text)} leaves a word`)
      assert.equal(nonLatinLeft(`語 ${name.replace(/ /g, gap)} 語 x`), null, `${J(text)}: T9 reads the name as English`)
    }
  }
  // The pseudo-translation keeps a name split by a line break as it is, the words around it turned (the `s` stays: a unit).
  assert.equal(pseudo('as Claude\nCode\'s status line'), '語 Claude\nCode\'s 語 語')
  assert.equal(pseudo('as Visual\n  Studio Code runs'), '語 Visual\n  Studio Code 語')
  // A space is still no name: two words of a name, each in a text of its own, are what they are.
  assert.deepEqual(wordsOf('Quick\n\nnotes, Pick up'), ['Quick', 'notes', 'Pick', 'up'])
})

test('T9: the names 1.12\'s texts carry are in SAME_IN_EVERY_LANGUAGE, each with its reason — the credentials\' environment variable, service and command, the channels\' services, the protocols (1.12 E1 rule 2)', () => {
  assert.deepEqual(NAMES_OF_1_12.map(([w]) => w), ['CLAUDE_CODE_OAUTH_TOKEN', 'Secret Service', 'secret-tool', 'Slack', 'Discord',
    'Microsoft Teams', 'Mattermost', 'Rocket.Chat', 'Telegram', 'ntfy', 'BotFather', 'SMTP', 'STARTTLS'])
  const names = SAME_IN_EVERY_LANGUAGE.map(([w]) => w)
  assert.equal(new Set(names).size, names.length, 'a name stands twice in SAME_IN_EVERY_LANGUAGE')
  for (const [name, why] of NAMES_OF_1_12) {
    assert.ok(names.includes(name), `${name} is not in SAME_IN_EVERY_LANGUAGE`)
    assert.ok(why.trim().length > 10, `${name}: no reason`)
    // Taken out whole, in a Latin text and in a text of another script, at a line's end too.
    assert.deepEqual(wordsOf(`vor ${name} nach`), ['vor', 'nach'], name)
    assert.equal(nonLatinLeft(`語 ${name} 語 ${name.replace(/ /g, '\n')} 語`), null, name)
  }
  // Three of them in a row are three names, not English left, in a language of another script; three words beside them
  // that no list names still are.
  assert.equal(nonLatinLeft('語 Slack、Discord、Microsoft Teams 語 SMTP STARTTLS 語'), null)
  assert.match(nonLatinLeft('語 Slack or Signal and WhatsApp 語') ?? '', /three Latin words in a row: "or Signal and"/)
})

/** 1.12 D10 rule 2: every t() call of src/ with its arguments' source, and the calls of the name functions — read by the TypeScript parser, as scripts/l10n-extract.mjs reads the keys. */
interface SessionNameScan {
  calls: Array<{ file: string; fn: 't' | 'tr'; key: string; args: string[] }>
  sources: Array<{ file: string; callee: string }>
}
const SESSION_NAME_SCAN = `
const ts = require('typescript')
const fs = require('fs')
const path = require('path')
const root = process.cwd()
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name))
  : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [path.join(d, e.name)] : []).sort()
const importsT = (sf) => sf.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
  && /(^|\\/)i18n$/.test(s.moduleSpecifier.text) && s.importClause && s.importClause.namedBindings
  && ts.isNamedImports(s.importClause.namedBindings)
  && s.importClause.namedBindings.elements.some((el) => el.name.text === 't' && (!el.propertyName || el.propertyName.text === 't')))
const NAMES = new Set(['sessionName', 'sessionShortName', 'sessionIdName'])
const out = { calls: [], sources: [] }
for (const file of walk(path.join(root, 'src'))) {
  const label = path.relative(root, file).split(path.sep).join('/')
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const withT = importsT(sf)
  const withTr = sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === 'tr')
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const c = node.expression
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : ''
      const first = node.arguments[0]
      if (ts.isIdentifier(c) && ((withT && c.text === 't') || (withTr && c.text === 'tr')) && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        out.calls.push({ file: label, fn: c.text, key: first.text, args: node.arguments.slice(1).map((a) => a.getText(sf)) })
      }
      if (NAMES.has(name)) out.sources.push({ file: label, callee: name })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
process.stdout.write(JSON.stringify(out))
`
let sessionNameScanned: SessionNameScan | null = null
function sessionNameScan(): SessionNameScan {
  if (sessionNameScanned) return sessionNameScanned
  const r = spawnSync(process.execPath, ['-e', SESSION_NAME_SCAN], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `the scan of src/ failed:\n${r.stderr}`)
  sessionNameScanned = JSON.parse(r.stdout) as SessionNameScan
  return sessionNameScanned
}

/** The keys a scan finds: a call whose argument holds a carrier of its file, or a call of a name function — `key\u0000{n}\u0000form`. */
function sessionNameKeysOf(scan: SessionNameScan, carriers: ReadonlyArray<readonly [string, string, 'full' | 'short', string]>): string[] {
  const found = new Set<string>()
  for (const c of scan.calls) {
    c.args.forEach((arg, i) => {
      for (const [file, expr, form] of carriers) {
        if (c.file === file && new RegExp(`(?<![\\w$.])${reEsc(expr)}(?![\\w$])`).test(arg)) found.add(`${c.key}\u0000{${i}}\u0000${form}`)
      }
      const direct = /\b(sessionName|sessionShortName|sessionIdName)\s*\(/.exec(arg)
      if (direct) found.add(`${c.key}\u0000{${i}}\u0000${direct[1] === 'sessionShortName' ? 'short' : 'full'}`)
    })
  }
  return [...found].sort()
}

/** 1.12 R1-F5: the page's tr() calls whose argument holds a field a session's name travels in — `key\u0000{n}`. */
function pageNameCallsOf(scan: SessionNameScan): string[] {
  const found = new Set<string>()
  for (const c of scan.calls) {
    if (c.fn !== 'tr') continue
    c.args.forEach((arg, i) => {
      for (const [expr] of SESSION_NAME_PAGE_FIELDS) if (new RegExp(`(?<![\\w$])${reEsc(expr)}(?![\\w$])`).test(arg)) found.add(`${c.key}\u0000{${i}}`)
    })
  }
  return [...found].sort()
}

test('SESSION_NAME_KEYS: every key a t() key of src/ that holds its placeholder, and exactly the keys whose placeholder a session\'s name reaches — found by a scan of every t() call of src/ for the expressions that carry a name; the name functions\' calls pinned (1.12 D10 rules 1, 2)', () => {
  const s = src()
  const keys = SESSION_NAME_KEYS.map(([k]) => k)
  assert.equal(new Set(keys).size, keys.length, 'a key stands twice in SESSION_NAME_KEYS')
  for (const [key, ph, form] of SESSION_NAME_KEYS) {
    assert.ok(s.keys.includes(key), `${J(key)} is no t() key of src/ (any more)`)
    assert.ok(/^\{\d\}$/.test(ph) && key.includes(ph), `${J(key)} does not hold ${ph}`)
    assert.ok(form === 'full' || form === 'short', `${J(key)}: ${form}`)
  }
  // Review L named eight: the keep-warm tooltip's {1}, its screen-reader label's {0}, the four prompt-cache labels, the
  // Records' two. The scan found six more — a session's prompt-cache line.
  assert.deepEqual([SESSION_NAME_KEYS.length, SESSION_NAME_KEYS.filter(([, , f]) => f === 'short').length], [14, 2])
  const scan = sessionNameScan()
  assert.ok(scan.calls.length >= 1000, `the scan read only ${scan.calls.length} t() calls`)
  // The scan and the list: the same keys, the same placeholders, the same forms.
  assert.deepEqual(sessionNameKeysOf(scan, SESSION_NAME_CARRIERS), SESSION_NAME_KEYS.map(([k, ph, f]) => `${k}\u0000${ph}\u0000${f}`).sort())
  // Every carrier carries: a carrier no call uses is stale, and one in a file that does not have it is a typo.
  for (const carrier of SESSION_NAME_CARRIERS) {
    assert.ok(sessionNameKeysOf(scan, [carrier]).length > 0, `no t() call of ${carrier[0]} passes ${carrier[1]}`)
    assert.ok(carrier[3].length > 10, `${carrier[1]}: no source named`)
  }
  // No t() call passes a name function's result itself (the grep of D10 rule 2 finds none).
  assert.deepEqual(scan.calls.filter((c) => c.args.some((a) => /\bsession(?:Short|Id)?Name\s*\(/.test(a))).map((c) => c.key), [])
  // 1.12 R1-F5: the page's tr() calls are in the scan — main.ts's, the one file that defines tr —, and none passes a field
  // a session's name travels in (SESSION_NAME_PAGE_FIELDS); each field names its source.
  const tr = scan.calls.filter((c) => c.fn === 'tr')
  assert.ok(tr.length >= 300, `the scan read only ${tr.length} tr() calls of the page`)
  assert.deepEqual([...new Set(tr.map((c) => c.file))], ['src/webview/main.ts'])
  assert.deepEqual(pageNameCallsOf(scan), [])
  for (const [expr, why] of SESSION_NAME_PAGE_FIELDS) assert.ok(why.length > 10, `${expr}: no source named`)
  // The name functions' calls: where a session's name is made. A new one is a name that may reach a t() argument by an
  // expression this test does not know — trace it, then add its carrier and its keys.
  const counts = new Map<string, number>()
  for (const x of scan.sources) counts.set(`${x.file} ${x.callee}`, (counts.get(`${x.file} ${x.callee}`) ?? 0) + 1)
  assert.deepEqual([...counts.entries()].sort(), SESSION_NAME_SOURCES.map(([f, c, n]): [string, number] => [`${f} ${c}`, n]).sort())
})

test('SESSION_NAME_KEYS\' scan catches a key it does not list, a key it lists that no name reaches, and a name passed by a new expression (1.12 D10 rule 2)', () => {
  const scan = sessionNameScan()
  const listed = SESSION_NAME_KEYS.map(([k, ph, f]) => `${k}\u0000${ph}\u0000${f}`).sort()
  // A carrier gone: its keys are no longer found, and the list names more than the scan.
  const without = SESSION_NAME_CARRIERS.filter(([, expr]) => expr !== 's.name')
  assert.deepEqual(listed.filter((k) => !sessionNameKeysOf(scan, without).includes(k)).map((k) => k.split('\u0000')[0]), ['Largest session {0}: {1}', 'Longest session {0}: {1}'])
  // A t() call that passes a session's name by a carrier, or by a name function itself: the scan finds a key the list lacks.
  const extra: SessionNameScan = {
    calls: [...scan.calls, { file: 'src/cacheWatch.ts', fn: 't', key: 'New line for {0}', args: ['e.name'] },
      { file: 'src/stats.ts', fn: 't', key: 'Short {0} and {1}', args: ['n', 'sessionShortName(id, start, now, tcfg)'] }],
    sources: scan.sources,
  }
  const more = sessionNameKeysOf(extra, SESSION_NAME_CARRIERS).filter((k) => !listed.includes(k))
  assert.deepEqual(more, ['New line for {0}\u0000{0}\u0000full', 'Short {0} and {1}\u0000{1}\u0000short'])
  // The carrier is read in its own file only: `e.name` of another file is another thing.
  const elsewhere: SessionNameScan = { calls: [{ file: 'src/alerts.ts', fn: 't', key: 'Rule {0}', args: ['e.name'] }], sources: [] }
  assert.deepEqual(sessionNameKeysOf(elsewhere, SESSION_NAME_CARRIERS), [])
  // 1.12 R1-F5: a tr() call of the page that passes a tree row's name is caught — by its field, whole —; a bar's label is not.
  const page: SessionNameScan = { calls: [
    { file: 'src/webview/main.ts', fn: 'tr', key: 'Row {0} waits', args: ['esc(it.fullLabel)'] },
    { file: 'src/webview/main.ts', fn: 'tr', key: 'Row {0}: {1}', args: ['kind', 'it.label'] },
    { file: 'src/webview/main.ts', fn: 'tr', key: 'Bar {0}', args: ['esc(s.label)'] },
    { file: 'src/webview/main.ts', fn: 'tr', key: 'Id {0}', args: ['idNames.length'] },
  ], sources: [] }
  assert.deepEqual(pageNameCallsOf(page), ['Row {0} waits\u0000{0}', 'Row {0}: {1}\u0000{1}'])
})

test('the brief\'s 1.12 sections: your pending list — the ledger\'s start, the gates, notifications on a lock screen, alert ≠ notification, the hard wraps, the Keychain and "Always Allow", the chips, the budget example, the ellipsis, "record", the backtick names, the names of 1.12, the terms of 1.11, the report; and the session names — every key of SESSION_NAME_KEYS, the two forms, the four rules (1.12 E1 rule 4, D10 rule 3)', () => {
  const brief = readFileSync(join(ROOT, 'l10n', 'TRANSLATING.md'), 'utf8')
  const flat = brief.replace(/\s+/g, ' ')
  const list = flat.indexOf('## 1.12: your pending list')
  const names = flat.indexOf('## Session names and product names in placeholders (1.12)')
  const gates = flat.indexOf('## The gates')
  assert.ok(flat.indexOf('## 1.11: your pending list') < list && list < names && names < gates, 'the brief lacks its two 1.12 sections after 1.11\'s, before the gates')
  const a = flat.slice(list, names)
  for (const needed of [
    // The ledger, the list, the gates.
    'node scripts/l10n-rekey.mjs --start d39c2df', 'the twenty-four languages beyond English and German',
    '[the 1.10 section](#working-through-your-pending-list-110)', 'node scripts/l10n-rekey.mjs --print <id>', '`translate`', '`review`',
    'node scripts/merge-l10n.mjs', 'node scripts/nls-sources.mjs <id>', '[1.11: a new language, whole](#111-a-new-language-whole)',
    'test ! -e l10n/pending/<id>.json',
    // What is new (§3 E1 rule 4).
    'a phone\'s lock screen: keep them short', 'product name', '(#session-names-and-product-names-in-placeholders-112)',
    '**Alert ≠ notification.**', '`configuration.alerts.title`', 'must differ', 'in-editor popup',
    'hard wraps', 'Apple\'s name', '`Claude Code-credentials`', '"Always Allow"', 'macOS\'s own label', 'keep the English between your quotation marks',
    '"week to date" and "month to date"', 'the word you carried stays unless it is wrong',
    '`config.statusBar.show.enum.budget`', 'T15', 'the English\'s spacing of `…` is not a rule for your language',
    '**"record"** only for a personal best', '(T5)',
    '`chatId`', '`server`', '`host`', '`port`', '`security`', '`user`', '`from`', '`to`', '`format`', '`secretHeader`',
    '`agentWaiting`', '`agentDone`', '`quotaThreshold`', '`quotaExhausted`', '`quotaReset`', '`paceWarning`',
    '`SAME_IN_EVERY_LANGUAGE`', 'session, window, reset, quota, prompt, keep-warm, entry, record',
    'stay open', 'keep the value you have and say so',
    // The report.
    'Not a native speaker: the translations are an AI agent\'s.', 'exit codes',
    'notification, alert, channel, Keychain, secret storage, webhook, cooldown and test message',
    'false positive of the frame named with its key', 'reported, not changed', 'minutes',
  ]) assert.ok(a.includes(needed), `the brief's "1.12: your pending list" does not say: ${needed}`)
  for (const [name] of NAMES_OF_1_12) assert.ok(a.includes(`\`${name}\``), `the brief's 1.12 section does not name ${name}`)
  const b = flat.slice(names, gates)
  for (const needed of [
    '`SESSION_NAME_KEYS`', '**full**', '**short**', '"Session Tue 14:20 · 9d0eb37a"', '"Session 9d0eb37a"', '"Tue 14:20 · 9d0eb37a"',
    '`Session {0} · {1}`', '`Session {0}`', 'the keep-warm tooltip alone in its `{1}`',
    'never write your word for session before the placeholder', 'read twice',
    'agrees with **your word for session**', 'gender', 'Greek',
    '**A case ending cannot attach to a placeholder.**', '`({0})`', '`{0}:`', 'Russian, Czech, Polish, Ukrainian',
    '**A product-name placeholder**', 'Claude Code or Codex', 'never translated, never inflected',
    'which form its placeholder carries',
  ]) assert.ok(b.includes(needed), `the brief's session names section does not say: ${needed}`)
  // Every key of the list, whole, in backticks — in its form's paragraph.
  const full = b.slice(b.indexOf('**full**'), b.indexOf('**short**'))
  const short = b.slice(b.indexOf('**short**'))
  for (const [key, , form] of SESSION_NAME_KEYS) {
    assert.ok((form === 'full' ? full : short).includes(`\`${key}\``), `the brief does not name the ${form} key ${J(key)}`)
  }
  // The T9 rule's paragraph points to the 1.12 names and says a name holds across a line break.
  assert.ok(flat.includes('from 1.12 on the names of [1.12: your pending list](#112-your-pending-list)'))
  assert.ok(flat.includes('a name of several words also where a line break splits it (1.12)'))
})
