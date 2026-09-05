// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which settings govern which dashboard section.
 *
 * The gear in a section header opens the settings editor filtered to this list, so a reader
 * who wonders why a section looks the way it does lands on the handful of settings that
 * decide it instead of on every setting the extension has. Every entry is a real id from
 * `contributes.configuration` — a test asserts that against package.json, because an id that
 * no longer exists would silently filter the editor down to nothing.
 *
 * Every list ends with `tokenPace.dashboard.sections`: whichever section the reader is
 * looking at, "should this be here at all, and in what order" is a question about that one.
 */

import type { DashboardSectionKey } from './viewModel'

export const SECTION_SETTINGS: Record<DashboardSectionKey, string[]> = {
  quota: [
    'tokenPace.quotaSource', 'tokenPace.claudeQuotaSources', 'tokenPace.codexQuotaSources',
    'tokenPace.pollIntervalMinutes', 'tokenPace.pollOnlyWhenFocused', 'tokenPace.staleAfterMinutes',
    'tokenPace.pace.sensitivity', 'tokenPace.pace.tolerancePoints', 'tokenPace.pace.minElapsedPercent',
    'tokenPace.pace.levels', 'tokenPace.windowSelect', 'tokenPace.planName',
    'tokenPace.quotaHistoryDays', 'tokenPace.alerts.thresholds', 'tokenPace.alerts.basis',
    'tokenPace.dashboard.sections',
  ],
  // Connecting the status line is a command, not a setting. What a setting decides here is
  // how old a reading may be before the card calls it stale, and whether the same reading
  // also gets a status bar item of its own.
  context: [
    'tokenPace.staleAfterMinutes', 'tokenPace.statusBar.show', 'tokenPace.dashboard.sections',
  ],
  summary: [
    'tokenPace.summary.period', 'tokenPace.summary.scope', 'tokenPace.dayBoundaryHour',
    'tokenPace.startOfWeek', 'tokenPace.timezone', 'tokenPace.showCost',
    'tokenPace.resetHourCycle', 'tokenPace.dashboard.sections',
  ],
  kpis: [
    'tokenPace.showCost', 'tokenPace.pricing.multiplier', 'tokenPace.pricing.showListPrice',
    'tokenPace.dashboard.defaultRange', 'tokenPace.dashboard.sections',
  ],
  tokens: [
    'tokenPace.attribution', 'tokenPace.showProjectNames', 'tokenPace.showCost',
    'tokenPace.dashboard.sections',
  ],
  chart: [
    'tokenPace.chart.modelStyle', 'tokenPace.dashboard.topN', 'tokenPace.showCost',
    'tokenPace.dashboard.sections',
  ],
  models: [
    'tokenPace.dashboard.modelRows', 'tokenPace.customPrices', 'tokenPace.unknownModelPricing',
    'tokenPace.pricing.showListPrice', 'tokenPace.dashboard.sections',
  ],
  heatmap: [
    'tokenPace.startOfWeek', 'tokenPace.dayBoundaryHour', 'tokenPace.timezone',
    'tokenPace.dashboard.sections',
  ],
  hours: [
    'tokenPace.startOfWeek', 'tokenPace.dayBoundaryHour', 'tokenPace.timezone',
    'tokenPace.dashboard.sections',
  ],
  records: ['tokenPace.dashboard.topN', 'tokenPace.dashboard.sections'],
  tools: ['tokenPace.retentionDays', 'tokenPace.dashboard.sections'],
  budget: ['tokenPace.budgets', 'tokenPace.alerts.budgetPercent', 'tokenPace.dashboard.sections'],
  history: ['tokenPace.quotaHistoryDays', 'tokenPace.dashboard.sections'],
  projects: ['tokenPace.showProjectNames', 'tokenPace.attribution', 'tokenPace.dashboard.sections'],
  sessions: ['tokenPace.showProjectNames', 'tokenPace.attribution', 'tokenPace.dashboard.sections'],
  dataQuality: [
    'tokenPace.retentionDays', 'tokenPace.hourRetentionDays', 'tokenPace.claudeDir',
    'tokenPace.codexDir', 'tokenPace.debug', 'tokenPace.dashboard.sections',
  ],
}

/**
 * The settings-editor query the gear opens: `@id:` and the ids, comma separated, which is
 * how the editor filters down to a set of settings rather than to a search term that happens
 * to appear in their descriptions.
 */
export function sectionSettingsQuery(key: DashboardSectionKey): string {
  return '@id:' + SECTION_SETTINGS[key].join(',')
}
