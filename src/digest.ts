// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Three to five plain sentences about the numbers already on screen.
 *
 * Rules, not a model: every sentence carries a figure and the basis it was computed from,
 * and a sentence whose figure is missing is left out rather than padded with a phrase. No
 * advice — "switch the model" is a recommendation nobody asked for, and it would be the
 * first line of this extension that is not a measurement.
 *
 * Deterministic: same input, same sentences, same order.
 */

import { SOURCE_TITLE } from './adapters'
import { t } from './i18n'
import { WindowDisplay } from './pace'
import { compact, usd } from './render'
import { Source } from './types'

/**
 * Structurally the part of the view model the rules read. Declared here rather than imported
 * so `digest.ts` stays a leaf: the view model calls into it, not the other way round.
 */
export interface DigestInput {
  kpis: Array<{ key: string; label: string; value: string; spark: number[] }>
  models: { rows: Array<{ model: string; cost: number; costShare: string; usage: number; share: string }> }
  cacheEconomy: Array<{ source: Source; hitRate: string; hitValue: number | null; savedUsd: string }>
  quotas: Array<{
    title: string
    windows: Array<{ label: string; percent: number; display: WindowDisplay; verdict: { text: string; measuring?: boolean } }>
  }>
  unpricedModels: string[]
  totals: Array<{ source: Source; title: string; rows: Array<{ label: string; usage: string }> }>
  showCost: boolean
}

const MAX_SENTENCES = 5
/** Above this share of cache reads the prompt cache is doing essentially all the work. */
const EXCELLENT = 80
const GOOD = 50

/** The quality label in the bracket behind a hit rate — a label of its own, not a fragment. */
function classify(rate: number): string {
  if (rate >= EXCELLENT) return t('excellent')
  if (rate >= GOOD) return t('good')
  return t('low')
}

/** Today against the mean of the seven days before it — the days themselves, not a fit. */
function todayVsWeek(spark: number[]): string | null {
  if (spark.length < 3) return null
  const today = spark[spark.length - 1]
  const before = spark.slice(Math.max(0, spark.length - 8), spark.length - 1)
  if (before.length === 0) return null
  const mean = before.reduce((a, b) => a + b, 0) / before.length
  if (mean <= 0) {
    return today > 0
      ? t('Today is the first day with usage in {0} days ({1} tokens).', before.length, compact(today))
      : null
  }
  const delta = ((today - mean) / mean) * 100
  const figure = Math.abs(delta).toFixed(0)
  // Above and below are two whole sentences: a direction word dropped into a slot cannot be
  // put into another language's word order.
  return delta >= 0
    ? t("Today's usage is {0} % above the {1}-day average ({2} vs {3} tokens per day).",
      figure, before.length, compact(today), compact(mean))
    : t("Today's usage is {0} % below the {1}-day average ({2} vs {3} tokens per day).",
      figure, before.length, compact(today), compact(mean))
}

function topModel(d: DigestInput): string | null {
  const rows = d.models.rows
  if (rows.length === 0) return null
  if (d.showCost) {
    const byCost = [...rows].sort((a, b) => b.cost - a.cost)[0]
    if (byCost.cost > 0) {
      return t('Most expensive model in this range: {0} at ~{1}, {2} of the API equivalent.',
        byCost.model, usd(byCost.cost), byCost.costShare)
    }
  }
  const byUsage = [...rows].sort((a, b) => b.usage - a.usage)[0]
  if (byUsage.usage <= 0) return null
  return t('Busiest model in this range: {0} with {1} tokens, {2} of the total.',
    byUsage.model, compact(byUsage.usage), byUsage.share)
}

function cacheSentence(d: DigestInput): string | null {
  const rows = d.cacheEconomy.filter((r) => r.hitValue !== null)
  if (rows.length === 0) return null
  const parts = rows.map(
    (r) => `${SOURCE_TITLE[r.source]} ${r.hitRate} (${classify(r.hitValue as number)})`,
  )
  return t('Cache hit rate — {0}.', parts.join(', '))
}

function unpricedSentence(d: DigestInput): string | null {
  if (!d.showCost || d.unpricedModels.length === 0) return null
  const n = d.unpricedModels.length
  const names = d.unpricedModels.join(', ')
  return n === 1
    ? t('{0} model without a price on file ({1}), so every cost figure here is a lower bound.', n, names)
    : t('{0} models without a price on file ({1}), so every cost figure here is a lower bound.', n, names)
}

/**
 * States in which the percentage still describes the window the sentence is written in the
 * present tense about. A reading taken before a reset that has already passed is the last
 * one of a window that is gone, and a window without a limit has no fullness at all — every
 * other view labels both, so the digest leaves them out rather than reporting them as now.
 */
const LIVE_DISPLAYS: WindowDisplay[] = ['normal', 'exhausted', 'overflow', 'limitReached']

function criticalWindow(d: DigestInput): string | null {
  let best: { title: string; label: string; percent: number; text: string } | null = null
  for (const q of d.quotas) {
    for (const w of q.windows) {
      if (!Number.isFinite(w.percent)) continue
      if (!LIVE_DISPLAYS.includes(w.display)) continue
      if (best === null || w.percent > best.percent) {
        // The same rule as the quota views: a verdict still measuring is not a fact about the
        // window, so the sentence ends at the percentage instead of carrying "measuring ·
        // window just reset" as if it were a pace.
        const text = w.verdict.measuring ? '' : w.verdict.text
        best = { title: q.title, label: w.label, percent: w.percent, text }
      }
    }
  }
  if (!best) return null
  const pct = Math.round(best.percent)
  return best.text
    ? t('The fullest quota window is {0} {1} at {2} % — {3}.', best.title, best.label, pct, best.text)
    : t('The fullest quota window is {0} {1} at {2} %.', best.title, best.label, pct)
}

/**
 * The summary section. Sentences appear in a fixed order and only when their figure exists,
 * so an empty install gets a short digest instead of a confident one.
 */
export function digest(d: DigestInput): string[] {
  const usage = d.kpis.find((k) => k.key === 'usage')
  const out: (string | null)[] = [
    usage ? todayVsWeek(usage.spark) : null,
    topModel(d),
    cacheSentence(d),
    unpricedSentence(d),
    criticalWindow(d),
  ]
  return out.filter((s): s is string => s !== null).slice(0, MAX_SENTENCES)
}
