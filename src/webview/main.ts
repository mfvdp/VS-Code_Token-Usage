// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard webview's script — the only code in this repository that runs in a browser.
 *
 * It used to be a template string inside src/dashboard.ts, which meant the compiler never
 * saw a line of it: a typo, a wrong arity or a DOM property that does not exist survived
 * every gate and was found, if at all, in a real window. Here it is a module with its own
 * tsconfig (lib DOM, strict, no Node types), built by build.mjs and handed to the extension
 * bundle as text through the virtual module 'webview:script'. Nothing about the page
 * changed: it is still one nonced inline script, it still loads nothing from anywhere, and
 * it still declares its state and its renderers in the page's own scope.
 *
 * Two names it does not declare itself. `SRC_TITLE` and `SRC_IDS` belong to the provider
 * registry, and the registry is Node code (fs, os, path) that cannot be part of a browser
 * bundle; src/dashboard.ts writes them as two consts at the top of the same <script>, and
 * globals.d.ts beside this file declares them for the compiler.
 *
 * The view model arrives as JSON over postMessage. Its typed shape lives in src/viewModel.ts,
 * which this bundle cannot import for the same reason, and writing those three hundred fields
 * out a second time would be a second table to drift from the first — the very thing the
 * provider registry exists to prevent. So the payload keeps the only honest type it has on
 * this side of the wire (`Payload` below) and every renderer goes on guarding the fields it
 * reads, exactly as it did while it was a string. What the compiler is here for is the rest:
 * the DOM work, the control flow, the arithmetic and the arities.
 */

/**
 * A value that reaches this script untyped: a field of the posted view model, or a node off
 * an event that the helper it lands in only ever pokes at defensively. The one place in this
 * file that gives up a type — everything the compiler can check is checked.
 */
type Payload = any

const vscode = acquireVsCodeApi();
let vm: Payload = null;
let costLine = false;
/** Model chips beyond the first four, shown on request. Local: a chip is not a setting. */
let allModels = false;
/** The range presets beyond today / 7d / 30d, shown on request. Local for the same reason. */
let allRanges = false;
/** The two date fields, opened by the "custom…" chip. Also local — the range itself is not. */
let showDates = false;
/** The day the drill panel was last scrolled to, so a refresh of the same day stays put. */
let shownDrill: string | null = null;
const esc = (s: unknown): string => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"']/g, c => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string, string>)[c]));
const post = (m: unknown): void => vscode.postMessage(m);

/**
 * The page's own words, in the reader's language.
 *
 * Everywhere else in this repository a string goes through `t()` from src/i18n.ts. That
 * module is Node code and a webview has no module loader, so src/dashboard.ts builds one
 * dictionary with `t()` at render time and writes it in front of this module as `L10N` — the
 * same trick the provider registry's two consts use. A string is looked up by its English
 * text and falls back to it, which is why an English build needs no dictionary at all and why
 * a key nobody translated reaches the reader in English rather than blank.
 *
 * `{0}`, `{1}`, … are filled from the arguments and a translation may reorder them; every
 * argument is escaped by its caller, because what comes back is concatenated into markup.
 * The values themselves carry no markup — test/dashboard.test.ts holds the dictionary to it.
 */
function tr(key: string, ...args: Array<string | number>): string {
  const template = word(L10N, key) || key;
  if (!args.length) return template;
  return template.replace(/\{(\d+)\}/g, (m: string, i: string) => {
    const a = args[Number(i)];
    return a === undefined ? m : String(a);
  });
}

function pct(v: unknown): number { return Math.max(0, Math.min(100, Number(v) || 0)); }

/**
 * A bar with its marks. the gap flag paints the pace gap into it — the fill beyond the elapsed
 * marker darker, the track between the fill and the marker a stronger grey — and is only asked for by
 * a quota window that has a clock and a limit to compare against: a window that has just
 * reset, or one with no limit, has no gap to show. The marker itself never moves.
 */
function bar(percent: number, cls: string, elapsed: number | null | undefined,
             forecastEnd: number | null | undefined, aria: Payload, gap?: boolean): string {
  // Every value from the payload is escaped or coerced before it becomes markup — the class
  // and the aria numbers included, however enum-like they look in the view model.
  const c = esc(cls);
  const max = aria && Number.isFinite(Number(aria.max)) ? Number(aria.max) : 100;
  const now = aria && Number.isFinite(Number(aria.now)) ? Math.round(Number(aria.now)) : Math.round(percent);
  let h = '<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="'
    + max + '" aria-valuenow="' + now
    + '" aria-valuetext="' + esc(aria ? aria.text : '') + '">'
    + '<div class="fill ' + c + '" data-w="' + pct(percent).toFixed(2) + '"></div>';
  const clock = elapsed !== null && elapsed !== undefined;
  if (clock && gap) {
    const p = pct(percent), e = pct(elapsed);
    if (p > e) {
      h += '<span class="fill over ' + c + '" data-x="' + e.toFixed(2) + '" data-w="'
        + (p - e).toFixed(2) + '" title="' + tr('used beyond the elapsed share') + '"></span>';
    } else if (e > p) {
      h += '<span class="slack" data-x="' + p.toFixed(2) + '" data-w="' + (e - p).toFixed(2)
        + '" title="' + tr('elapsed share not yet used') + '"></span>';
    }
  }
  if (clock) {
    h += '<i class="mark" data-x="' + pct(elapsed).toFixed(2) + '" title="'
      + tr('time elapsed in this window') + '"></i>';
  }
  if (forecastEnd !== null && forecastEnd !== undefined) {
    h += '<i class="mark fc" data-x="' + pct(forecastEnd).toFixed(2) + '" title="'
      + tr('projected at the reset') + '"></i>';
  }
  return h + '</div>';
}

/** The pace levels a sparkline segment can wear; anything else keeps the provider colour. */
var SPARK_LEVELS = ['ok', 'warn', 'warn2', 'error'];

/** One reading placed on the box: the geometry the renderer and the hover both read. */
interface SparkPoint {
  x: number; y: number; t: number; r: number | null;
  level: string; reset: boolean; label: string;
}

/** A slotted spark's box and its readings, in viewBox units. */
interface SparkGeom {
  W: number; H: number; xAt: (t: unknown) => number | null; pts: SparkPoint[];
}

/** One stroke of a spark: a run of coordinates in one class, or the class-less drop. */
interface SparkSeg { cls: string; neutral: boolean; coords: string[] }

function sparkLevel(pt: Payload): string {
  return SPARK_LEVELS.indexOf(pt.level) >= 0 ? pt.level : '';
}

/** True when there is a line to draw: two array values, or one point of a slotted spark. */
function hasSpark(s: Payload): boolean {
  if (Array.isArray(s)) return s.length > 1;
  return !!(s && Array.isArray(s.points) && s.points.length > 0);
}

/**
 * The geometry of a slotted spark, shared by the renderer and the hover so the two never
 * place a reading differently: x is time, one unit per 15-minute slot from the grid's start,
 * y the inverted percentage on a box 100 high. A payload without the grid's bounds, or a
 * point without its time, falls back to the slot index — the same axis in whole slots. Null
 * when there is nothing to draw.
 */
function sparkGeometry(spark: Payload): SparkGeom | null {
  if (!spark || !Array.isArray(spark.points)) return null;
  const W = Number(spark.slots);
  if (!(W > 0)) return null;
  const from = Number(spark.from), to = Number(spark.to);
  const scale = Number.isFinite(from) && Number.isFinite(to) && to > from ? W / (to - from) : null;
  const xAt = (t: unknown) => scale !== null && Number.isFinite(Number(t)) ? (Number(t) - from) * scale : null;
  const pts: SparkPoint[] = [];
  for (const pt of spark.points) {
    if (!pt || !Number.isFinite(Number(pt.i)) || !Number.isFinite(Number(pt.p))) continue;
    const x = xAt(pt.t);
    const r = pt.r !== null && pt.r !== undefined && Number.isFinite(Number(pt.r)) ? Number(pt.r) : null;
    pts.push({
      x: x === null ? Math.round(Number(pt.i)) : x, y: 100 - pct(pt.p), t: Number(pt.t), r: r,
      level: sparkLevel(pt), reset: !!pt.reset, label: typeof pt.label === 'string' ? pt.label : '',
    });
  }
  return pts.length ? { W: W, H: 100, xAt: xAt, pts: pts } : null;
}

/**
 * Seven days of one window, time-proportional: the viewBox is one unit per 15-minute slot,
 * so a stretch without readings is exactly as wide as the time it covers — and the line is
 * drawn straight across it, from the last reading before to the first one after. Consecutive
 * points become polylines, split wherever the pace level changes: the stroke between two
 * points wears the level of the later one. Into a point the view model marked as one the
 * window turned over before, the line holds the old value in the old level up to the moment
 * the old window ended, drops there vertically in a neutral two-point stroke to the new
 * value, and continues from it. A single reading is the round-cap hairline. Percentages
 * above 100 sit on the top edge rather than leaving the box. The ref names the provider and
 * the window the spark belongs to, so the hover can find its readings in the view model
 * again. A plain array (the KPI sparks) takes the older renderer.
 */
function sparkSvg(spark: Payload, ref?: { src: Payload; win: Payload }): string {
  if (Array.isArray(spark)) return sparkArraySvg(spark);
  const g = sparkGeometry(spark);
  if (!g) return '';
  const W = g.W, H = g.H, pts = g.pts;
  const num2 = (v: number) => String(Math.round(v * 100) / 100);
  const at = (x: number, y: number) => num2(x) + ',' + y.toFixed(1);
  let body = '';
  if (pts.length === 1) {
    const cls = pts[0].level;
    body = '<path class="pt' + (cls ? ' ' + cls : '') + '" d="M' + num2(pts[0].x) + ' '
      + pts[0].y.toFixed(1) + 'h.01"/>';
  } else {
    // One stroke per pair of neighbours, wearing the level of the later point, so equal
    // neighbours share a polyline. The neutral drop stands alone: nothing joins it, and the
    // coloured run starts again after it.
    const segs: SparkSeg[] = [];
    const add = (cls: string, neutral: boolean, a: string, b: string) => {
      const last = segs.length ? segs[segs.length - 1] : null;
      if (last && !last.neutral && !neutral && last.cls === cls) last.coords.push(b);
      else segs.push({ cls: cls, neutral: neutral, coords: [a, b] });
    };
    for (let k = 1; k < pts.length; k++) {
      const prev = pts[k - 1], s = pts[k];
      if (!s.reset) { add(s.level, false, at(prev.x, prev.y), at(s.x, s.y)); continue; }
      // The window turned over between the two readings. Where the old one ended is its
      // announced reset when that lies between them — the clock of the last reading before
      // the turn, so the drop stands where the window ended, not where VS Code happened to
      // be open again — and otherwise the new reading's own x. The drop ends at the new
      // reading's value, never at a 0 nobody measured (a rolling window ends above it); the
      // tail is left out when the drop already stands at the reading.
      const known = prev.r !== null && prev.t < prev.r && prev.r <= s.t ? g.xAt(prev.r) : null;
      const xDrop = known === null ? s.x : known;
      add(prev.level, false, at(prev.x, prev.y), at(xDrop, prev.y));
      add('', true, at(xDrop, prev.y), at(xDrop, s.y));
      if (num2(xDrop) !== num2(s.x)) add(s.level, false, at(xDrop, s.y), at(s.x, s.y));
    }
    for (const sg of segs) {
      body += '<polyline' + (sg.cls ? ' class="' + sg.cls + '"' : '') + ' points="'
        + sg.coords.join(' ') + '"/>';
    }
  }
  // The rectangle is the pointer's target — see the stylesheet — and lies over the strokes;
  // the empty path after it is the marker of the hovered reading, given its one coordinate
  // by the script (no element is created at hover time). The svg itself can take the focus:
  // the readings are stepped through with the arrow keys, and the label names what a screen
  // reader cannot see.
  const overlay = '<rect class="ov" x="0" y="0" width="' + W + '" height="' + H + '"/>'
    + '<path class="hov"/>';
  const names = ref ? ' data-src="' + esc(ref.src) + '" data-win="' + esc(ref.win) + '"' : '';
  const aria = typeof spark.aria === 'string' && spark.aria ? spark.aria : tr('quota sparkline, 7 days');
  return '<div class="sparkbox"><svg class="spark q" viewBox="0 0 ' + W + ' ' + H + '" '
    + 'preserveAspectRatio="none" role="img" tabindex="0" aria-label="' + esc(aria) + '"' + names + '>'
    + body + overlay + '</svg><div class="pop" role="tooltip" aria-live="polite" hidden></div></div>';
}

/** A list of 0..100 values evenly spaced, with -1 for a break: the KPI sparks. */
function sparkArraySvg(values: number[]): string {
  const n = values.length;
  if (!n) return '';
  const W = 100, H = 20;
  const segs: string[][] = []; let cur: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < 0) { if (cur.length) segs.push(cur); cur = []; continue; }
    const x = n <= 1 ? W / 2 : (i / (n - 1)) * W;
    const y = H - (pct(v) / 100) * H;
    cur.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  if (cur.length) segs.push(cur);
  const body = segs.map(s => s.length === 1
    ? '<path class="pt" d="M' + s[0].split(',')[0] + ' ' + s[0].split(',')[1] + 'h.01"/>'
    : '<polyline points="' + s.join(' ') + '"/>').join('');
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" '
    + 'aria-hidden="true">' + body + '</svg>';
}

// -- words ------------------------------------------------------------------

/** The provider titles and ids are the registry's, written in front of this module
 *  by src/dashboard.ts and declared in globals.d.ts — see the file header. */

/**
 * An own-property lookup with a string result. A bare map[key] answers "constructor" with a
 * function, and a stray key must never turn into markup.
 */
function word(map: Record<string, string>, key: string): string {
  return typeof map[key] === 'string' ? map[key] : '';
}

/** The provider as the reader knows it; an unknown source keeps whatever it is called. */
function srcName(source: Payload): string {
  return word(SRC_TITLE, source) || String(source === null || source === undefined ? '' : source);
}

/**
 * "5 h" alone is ambiguous the moment both providers have one. The title goes in front of
 * every window label that stands on its own — cards, list items, table rows — and each part
 * is its own unbreakable span, so a 300 px sidebar breaks such a heading at the separator
 * rather than between the "7" and the "d" of the label itself.
 */
function srcLabel(source: Payload, label: Payload): string {
  const l = label === null || label === undefined ? '' : String(label);
  const t = word(SRC_TITLE, source);
  const parts: string[] = [];
  if (t) parts.push(t);
  if (l) parts.push(l);
  return parts.map(p => '<span class="nobr">' + esc(p) + '</span>').join(' · ');
}

/**
 * The window states in words, for the fallback below and nowhere else. Built on the call
 * rather than kept as a table, because the words are the reader's language and a table would
 * be translated once, at load. It has no fallback of its own on purpose — an unknown state
 * prints nothing rather than leaking an identifier into the sentence — and "resetDue" is
 * deliberately absent from it: the reset line is the one place that says a window has reset,
 * and a card that said it twice, once in its header and once beside the verdict, is what this
 * pair of helpers exists to prevent.
 */
function displayWords(): Record<string, string> {
  return {
    normal: '', exhausted: tr('exhausted'), overflow: tr('over the limit'),
    unlimited: tr('unlimited'), limitReached: tr('limit reached'),
  };
}

/**
 * resetLine and stateText are worded once, in the view model, so this card, the QuickPick
 * and the markdown view cannot say the same window differently. The two functions below are
 * only the fallback for a payload from a build that predates those fields; they follow the
 * same rules and say nothing the view model would not.
 */
function fbResetLine(w: Payload): string {
  const due = tr('reset due');
  if (w.display === 'resetDue') return due;
  const r = w.reset === null || w.reset === undefined ? '' : String(w.reset);
  if (!r) return '';
  // A reset text that already says the window has reset is a sentence, not a duration.
  return r.indexOf(due) >= 0 ? r : tr('resets {0}', r);
}

function fbStateText(w: Payload): string {
  const s = word(displayWords(), w.display);
  if (!s) return '';
  const said = w.verdict && typeof w.verdict.text === 'string' ? w.verdict.text : '';
  return said.toLowerCase().indexOf(s) >= 0 ? '' : s;
}

/** A string the view model carries, or the fallback when this payload has none. */
function orElse(value: Payload, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

// -- controls ---------------------------------------------------------------

/** Chips beyond this many are folded away; four is what fits a sidebar on one line. */
const MODEL_CHIPS = 4;
/** The ranges that are always on the bar. The rest are one chip away. */
const RANGE_CHIPS = ['today', '7d', '30d'];

/**
 * The two icons the bar draws. Inline SVG on purpose: the page loads nothing from anywhere,
 * so an icon font is not an option — and a glyph typed into the markup would end up in the
 * copied text of the page.
 */
const ICON_REFRESH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M11.2 4.2A5 5 0 0 1 6.8 12.9"/>'
  + '<path fill="currentColor" d="M5.5 12.3L6.4 14.6L7.2 11.1Z"/>'
  + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4.8 11.8A5 5 0 0 1 9.2 3.1"/>'
  + '<path fill="currentColor" d="M10.5 3.7L9.6 1.4L8.8 4.9Z"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" fill-rule="evenodd" d="M14.8 6.4L14.8 9.6L12.9 9.6L12.5 10.3'
  + 'L13.9 11.7L11.7 13.9L10.3 12.5L9.6 12.9L9.6 14.8L6.4 14.8L6.4 12.9L5.7 12.5L4.3 13.9'
  + 'L2.1 11.7L3.5 10.3L3.1 9.6L1.2 9.6L1.2 6.4L3.1 6.4L3.5 5.7L2.1 4.3L4.3 2.1L5.7 3.5'
  + 'L6.4 3.1L6.4 1.2L9.6 1.2L9.6 3.1L10.3 3.5L11.7 2.1L13.9 4.3L12.5 5.7L12.9 6.4Z'
  + 'M5.7 8A2.3 2.3 0 1 0 10.3 8A2.3 2.3 0 1 0 5.7 8Z"/></svg>';

/** The gear that opens the settings this section is made of. */
function gear(key: string): string {
  const label = tr('Settings for this section');
  return '<button class="gear" data-act="sectionSettings" data-key="' + esc(key)
    + '" aria-label="' + label + '" title="' + label + '">'
    + ICON_GEAR + '</button>';
}

/**
 * A range preset as the chip says it. The ids that are already a figure — "7d", "30d" — read
 * the same in every language; the rest are words. An id this build does not know keeps its
 * own name: a chip nobody can read is still a range the reader can leave.
 */
function presetLabel(preset: Payload): string {
  const p = String(preset === null || preset === undefined ? '' : preset);
  const words: Record<string, string> = {
    today: tr('today'), yesterday: tr('yesterday'), thisWeek: tr('thisWeek'),
    thisMonth: tr('thisMonth'), lastMonth: tr('lastMonth'), year: tr('year'), all: tr('all'),
  };
  return esc(word(words, p) || p);
}

/**
 * The filter bar: a labelled grid of three rows — range, providers, models — with the labels
 * in a column of their own, so the chips line up under each other instead of running on as
 * one paragraph of buttons. Everything it decides is view state; nothing here is a setting.
 */
function controls(): string {
  const r = vm.range;
  // A selected preset is never folded away, the way a filtered-on model is not: a chip the
  // reader cannot see is a range they cannot leave.
  const presets = r.presets.filter((p: Payload) => allRanges || RANGE_CHIPS.indexOf(p) >= 0 || r.preset === p);
  const restRanges = r.presets.length - presets.length;
  const chips = presets.map((p: Payload) => '<button data-act="range" data-preset="' + esc(p) + '" aria-pressed="'
    + (r.preset === p) + '">' + presetLabel(p) + '</button>').join('');
  const providers = SRC_IDS.map(s => '<button data-act="provider" data-src="' + s
    + '" aria-pressed="' + (vm.ui.providers.indexOf(s) >= 0) + '">' + esc(srcName(s))
    + '</button>').join('');
  // The table splits main and sub-agent rows per model; the filter does not, so the same
  // name would otherwise appear twice as two chips that toggle the same thing.
  const names = [];
  for (const m of vm.models.rows || []) {
    if (names.indexOf(m.model) < 0) names.push(m.model);
    if (names.length >= 12) break;
  }
  // The table is filtered by the very chips this row draws, so a model filtered down to
  // nothing in this range has no row to take its name from. Its chip is added anyway: a
  // filter with no chip is a filter the reader cannot see and cannot switch off, and the
  // sections would go on saying "no data in this range" about a range that has plenty.
  for (const n of vm.ui.models) if (names.indexOf(n) < 0) names.push(n);
  // Beyond four the row is one chip until it is asked for — a dozen model names is the widest
  // thing on the bar. A filtered-on model stays visible whatever the fold says.
  const many = names.length > MODEL_CHIPS;
  const openRow = !many || allModels;
  const shown = names.filter(n => openRow || vm.ui.models.indexOf(n) >= 0);
  const models = (openRow ? '' : '<button data-act="moreModels">'
      + tr('models ({0}) ▾', names.length) + '</button>')
    + shown.map(name => '<button data-act="model" data-model="'
      + esc(name) + '" aria-pressed="' + (vm.ui.models.indexOf(name) >= 0) + '">'
      + esc(name) + '</button>').join('')
    + (vm.ui.models.length ? '<button data-act="clearModels">' + tr('clear') + '</button>' : '')
    + (openRow && many ? '<button data-act="moreModels">' + tr('fewer ▴') + '</button>' : '');
  // The two date fields are the rarest control on the page and the widest; they stay folded
  // until the range is one they belong to, or until the reader asks for them.
  const custom = r.preset === 'custom' || r.preset === 'all' || showDates;
  const dates = custom
    ? '<div class="wrap full"><label class="meta" for="tp-from">' + tr('from') + '</label>'
      + '<input id="tp-from" type="date" data-role="from" value="' + esc(r.from) + '">'
      + '<label class="meta" for="tp-to">' + tr('to') + '</label>'
      + '<input id="tp-to" type="date" data-role="to" value="' + esc(r.to) + '">'
      + '<button data-act="customRange">' + tr('apply') + '</button></div>'
    : '';
  return '<div class="bar">'
    + '<span class="meta">' + tr('Range') + '</span>'
    + '<div class="wrap">' + chips
    + '<button data-act="customDates" aria-pressed="' + custom + '">' + tr('custom…') + '</button>'
    + (restRanges > 0 ? '<button data-act="moreRanges">' + tr('more ▾') + '</button>' : '')
    + (allRanges && r.presets.length > RANGE_CHIPS.length
       ? '<button data-act="moreRanges">' + tr('fewer ▴') + '</button>' : '')
    // The range in words ends the row it belongs to rather than taking a line of its own.
    + '<span class="meta cap">' + esc(r.label) + ' · ' + esc(r.from) + ' → ' + esc(r.to)
    + '</span></div>'
    + '<button class="icon" data-act="refresh" aria-label="' + tr('Refresh') + '"'
    + ' title="' + tr('Rebuild from the transcripts and fetch the quota') + '">' + ICON_REFRESH + '</button>'
    + dates
    + '<span class="meta">' + tr('Providers') + '</span><div class="wrap span2">' + providers + '</div>'
    + (names.length ? '<span class="meta">' + tr('Models') + '</span><div class="wrap span2">' + models
       + '</div>' : '')
    + '</div>';
}

// -- sections ---------------------------------------------------------------

function sSummary(): string {
  if (!vm.digest.length) return '<p class="empty">' + tr('Not enough data for a summary yet.') + '</p>';
  return '<ul>' + vm.digest.map((s: Payload) => '<li>' + esc(s) + '</li>').join('') + '</ul>';
}

function quotaCard(q: Payload): string {
  let h = '<div class="card"><div class="row"><span class="name">' + esc(q.title) + '</span>'
    + '<span class="meta' + (q.stale ? ' warn' : '') + '">'
    // planText already carries the word "plan" and, for a name out of the settings, the
    // "(as configured)" that keeps it apart from something a provider said.
    + [q.planText ? esc(q.planText) : '', q.origin ? esc(q.origin) : '',
       q.ageText ? esc(q.ageText) : ''].filter(Boolean).join(' · ')
    + (q.stale ? ' ⚠ ' + tr('stale') : '') + '</span></div>';
  if (q.problem) {
    h += '<div class="box" role="status">' + esc(q.problem)
      + (q.problemKind ? ' <span class="meta">(' + esc(q.problemKind) + ')</span>' : '')
      + (q.problemAction ? '<br><button data-act="cmd" data-id="' + esc(q.problemAction.command)
         + '">' + esc(q.problemAction.label) + '</button>' : '')
      + '</div>';
  }
  for (const w of q.windows) {
    const f = w.forecast;
    const end = f && f.endPercent !== null && f.endPercent !== undefined ? f.endPercent : null;
    const reset = orElse(w.resetLine, fbResetLine(w));
    const state = orElse(w.stateText, fbStateText(w));
    // A window still measuring has no pace to report; the sentence that said so at length
    // ("measuring · window just reset") is not printed anywhere.
    const said = w.verdict && !w.verdict.measuring && typeof w.verdict.text === 'string'
      ? w.verdict.text : '';
    // A window whose stated reset has passed is not being judged: the reading belongs to the
    // window before it, which is why the bar below is neutral and its explanation is titled
    // "Why grey". The verdict beside them is that same reading, so it wears neither the pace
    // colour nor the warning arrow — a red "▲ exhausted" over a grey bar is the card
    // contradicting its own explanation.
    const judged = w.display !== 'resetDue';
    const verdict = [said ? (judged && w.level !== 'ok' ? '▲ ' : '') + esc(said) : '', esc(state)]
      .filter(Boolean).join(' · ');
    // Why the bar wears its colour, on hover and on focus: the block is focusable and points
    // at its own explanation, the same way a key figure does. A payload without the field —
    // an older build — gets neither the attributes nor an empty panel.
    const ex = w.explain && Array.isArray(w.explain.lines) ? w.explain : null;
    const popId = ex ? 'pop-q-' + String(q.source) + '-' + String(w.id).replace(/[^A-Za-z0-9_-]/g, '-') : '';
    // The verdict goes into the header row, between the label and the figure, so the card
    // spends no line of its own on it; the elapsed marker and the darker fill beyond it say
    // the same thing in the bar underneath.
    h += '<div class="win"' + (ex ? ' tabindex="0" data-explain aria-describedby="' + esc(popId) + '"' : '')
      + '><div class="win-top"><span>' + esc(w.label)
      + (reset ? ' · ' + esc(reset) : '') + '</span>'
      + (verdict ? '<span class="verdict' + (judged ? ' ' + esc(w.level) : '') + '">'
         + verdict + '</span>' : '')
      + '<b>' + esc(w.percentText) + '</b></div>'
      // A limit the provider itself reports as reached is red wherever it is drawn — the
      // status bar paints the alarm for it whatever the percentage says — so the bar here
      // says the same rather than letting the pace decide a colour it did not decide.
      + bar(w.percent, !judged ? 'neutral' : w.display === 'limitReached' ? 'error' : w.level,
            w.elapsed, end, w.aria, judged && w.display !== 'unlimited');
    // A forecast that only repeats a word the card has already printed — in the verdict, in
    // the state beside it or in the reset line — is not a second fact. A "full" forecast on a
    // window that has just reset is dropped for a second reason: the reading it is built on
    // belongs to the window before the reset, which is why the bar is neutral, not red. A
    // forecast still measuring has nothing to say about the window yet and is not a line.
    const trusted = !(w.display === 'resetDue' && f && f.state === 'full')
      && !(f && f.state === 'measuring');
    // Word for word against each line already on the card, never as a substring: a forecast
    // that merely contains a word said above it is still a sentence of its own.
    const printed = [said.toLowerCase(), state.toLowerCase(), reset.toLowerCase()];
    if (f && f.text && trusted && printed.indexOf(f.text.toLowerCase()) < 0) {
      h += '<div class="meta">' + esc(f.text) + '</div>';
    }
    if (hasSpark(w.spark)) h += sparkSvg(w.spark, { src: q.source, win: w.id });
    if (ex) h += explainPop(ex, popId);
    h += '</div>';
  }
  // The sparklines' span, said once per card rather than under each of them. Only the slotted
  // spark covers seven days; a payload from a build that still sends the 24-hour list gets no
  // caption that would misstate it.
  if (q.windows.some((w: Payload) => w.spark && !Array.isArray(w.spark) && hasSpark(w.spark))) {
    h += '<div class="meta">' + tr('sparkline: last 7 days') + '</div>';
  }
  if (q.extra) {
    h += '<div class="win"><div class="win-top"><span>'
      + (q.extra.billed ? tr('Extra usage (billed)') : tr('Extra usage'))
      + '</span><b>' + esc(q.extra.text) + '</b></div>'
      + (q.extra.utilization === null ? ''
         : bar(q.extra.utilization, 'extra', null, null,
               { now: Math.round(q.extra.utilization), max: 100, text: q.extra.text }))
      + '</div>';
  }
  // Only ever present when the provider reported no window at all. It is a count, not a
  // window: no bar, no percentage, no pace — the sentence itself says what it is not.
  if (q.localBlock) h += '<div class="box info" role="status">' + esc(q.localBlock.text) + '</div>';
  // The bridge's prompt-cache line, last, and only when the status line delivered one: the
  // words are the view model's, dashes included, and the countdown in them is as of the
  // model's own clock — nothing here ticks on its own.
  if (q.promptCache && q.promptCache.text) {
    // Its own age, like the context card's: the header above belongs to the source that won
    // the quota race, which is not the mirror this line was read from. A payload without the
    // fields — an older build — is marked neither fresh nor stale.
    const aged = q.promptCache.fresh === false;
    const seen = [q.promptCache.ageText ? tr('updated {0}', esc(q.promptCache.ageText)) : '',
      aged ? '⚠ ' + tr('stale') : ''].filter(Boolean).join(' · ');
    h += '<div class="meta' + (aged ? ' warn' : '') + '" title="'
      + esc(q.promptCache.note) + '">' + esc(q.promptCache.text)
      + (seen ? ' · ' + seen : '') + '</div>';
  }
  // The full freshness row and the official page stay in the markdown view, where there is
  // room for them, and the tooltip links the official page from the provider name.
  return h + '</div>';
}

/**
 * Why a window wears its colour: the title names the colour, the lines say what the bar was
 * judged from. Every word is the view model's — the same lines the markdown prints under its
 * table and the Quick Pick carries as the item detail. Written hidden and left in the markup,
 * like the KPI panel, so the block has something to point at with aria-describedby.
 */
function explainPop(e: Payload, id: string): string {
  return '<div class="pop" role="tooltip" id="' + esc(id) + '" hidden>'
    + '<div><b>' + esc(e.title) + '</b></div>'
    + e.lines.map((l: Payload) => '<div>' + esc(l) + '</div>').join('')
    + '</div>';
}

/**
 * The problem kinds the two exits below actually repair. A card that failed for any other
 * reason — offline, a rejected token, a retry pending — keeps its own problem box: offering
 * "fetch it now" to a window that is already fetching, or the status line to a token the
 * provider refused, would name an exit that leads nowhere.
 */
var INVITE_KINDS = ['consentPending', 'modeCache', 'quotaOff', 'noFile', 'unknown'];

/**
 * No reading at all. The manager always builds one card per provider, so "no cards" is not
 * the state a user is in: what they see is a card per provider with nothing in it. Both are
 * the same situation and both end here — every card carries no window, no extra usage and a
 * problem one of the two exits repairs.
 */
function noReadingYet(): boolean {
  if (!vm.quotas.length) return true;
  return vm.quotas.every(function (q: Payload) {
    return (!q.windows || !q.windows.length) && !q.extra && !!q.problem
      && INVITE_KINDS.indexOf(q.problemKind || 'unknown') >= 0;
  });
}

/**
 * A state with two exits, and naming them is the whole point: nothing here invents a
 * percentage, it says how one could be read. What each provider is waiting for is kept as a
 * line below, so the reason is not lost with the cards it replaces.
 */
function quotaInvitation(): string {
  const why = vm.quotas.map(function (q: Payload) {
    return q.problem ? esc(q.title) + ': ' + esc(q.problem) : '';
  }).filter(Boolean).join(' · ');
  // One key, not three lines added together: a translator needs the whole sentence.
  return '<div class="box info" role="status">'
    + tr('No quota reading yet. There are two ways to get one: fetch it from the provider, which asks for network access first, or connect the Claude Code status line, which mirrors the figures Claude Code already has on this machine.')
    + '<br><button data-act="cmd" data-id="tokenPace.refreshQuota">' + tr('Fetch quota now') + '</button> '
    + '<button data-act="cmd" data-id="tokenPace.connectStatusLine">' + tr('Connect the status line')
    + '</button>'
    + (why ? '<div class="meta">' + why + '</div>' : '')
    + '</div>';
}

function sQuota(): string {
  if (noReadingYet()) return quotaInvitation();
  return vm.quotas.map(quotaCard).join('')
    + '<div class="legend"><span><i class="dot time"></i>' + tr('time elapsed') + '</span>'
    + '<span><i class="dot fc"></i>' + tr('projected at the reset') + '</span></div>';
}

/**
 * One Claude Code session's context window.
 *
 * Deliberately not a quota card: no verdict, no pace, no forecast, and a dim bar rather than a
 * coloured one — a full context window is a fact about a conversation, not a warning about an
 * account. Without a window size there is no bar and no percentage at all, only the tokens.
 */
function sContext(): string {
  const c = vm.context;
  if (!c) {
    return '<p class="empty">' + tr('No context reading. The Claude Code status line is what reports it.')
      + '<br><button data-act="cmd" data-id="tokenPace.connectStatusLine">'
      + tr('Connect the status line') + '</button></p>';
  }
  const age = [c.ageText ? tr('updated {0}', esc(c.ageText)) : '', c.fresh ? '' : '⚠ ' + tr('stale')]
    .filter(Boolean).join(' · ');
  let h = '<div class="card"><div class="row"><span class="name">' + tr('Context window') + '</span>'
    + '<span class="meta' + (c.fresh ? '' : ' warn') + '">' + age + '</span></div>'
    + '<div class="win"><div class="win-top"><span>' + esc(c.note) + '</span><b>'
    + esc(c.text) + '</b></div>';
  // A bar needs a denominator. With none, the tokens stand alone — a full-width bar would
  // claim the conversation is full, an empty one that it is empty.
  if (c.size !== null && c.percentText !== '–') {
    h += bar(pctOf(c), 'neutral', null, null,
      { now: Math.round(pctOf(c)), max: 100, text: tr('context window: {0}', c.text) });
  }
  return h + '</div></div>';
}

/** The share the card draws, read back from the text the view model already rounded. */
function pctOf(c: Payload): number {
  const n = parseFloat(String(c.percentText));
  return isFinite(n) ? n : 0;
}

/**
 * The colour of a delta, from the figure's polarity and from nothing else. An arrow with no
 * direction to judge — "new", a rounding dot, a figure that is neither good nor bad up — is
 * dim: a colour there would state a verdict the number does not carry.
 */
function deltaClass(k: Payload): string {
  const p = k.polarity;
  const glyph = k.delta ? k.delta.glyph : '';
  if (p !== 'upGood' && p !== 'upBad') return 'neutral';
  if (glyph === '▲') return p === 'upGood' ? 'good' : 'bad';
  if (glyph === '▼') return p === 'upGood' ? 'bad' : 'good';
  return 'neutral';
}

/**
 * One labelled line of an explanation. An empty text writes nothing at all: a "Compared with"
 * with nothing behind it would announce a comparison that was never made.
 */
function popLine(label: string, text: Payload): string {
  const t = text === null || text === undefined ? '' : String(text);
  return t ? '<div><b>' + esc(label) + '</b> ' + esc(t) + '</div>' : '';
}

/**
 * The card's own explanation, every word of it from the view model. The provider names are
 * the registry's, the same ones every other heading uses.
 *
 * Hidden until it is hovered or focused, and it stays in the markup either way: the card
 * points at it with aria-describedby, and an element that is written only on hover has no id
 * to point at.
 */
function kpiPop(k: Payload, id: string): string {
  const e = k.explain;
  if (!e) return '';
  return '<div class="pop" role="tooltip" id="' + esc(id) + '" hidden>'
    + popLine(tr('What'), e.what)
    + popLine(tr('How'), e.how)
    + popLine(tr('Period'), e.period)
    + (e.compare ? popLine(tr('Compared with'), e.compare.against + ' · ' + e.compare.previous) : '')
    + (e.split
       ? popLine(tr('Split'), srcName('claude') + ' ' + e.split.claude + ' · '
         + srcName('codex') + ' ' + e.split.codex)
       : '')
    + popLine(tr('Basis'), e.provenance)
    + popLine(tr('Spark'), e.sparkNote)
    + '</div>';
}

function sKpis(): string {
  return '<div class="kpis">' + vm.kpis.map((k: Payload) => {
    const d = k.delta
      ? '<span class="d ' + deltaClass(k)
        + '">' + [k.delta.glyph, k.delta.text].filter(Boolean).map(esc).join(' ') + '</span>'
      : '';
    // Focusable, because an explanation only a mouse can reach is not an explanation. No
    // title attribute beside it: two tooltips over one card is one of them too many.
    const id = 'pop-' + String(k.key);
    return '<div class="kpi" tabindex="0" data-explain aria-describedby="' + esc(id) + '">'
      + '<div class="l">' + esc(k.label) + '</div><div class="v">' + esc(k.value) + '</div>'
      + '<div class="meta">' + d + '</div>' + sparkSvg(normSpark(k.spark))
      + kpiPop(k, id) + '</div>';
  }).join('') + '</div>';
}

/** KPI sparks are absolute values; the shared renderer wants 0..100. */
function normSpark(values: number[]): number[] {
  const max = Math.max.apply(null, values.concat([0]));
  return max > 0 ? values.map(v => (v / max) * 100) : values.map(() => 0);
}

/**
 * Why a row is marked. Worded once, here and in the markdown view, because the two views
 * print the same table and a caveat phrased twice is read as two different caveats.
 */
function approxNote(): string {
  return tr('≈ marks a lower bound: the oldest hours of the span are already rolled up into day totals');
}

/**
 * The words the totals table and the model table share. One heading per column, translated
 * once: the same word heads the column and prefixes the cell in the stacked layout, where
 * `td[data-h]::before` prints exactly this text.
 */
function columnWords(): Record<string, string> {
  return {
    period: tr('Period'), usage: tr('Usage'), freshInput: tr('Fresh in'),
    cacheWrite5m: tr('Write 5m'), cacheWrite1h: tr('Write 1h'), cacheRead: tr('Cache read'),
    output: tr('Output'), reasoning: tr('Reasoning'), requests: tr('Req.'), cacheHit: tr('Hit'),
    perRequest: tr('Per req.'), cost: tr('API cost'), model: tr('Model'), share: tr('Share'),
  };
}

function totalsTable(t: Payload): string {
  const cost = vm.showCost;
  const w = columnWords();
  const head = [w.period, w.usage, w.freshInput, w.cacheWrite5m, w.cacheWrite1h, w.cacheRead,
    w.output, w.reasoning, w.requests, w.cacheHit, w.perRequest].concat(cost ? [w.cost] : []);
  const rows = t.rows.map((r: Payload) => '<tr>'
    // The span is the tooltip of the label, not a column: the two window rows are the only
    // ones whose bounds are not already spelled out by their name.
    + '<td data-h="' + w.period + '" title="' + esc(r.spanText || '') + '">' + esc(r.label) + '</td>'
    + '<td data-h="' + w.usage + '">' + esc(r.usage) + '</td>'
    + '<td data-h="' + w.freshInput + '">' + esc(r.freshInput) + '</td>'
    + '<td data-h="' + w.cacheWrite5m + '">' + esc(r.cacheWrite5m) + '</td>'
    + '<td data-h="' + w.cacheWrite1h + '">' + esc(r.cacheWrite1h) + '</td>'
    + '<td data-h="' + w.cacheRead + '">' + esc(r.cacheRead) + '</td>'
    + '<td data-h="' + w.output + '">' + esc(r.output) + (r.incomplete
        ? ' <span title="' + tr('output is a lower bound: some requests had no terminal line')
          + '">⚠</span>' : '')
    + '</td>'
    + '<td data-h="' + w.reasoning + '">' + esc(r.reasoning) + '</td>'
    + '<td data-h="' + w.requests + '">' + esc(r.requests) + '</td>'
    + '<td data-h="' + w.cacheHit + '">' + esc(r.cacheHit) + '</td>'
    + '<td data-h="' + w.perRequest + '">' + esc(r.perRequest) + '</td>'
    + (cost ? '<td data-h="' + w.cost + '">' + esc(r.cost) + (r.costPartial
        ? ' <span title="' + tr('some models have no price on file') + '">⚠</span>' : '')
      + '</td>' : '')
    + '</tr>').join('');
  const approx = t.rows.some((r: Payload) => r.approx);
  return '<div class="card"><div class="name">' + esc(t.title) + '</div><div class="scroll"><table>'
    + '<thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + (approx ? '<div class="meta">' + esc(approxNote()) + '</div>' : '') + '</div>';
}

/** Where the tokens of a period went — the six counted fields as one bar. */
/** A fixed colour per field, so the same part keeps its colour across providers and updates. */
const PART_CLASS: Record<string, string> = {
  freshInput: 'c1', cacheWrite5m: 'c2', cacheWrite1h: 'c3', cacheRead: 'c4', output: 'c5',
  reasoning: 'c6',
};

/** The three parts the cache chip puts aside; everything else is always drawn. */
const CACHE_PARTS = ['cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

/**
 * A round token count, the way every composition tooltip and caption prints one — in the
 * page's own language, so a tooltip never states in "248,922" what the table beside it prints
 * as "248,9K". This is render.ts's `full()`, unit for unit.
 */
function fullNum(n: number): string {
  return Math.round(n).toLocaleString(LOCALE);
}

/** 'noCache' only when the view model says so; anything else is the full mix. */
function cacheMode(): string {
  return vm.ui && vm.ui.compositionCache === 'noCache' ? 'noCache' : 'all';
}

/**
 * One switch for both bars. Cache reads are an order of magnitude larger than the rest on a
 * normal day, which leaves the other five parts as hairlines; hiding them is the only way to
 * read the mix, and the caption under each bar names what was set aside so the shares cannot
 * be mistaken for shares of everything.
 */
function cacheChips(): string {
  const mode = cacheMode();
  const chip = (value: Payload, label: Payload) => '<button data-act="compositionCache" data-mode="' + value
    + '" aria-pressed="' + (mode === value) + '">' + label + '</button>';
  return '<div class="row"><span class="meta">' + tr('cache') + '</span><span class="wrap">'
    + chip('all', tr('shown')) + chip('noCache', tr('hidden')) + '</span></div>';
}

function compositionBar(c: Payload): string {
  const noCache = cacheMode() === 'noCache';
  // Reasoning is a subset of output; adding it as its own slice would count it twice.
  const counted = c.parts.filter((p: Payload) => p.key !== 'reasoning' && p.tokens > 0);
  const parts = noCache ? counted.filter((p: Payload) => CACHE_PARTS.indexOf(p.key) < 0) : counted;
  // The shares are shares of what is drawn. A bar that kept the old denominator would not
  // add up to its own width, which is why the caption below states what is missing.
  const total = parts.reduce((s: Payload, p: Payload) => s + p.tokens, 0);
  if (!total) return '';
  const cls = (p: Payload) => word(PART_CLASS, p.key) || 'c6';
  const segs = parts.map((p: Payload) => '<i class="cs ' + cls(p) + '" data-w="'
    + ((p.tokens / total) * 100).toFixed(2) + '" title="' + esc(p.text) + ': '
    + fullNum(p.tokens) + ' · ' + Math.round((p.tokens / total) * 100) + ' %"></i>').join('');
  const sum = (keys: Payload) => c.parts.reduce((s: Payload, p: Payload) => s + (keys.indexOf(p.key) >= 0 ? p.tokens : 0), 0);
  // Only the halves that were really set aside are named: a provider that never writes cache
  // would otherwise be told a "0 cache write" the table beside it prints as a dash.
  const read = sum(['cacheRead']);
  const written = sum(['cacheWrite5m', 'cacheWrite1h']);
  // One sentence per case rather than halves added together: which half comes first, and
  // what stands between them, is a translator's decision and not a concatenation's.
  let caption = '';
  if (noCache && read > 0 && written > 0) {
    caption = tr('without cache · {0} tokens cache read and {1} cache write not shown',
                 fullNum(read), fullNum(written));
  } else if (noCache && read > 0) {
    caption = tr('without cache · {0} tokens cache read not shown', fullNum(read));
  } else if (noCache && written > 0) {
    caption = tr('without cache · {0} tokens cache write not shown', fullNum(written));
  }
  return '<div class="meta">' + tr('{0} composition · last 30 days', esc(srcName(c.source))) + '</div>'
    + '<div class="compbar">' + segs + '</div>'
    + '<div class="legend">' + parts.map((p: Payload) => '<span><i class="dot ' + cls(p) + '"></i>'
      + esc(p.text) + '</span>').join('') + '</div>'
    + (caption ? '<div class="meta">' + caption + '</div>' : '');
}

function sTokens(): string {
  const w = columnWords();
  let h = vm.totals.map(totalsTable).join('');
  const bars = vm.composition.map(compositionBar).join('');
  // The switch belongs to the bars, but it must outlive the mode it sets: a range whose only
  // counted tokens are cache tokens draws no bar at all in 'hidden', and a switch that came
  // and went with the bars would take the way back with it.
  const anyParts = vm.composition.some((c: Payload) => c.parts.some((p: Payload) => p.key !== 'reasoning' && p.tokens > 0));
  if (bars || anyParts) h += cacheChips() + bars;
  if (vm.cacheEconomy.length) {
    h += '<div class="scroll"><table><thead><tr><th>' + tr('Cache · last 30 days') + '</th><th>'
      + tr('Hit rate') + '</th>'
      + '<th>' + tr('Realised') + '</th><th>' + tr('Blended $/1M') + '</th></tr></thead><tbody>'
      + vm.cacheEconomy.map((c: Payload) => '<tr><td data-h="' + tr('Cache') + '">'
        + esc(srcName(c.source)) + '</td>'
        + '<td data-h="' + tr('Hit rate') + '">' + esc(c.hitRate) + '</td><td data-h="'
        + tr('Realised') + '">'
        + esc(c.savedUsd) + (c.partial ? ' ⚠' : '') + '</td><td data-h="' + tr('Blended') + '">'
        + esc(c.blendedPerM) + '</td></tr>').join('')
      + '</tbody></table></div>'
      + '<div class="meta">' + esc(vm.cacheEconomy[0].note) + '</div>';
  }
  const cal = vm.calendar;
  const active = tr('Active'), perDay = tr('Avg/day');
  h += '<div class="scroll"><table><thead><tr><th>' + w.period + '</th><th>' + w.usage + '</th>'
    + (vm.showCost ? '<th>' + w.cost + '</th>' : '') + '<th>' + w.requests + '</th><th>' + active
    + '</th><th>' + perDay + '</th>'
    + '</tr></thead><tbody>'
    + [cal.thisWeek, cal.thisMonth, cal.lastMonth, cal.year].map(p => '<tr>'
      + '<td data-h="' + w.period + '">' + esc(p.label) + '</td><td data-h="' + w.usage + '">'
      + esc(p.usage) + '</td>'
      + (vm.showCost ? '<td data-h="' + w.cost + '">' + esc(p.cost) + '</td>' : '')
      + '<td data-h="' + w.requests + '">' + esc(p.requests) + '</td><td data-h="' + active + '">'
      + esc(p.activeDays)
      + '</td><td data-h="' + perDay + '">' + esc(p.avgPerDay) + '</td></tr>').join('')
    + '</tbody></table></div>';
  if (cal.thisMonth.projection) {
    h += '<div class="meta">' + tr('month projection {0} · {1}',
      esc(cal.thisMonth.projection), esc(cal.thisMonth.projectionBasis)) + '</div>';
  }
  for (const p of vm.planFactor) {
    h += '<div class="meta">' + esc(p.text) + (p.partial ? ' ⚠ ' + tr('lower bound') : '') + '</div>';
  }
  return h;
}

/**
 * The classes one band is painted with: the provider's hue, the model's rank within that
 * provider and the style the setting chose. The one place a chart colour is decided — the
 * bands and the legend swatches call it alike, so a swatch shows exactly the fill of its band.
 */
function bandStyle(source: string, rank: number, style: string): string {
  const st = style === 'shade' || style === 'both' ? style : 'pattern';
  const s = esc(source), r = esc(rank);
  return 'band s-' + s + '-' + r + ' hue-' + s + ' r' + r + ' st-' + st;
}

/** The legend's key for the cost line: the halo, the line and one dot, at swatch size. */
const COST_KEY = '<svg class="key" viewBox="0 0 22 10" aria-hidden="true">'
  + '<polyline class="halo" points="1,8 8,3 14,6 21,2"/>'
  + '<polyline class="line" points="1,8 8,3 14,6 21,2"/><circle cx="8" cy="3" r="2.5"/></svg>';

/**
 * A metric as the dropdown and the heat map's chips say it. The value the page posts back
 * stays the id the extension parses; only the word beside it is the reader's.
 */
function metricLabel(metric: Payload): string {
  const m = String(metric === null || metric === undefined ? '' : metric);
  const words: Record<string, string> = {
    usage: tr('usage'), output: tr('output'), cacheRead: tr('cacheRead'),
    requests: tr('requests'), reasoning: tr('reasoning'), cost: tr('cost'),
  };
  return esc(word(words, m) || m);
}

function sChart(): string {
  const c = vm.chart;
  if (!c.days.length) return '<p class="empty">' + tr('No data in this range.') + '</p>';
  const metrics = ['usage', 'output', 'cacheRead', 'requests', 'reasoning', 'cost'];
  const sel = '<select data-act="metric" aria-label="' + tr('chart metric') + '">'
    + metrics.map(m => '<option value="' + m + '"' + (c.metric === m ? ' selected' : '') + '>'
      + metricLabel(m) + '</option>').join('') + '</select>';
  const totals = c.days.map((_: Payload, i: Payload) => c.series.reduce((s: Payload, x: Payload) => s + x.values[i], 0));
  // A provider's column total, summed from the same bands the column is drawn from.
  // Keyed by provider id only: a payload names the provider, and a name that is not one of
  // ours is not a key (nor, on an object without a prototype, could it ever reach one).
  const subtotals: Record<string, number[]> = Object.create(null);
  c.series.forEach((s: Payload) => {
    if (SRC_IDS.indexOf(s.source) < 0) return;
    const sub = subtotals[s.source] || (subtotals[s.source] = c.days.map(() => 0));
    s.values.forEach((v: Payload, i: Payload) => { sub[i] += v; });
  });
  const showValues = c.days.length <= 31;
  const cols = c.days.map((d: Payload, i: Payload) => {
    const segs = c.series.map((s: Payload) => {
      const v = s.values[i];
      if (v <= 0) return '';
      // The tooltip names the band the way the legend does — model and provider — and reads
      // its share and its provider's total off the very values the bands are drawn from:
      // nothing is measured a second time here, only divided.
      const share = Math.round((v / totals[i]) * 1000) / 10;
      // A sentence per unit rather than the word "day" slotted into one: the provider is
      // named twice in the same line, which only a whole key can order.
      const name = esc(srcName(s.source));
      const title = c.weekly
        ? tr('{0} · {1} · {2} · {3} % of the week · {1} total {4}',
             esc(s.label), name, fullNum(v), share, fullNum((subtotals[s.source] || [])[i] || 0))
        : tr('{0} · {1} · {2} · {3} % of the day · {1} total {4}',
             esc(s.label), name, fullNum(v), share, fullNum((subtotals[s.source] || [])[i] || 0));
      return '<div class="seg ' + bandStyle(s.source, s.rank, c.modelStyle) + '" data-bh="'
        + ((v / c.max) * 100).toFixed(2)
        + '" title="' + title
        + '"></div>';
    }).join('');
    return '<div class="col" data-act="drill" data-day="' + esc(d) + '" tabindex="0" role="button" '
      + 'title="' + esc(d + ': ' + fullNum(totals[i])) + '">'
      + (showValues && totals[i] > 0
         ? '<span class="vlabel" data-i="' + i + '"><i>' + esc(short(totals[i]))
            + '</i></span>' : '')
      + segs + '</div>';
  }).join('');
  const grids = c.ticks.map((t: Payload, i: Payload) => '<div class="grid" data-b="' + ((i + 1) * 25)
    + '"><span>' + esc(short(t)) + '</span></div>').join('');
  let overlay = '';
  if (costLine && c.costLine) {
    const cmax = Math.max.apply(null, c.costLine.concat([0])) || 1;
    const n = c.costLine.length;
    // One point per column, at the column's centre. The columns are n equal flex items with a
    // 2 px gap between them, so the centre of column i sits at (i + 0.5) / n of the plot width
    // give or take a fraction of one gap — nothing an eye can see against a 2 px line.
    const xs = c.costLine.map((_: Payload, i: Payload) => (((i + 0.5) / n) * 100).toFixed(1));
    const ys = c.costLine.map((v: Payload) => (100 - (v / cmax) * 100).toFixed(1));
    const pts = xs.map((x: Payload, i: Payload) => x + ',' + ys[i]).join(' ');
    // The line is drawn twice in one stretched viewBox — the halo first, then the line — and
    // the dots go into a second SVG with no viewBox: placed by percentages of the same box, a
    // circle there is measured in pixels and stays round, where the stretched box would
    // squash it into an ellipse.
    overlay = '<svg class="costline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'
      + '<polyline class="halo" points="' + pts + '"/>'
      + '<polyline class="line" points="' + pts + '"/></svg>'
      + '<svg class="costline dots" aria-hidden="true">'
      + xs.map((x: Payload, i: Payload) => '<circle cx="' + x + '%" cy="' + ys[i] + '%" r="2.5"/>').join('')
      + '</svg>';
  }
  // Every label is rendered and carries its own text; which of them survive is decided by
  // fitChart once the browser knows how wide a column actually is.
  const labels = c.labels.map((l: Payload, i: Payload) => '<span data-i="' + i + '" data-l="' + esc(l) + '"><i>'
    + esc(l) + '</i></span>').join('');
  // The legend is grouped by provider — its name, then its bands in rank order — and every
  // swatch wears the classes of its band, so the pattern in the key is the pattern in the bar.
  let legend = '';
  let group: string | null = null;
  c.series.forEach((s: Payload) => {
    if (s.source !== group) {
      group = s.source;
      legend += '<span class="meta">' + esc(srcName(s.source)) + '</span>';
    }
    legend += '<span><i class="dot ' + bandStyle(s.source, s.rank, c.modelStyle) + '"></i>'
      + esc(s.label) + '</span>';
  });
  return '<div class="row"><span class="meta">'
    + (c.weekly ? tr('weekly bars · {0} columns', c.days.length)
                : tr('daily bars · {0} columns', c.days.length))
    + '</span><span class="wrap">' + sel
    + (c.costLine ? '<button data-act="costLine" aria-pressed="' + costLine + '">' + tr('cost line')
       + '</button>' : '')
    + '</span></div>'
    + '<div class="plot">' + grids + '<div class="chart">' + cols + '</div>' + overlay + '</div>'
    + '<div class="axis">' + labels + '</div>'
    + '<div class="legend">' + legend
    + (costLine && c.costLine ? '<span>' + COST_KEY + tr('API cost (second axis)') + '</span>' : '')
    + '<span>' + tr('click a column for that day') + '</span></div>';
}

function short(n: number): string {
  const a = Math.abs(n);
  // One decimal, in the page's own decimal mark: an axis reading "12.5K" above a table
  // reading "306,5K" is not two styles, it is two numbers. The digits are exactly what
  // toFixed(1) gave, so the English page is unchanged.
  const one = (x: number) => x.toLocaleString(LOCALE, {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  if (a >= 1e9) return one(n / 1e9) + 'G';
  if (a >= 1e6) return one(n / 1e6) + 'M';
  if (a >= 1e3) return one(n / 1e3) + 'K';
  // Below a thousand the fraction is the reading — a requests or cost tick of 2.5 must not
  // be rounded to 3 — so the same two decimals as before, only in the page's own mark.
  return (Math.round(n * 100) / 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 });
}

/**
 * The model table carries the same columns as the totals table, in the same order and with
 * the same words: a reader who has just read "Write 1h" over the whole range wants to know
 * which model wrote it, and a second table with a third of the columns cannot answer that.
 *
 * There is no Price column. What it held is not a figure but a provenance, and it now hangs
 * on the cost it qualifies: the tooltip of the API cost cell names the rates and where they
 * came from, an unpriced model's cost stays a dash, and a borrowed rate is marked ⚠ — the
 * same mark the footnote at the bottom of the page spells out.
 */
function sModels(): string {
  const m = vm.models;
  if (!m.rows.length) return '<p class="empty">' + tr('No model data in this range.') + '</p>';
  const w = columnWords();
  const cols = [['model', w.model], ['usage', w.usage], ['freshInput', w.freshInput],
    ['cacheWrite5m', w.cacheWrite5m], ['cacheWrite1h', w.cacheWrite1h], ['cacheRead', w.cacheRead],
    ['output', w.output], ['reasoning', w.reasoning], ['requests', w.requests],
    ['cacheHit', w.cacheHit], ['perRequest', w.perRequest]]
    .concat(vm.showCost ? [['cost', w.cost]] : []).concat([['share', w.share]]);
  const head = cols.map(c => '<th class="sortable" data-act="sort" data-key="' + c[0] + '" tabindex="0"'
    + (m.sort.key === c[0] ? ' aria-sort="' + (m.sort.dir === 'asc' ? 'ascending' : 'descending') + '"' : '')
    + '>' + esc(c[1]) + '</th>').join('');
  const rows = m.rows.map((r: Payload) => '<tr>'
    + '<td data-h="' + w.model + '">' + esc(r.model)
    + (r.isSub ? ' <span class="meta">' + tr('sub') + '</span>' : '')
    + (r.tier !== 'standard' ? ' <span class="meta">' + esc(r.tier) + '</span>' : '') + '</td>'
    + '<td data-h="' + w.usage + '">' + esc(r.usageText) + '</td>'
    + '<td data-h="' + w.freshInput + '">' + esc(r.freshInput) + '</td>'
    + '<td data-h="' + w.cacheWrite5m + '">' + esc(r.cacheWrite5m) + '</td>'
    + '<td data-h="' + w.cacheWrite1h + '">' + esc(r.cacheWrite1h) + '</td>'
    + '<td data-h="' + w.cacheRead + '">' + esc(r.cacheRead) + '</td>'
    + '<td data-h="' + w.output + '">' + esc(r.output) + '</td>'
    + '<td data-h="' + w.reasoning + '">' + esc(r.reasoning) + '</td>'
    + '<td data-h="' + w.requests + '">' + esc(r.requests) + '</td>'
    + '<td data-h="' + w.cacheHit + '">' + esc(r.cacheHit) + '</td>'
    + '<td data-h="' + w.perRequest + '">' + esc(r.perRequest) + '</td>'
    + (vm.showCost ? '<td data-h="' + w.cost + '" title="' + esc(r.price) + '">' + esc(r.costText)
        + (r.priced === 'family'
          ? ' <span title="' + tr('priced from a related model (family fallback)') + '">⚠</span>' : '')
      + '</td>' : '')
    + '<td data-h="' + w.share + '">' + esc(r.share) + '</td>'
    + '</tr>' + (r.turnAvg
      ? '<tr><td colspan="99" class="meta">'
        + (r.turnP90 ? tr('Avg turn {0} · P90 {1}', esc(r.turnAvg), esc(r.turnP90))
                     : tr('Avg turn {0}', esc(r.turnAvg)))
        + '</td></tr>' : '')).join('');
  const more = m.hidden > 0
    ? '<tr class="more"><td colspan="99">'
      + tr('{0} more — set tokenPace.dashboard.modelRows', esc(m.hidden)) + '</td></tr>' : '';
  return '<div class="scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + more
    + '</tbody></table></div>';
}

function sHeatmap(): string {
  const h = vm.heatmap;
  const cells = h.weeks.map((w: Payload) => w.days.map((d: Payload) => '<i class="'
    + (d.level === null ? 'out' : 'l' + esc(d.level)) + '" title="' + esc(d.text) + '"></i>').join('')).join('');
  return '<div class="row"><span class="meta">'
    + tr('streak {0} · longest {1} · active {2}', esc(h.streak), esc(h.longestStreak), esc(h.activeDays))
    + (h.peakDay ? ' · ' + tr('peak {0} ({1})', esc(h.peakDay.day), esc(h.peakDay.text)) : '')
    + (h.variability
       ? ' · ' + tr('CV {0} · {1} spiky day(s)', esc(h.variability.cv), esc(h.variability.spikyDays))
       : '')
    + '</span><span class="wrap">'
    + ['usage', 'cost'].map(m => '<button data-act="heatmapMetric" data-metric="' + m
      + '" aria-pressed="' + (h.metric === m) + '">' + metricLabel(m) + '</button>').join('')
    + '</span></div>'
    + '<div class="heat">' + cells + '</div>'
    + '<div class="legend"><span>' + tr('less') + '</span><span><i class="dot l1"></i>'
    + '<i class="dot l2"></i><i class="dot l3"></i>'
    + '<i class="dot l4"></i></span><span>' + tr('more') + '</span>'
    + '<span>' + (h.firstDay ? tr('dotted = outside coverage (before {0})', esc(h.firstDay))
                             : tr('dotted = outside coverage'))
    + '</span></div>';
}

/** The two clocks the hour strip can be read in. */
function zoneLabel(zone: string): string {
  return zone === 'utc' ? tr('utc') : zone === 'local' ? tr('local') : esc(zone);
}

function sHours(): string {
  const p = vm.hours;
  const max = Math.max.apply(null, p.profile.map((x: Payload) => x.value).concat([0])) || 1;
  const bars = p.profile.map((x: Payload) => '<div class="hb' + (x.value > 0 ? '' : ' none') + '" data-bh="'
    + (x.value > 0 ? Math.max(1, (x.value / max) * 100).toFixed(2) : '0') + '" title="'
    + esc(String(x.hour).padStart(2, '0') + ':00 · ' + x.text) + '"></div>').join('');
  // The strip needs its own hours: the 00–04 … row below belongs to the weekday grid and is
  // offset by that grid's 28 px label column, so reading it as this axis is off by a block.
  const hourAxis = '<div class="axis">' + p.profile.map((x: Payload, i: Payload) => '<span>'
    + (i % 6 === 0 ? esc(String(x.hour).padStart(2, '0')) : '') + '</span>').join('') + '</div>';
  const gmax = Math.max.apply(null, p.grid.map((c: Payload) => c.value || 0).concat([0])) || 1;
  const blocks = ['00–04', '04–08', '08–12', '12–16', '16–20', '20–24'];
  let grid = '<div class="hgrid"><span></span>'
    + blocks.map(b => '<span class="meta">' + b + '</span>').join('');
  for (let d = 0; d < 7; d++) {
    grid += '<span class="meta">' + esc(p.weekdayLabels[d] || String(d + 1)) + '</span>';
    for (let b = 0; b < 6; b++) {
      const cell = p.grid.find((c: Payload) => c.weekday === d && c.block === b) || { value: null, samples: 0 };
      const lvl = cell.value === null ? 'none'
        : 'l' + Math.max(1, Math.ceil((cell.value / gmax) * 4));
      grid += '<i class="' + lvl + '" title="' + (cell.value === null
        ? tr('no usage in this block')
        : tr('{0} tokens over {1} day(s)', fullNum(cell.value), esc(cell.samples)))
        + '"></i>';
    }
  }
  grid += '</div>';
  return '<div class="row"><span class="meta">'
    + (p.peakHour === null
       ? tr('no hour data · {0} day(s)', esc(p.days))
       : tr('peak {0}:00 · {1} day(s)', esc(String(p.peakHour).padStart(2, '0')), esc(p.days)))
    + '</span><span class="wrap">'
    + ['local', 'utc'].map(z => '<button data-act="hourZone" data-zone="' + z + '" aria-pressed="'
      + (p.zone === z) + '">' + zoneLabel(z) + '</button>').join('') + '</span></div>'
    + '<div class="hours">' + bars + '</div>' + hourAxis
    + (p.note ? '<div class="meta">' + esc(p.note) + '</div>' : '')
    // The caption carries what the grid stands on. A picture whose thin weeks look exactly
    // like its thick ones has to say which it is, in the same line that names it.
    + '<div class="meta">' + tr('by weekday and four-hour block · {0}', esc(p.basis.text)) + '</div>'
    + grid
    + '<div class="legend"><span>' + tr('hatched: no usage in that block') + '</span></div>';
}

/**
 * One Records table. The share is the share of the range, and the detail beside a label is
 * the quieter half of it — the provider of a model, the session count of a project.
 */
function recordTable(head: string, rows: Payload[]): string {
  if (!rows.length) return '';
  const cost = vm.showCost;
  const w = columnWords();
  return '<div class="card"><div class="name">' + esc(head) + '</div>'
    + '<div class="scroll"><table><thead><tr><th>' + esc(head) + '</th><th>' + w.usage + '</th>'
    + '<th>' + w.share + '</th>' + (cost ? '<th>' + w.cost + '</th>' : '') + '</tr></thead><tbody>'
    + rows.map(function (r) {
      return '<tr><td data-h="' + esc(head) + '">' + esc(r.label)
        + (r.detail ? ' <span class="meta">' + esc(r.detail) + '</span>' : '')
        + '</td><td data-h="' + w.usage + '">' + esc(r.usage) + '</td><td data-h="' + w.share + '">'
        + esc(r.share)
        + '</td>' + (cost ? '<td data-h="' + w.cost + '">' + esc(r.cost) + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div></div>';
}

/**
 * The extremes of the selected range.
 *
 * Nothing here is compared against a limit, because none of these figures has one: a peak day
 * is the busiest day *on record*, a streak is a run of days with usage inside the range, and
 * the shares are shares of the range. The two lower tables need attribution, and say so rather
 * than standing empty.
 */
function sRecords(): string {
  const r = vm.records;
  if (!r) return '<p class="empty">' + tr('No records yet.') + '</p>';
  let h = '';
  const peak = r.peakDay
    ? tr('Peak day {0} · {1}', esc(r.peakDay.day), esc(r.peakDay.usage))
      + (vm.showCost && r.peakDay.cost !== '–'
         ? ' · ' + esc(r.peakDay.cost) + (r.peakDay.costPartial ? ' ⚠' : '') : '')
    : tr('Peak day {0}', '–');
  // Singular and plural are two sentences, not a letter added to one.
  const streak = r.streak
    ? (r.streak.days === 1
       ? tr('Longest streak {0} day · {1} → {2}', r.streak.days, esc(r.streak.from), esc(r.streak.to))
       : tr('Longest streak {0} days · {1} → {2}', r.streak.days, esc(r.streak.from), esc(r.streak.to)))
    : tr('Longest streak {0}', '–');
  h += '<div class="card"><div class="row"><span class="name">' + peak + '</span>'
    + '<span class="meta">' + streak + '</span></div></div>';
  h += recordTable(tr('Model'), r.topModels);
  if (r.attributionOn) {
    h += recordTable(tr('Project'), r.topProjects);
    h += recordTable(tr('Session'), r.topSessions);
  } else {
    h += '<p class="empty">' + tr('Top projects and sessions need tokenPace.attribution.') + '</p>';
  }
  const notes = [r.note, r.sessionNote].filter(Boolean);
  if (notes.length) {
    h += '<ul class="meta">' + notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
  }
  return h;
}

/**
 * The tools of the range, busiest first.
 *
 * No bar and no limit: a tool call has neither, and a bar beside a count invites a reading
 * of "how full is it" that nothing here can answer. The share is the share of the calls
 * counted in this range; the notes below say since when that counting has been happening and
 * whether a day hit the per-day name cap.
 */
function sTools(): string {
  const t = vm.tools;
  if (!t) return '<p class="empty">' + tr('No tool calls counted.') + '</p>';
  const w = columnWords();
  const tool = tr('Tool'), calls = tr('Calls'), models = tr('Models');
  let h = '';
  if (t.rows.length) {
    h += '<div class="scroll"><table><thead><tr><th>' + tool + '</th><th>' + calls + '</th><th>'
      + w.share + '</th>'
      + '<th>' + models + '</th></tr></thead><tbody>'
      + t.rows.map(function (r: Payload) {
        return '<tr><td data-h="' + tool + '">' + esc(r.name)
          + (r.sources ? ' <span class="meta">' + esc(r.sources) + '</span>' : '')
          + '</td><td data-h="' + calls + '">' + esc(r.callsText) + '</td>'
          + '<td data-h="' + w.share + '">' + esc(r.share) + '</td>'
          + '<td data-h="' + models + '">' + esc(r.models) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += '<div class="meta">' + tr('{0} call(s) · {1} distinct tool(s)', esc(t.totalText), t.distinct)
      + (t.hidden ? ' · ' + tr('{0} more not listed', t.hidden) : '') + '</div>';
  } else {
    h += '<p class="empty">' + tr('No tool call counted in this range.') + '</p>';
  }
  if (t.notes.length) {
    h += '<ul class="meta">' + t.notes.map((n: Payload) => '<li>' + esc(n) + '</li>').join('') + '</ul>';
  }
  return h;
}

/**
 * The budgets the reader configured.
 *
 * A budget is the one limit in this panel that nobody had to guess: it was typed into the
 * settings. So the bar is drawn against *that* number and against nothing else, the money
 * rows keep the tilde and the warning sign the cost column has (an unpriced model makes a spend a lower
 * bound, and a lower bound makes the share one too), and a period with no local data at all
 * shows a dash — a budget at "0 %" would claim a quiet week when the history may simply not
 * have been read yet. Nothing is summed across rows: dollars and tokens are two questions.
 *
 * "No budget configured" is therefore only ever said about an empty setting: a budget that
 * cannot be measured — money while the cost column is off — still has its row, all dashes,
 * with the responsible setting named under it.
 */
function sBudget(): string {
  const rows = vm.budgets || [];
  if (!rows.length) {
    return '<p class="empty">'
      + tr('No budget configured. tokenPace.budgets takes your own limit per provider, period and unit.')
      + '<br><button data-act="cmd" data-id="tokenPace.openSettings">' + tr('Open settings')
      + '</button></p>';
  }
  return rows.map(function (b: Payload) {
    const share = b.share === null || b.share === undefined ? null : b.share;
    const cls = b.over ? 'warn' : 'neutral';
    let h = '<div class="card"><div class="row"><span class="name">' + esc(b.label)
      + (b.partial ? ' ⚠' : '') + '</span><span class="meta">' + esc(b.shareText)
      + (b.over ? ' · ' + tr('over') : '') + '</span></div>'
      + '<div class="win"><div class="win-top"><span>'
      + tr('{0} of {1}', esc(b.usedText), esc(b.limitText))
      + '</span><b>' + esc(b.from) + ' → ' + esc(b.last) + '</b></div>';
    // No denominator, no bar: a null share is a period we have not read, not an empty one.
    if (share !== null) {
      h += bar(share, cls, null, null,
        { now: Math.round(share), max: 100,
          text: tr('{0}: {1} of {2}', b.label, b.usedText, b.limitText) });
    }
    h += '</div>';
    const meta = [
      // Why a row is all dashes: a budget is never dropped for being unmeasurable, so the
      // card has to name the switch that is in the way instead of showing a blank card.
      b.unmeasurable || null,
      b.projectedText ? tr('projected {0} by {1}', b.projectedText, b.last) : null,
      b.projectionBasis,
    ].filter(Boolean).join(' · ');
    if (meta) {
      h += '<div class="meta' + (b.projectedOver ? ' warn' : '') + '">' + esc(meta) + '</div>';
    }
    return h + '</div>';
  }).join('')
    + '<div class="meta">'
    + tr('A budget is your own number. USD is the hypothetical API equivalent, not a bill, and no budget is ever added to another.')
    + '</div>';
}

function sHistory(): string {
  if (!vm.retro.length) return '<p class="empty">' + tr('No cycles on file yet.') + '</p>';
  return '<ul>' + vm.retro.map((r: Payload) => '<li><b>' + srcLabel(r.source, r.label) + '</b>: '
    + esc(r.text) + '</li>').join('') + '</ul>';
}

function sProjects(): string {
  if (!vm.projects.enabled) {
    return '<p class="empty">' + tr('Project attribution is off (tokenPace.attribution).') + '</p>';
  }
  if (!vm.projects.rows.length) return '<p class="empty">' + tr('No project data yet.') + '</p>';
  const w = columnWords();
  const project = tr('Project'), sessions = tr('Sessions');
  return '<div class="scroll"><table><thead><tr><th>' + project + '</th><th>' + w.usage + '</th><th>'
    + w.requests + '</th>'
    + '<th>' + w.cacheHit + '</th><th>' + w.share + '</th><th>' + sessions + '</th></tr></thead><tbody>'
    + vm.projects.rows.map((p: Payload) => '<tr><td data-h="' + project + '">' + esc(p.project) + '</td>'
      + '<td data-h="' + w.usage + '">' + esc(p.usage) + '</td><td data-h="' + w.requests + '">'
      + esc(p.requests) + '</td>'
      + '<td data-h="' + w.cacheHit + '">' + esc(p.cacheHit) + '</td><td data-h="' + w.share + '">'
      + esc(p.share) + '</td><td data-h="' + sessions + '">' + esc(p.sessions) + '</td></tr>').join('')
    + '</tbody></table></div>';
}

function sSessions(): string {
  if (!vm.sessions.enabled) {
    return '<p class="empty">' + tr('Session attribution is off (tokenPace.attribution).') + '</p>';
  }
  if (!vm.sessions.rows.length) return '<p class="empty">' + tr('No session data yet.') + '</p>';
  const w = columnWords();
  const session = tr('Session'), project = tr('Project'), started = tr('Started');
  const duration = tr('Duration'), cache = tr('Cache');
  return '<div class="scroll"><table><thead><tr><th>' + session + '</th><th>' + project + '</th><th>'
    + started + '</th>'
    + '<th>' + duration + '</th><th>' + w.usage + '</th><th>' + w.requests + '</th><th>' + cache
    + '</th></tr></thead><tbody>'
    + vm.sessions.rows.map((s: Payload) => '<tr><td data-h="' + session + '">' + esc(s.session)
      + (s.isSub ? ' <span class="meta">' + tr('sub') + '</span>' : '') + '</td>'
      + '<td data-h="' + project + '">' + esc(s.project) + '</td><td data-h="' + started + '">'
      + esc(s.started)
      + '</td><td data-h="' + duration + '">' + esc(s.duration) + '</td><td data-h="' + w.usage + '">'
      + esc(s.usage)
      + '</td><td data-h="' + w.requests + '">' + esc(s.requests) + '</td><td data-h="' + cache + '">'
      + esc(s.cacheState || '–') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

function sDataQuality(): string {
  const d = vm.dataQuality;
  const li = [];
  li.push(tr('Roots: {0} · {1} file(s)',
    d.roots.length ? d.roots.map(esc).join(', ') : tr('none'), d.files));
  li.push(tr('Coverage {0} → {1} · {2} hour / {3} day / {4} month buckets · snapshot {5} KB',
    esc(d.oldestDay || '–'), esc(d.newestDay || '–'),
    d.buckets.hour, d.buckets.day, d.buckets.month, Math.round(d.snapshotBytes / 1024)));
  li.push(tr('Lower bound share {0}', esc(d.lowerBoundShare))
    + (d.unpricedModels.length ? ' · ' + tr('unpriced: {0}', d.unpricedModels.map(esc).join(', ')) : '')
    + (d.familyPriced.length ? ' · ' + tr('family-priced: {0}', d.familyPriced.map(esc).join(', ')) : ''));
  li.push(tr('Retention {0} d hourly · {1} d daily · {2} d quota history',
    d.retention.hourDays, d.retention.days, d.retention.historyDays));
  li.push(tr('Quota history {0} samples · {1} KB · oldest {2}',
    d.history.samples, Math.round(d.history.bytes / 1024), esc(d.history.oldest || '–')));
  for (const q of d.quota) {
    li.push(tr('Sources {0}: {1}', esc(q.source), q.candidates.length
      ? q.candidates.map((c: Payload) => esc(c.id) + ' ' + (c.ok
          ? (c.ageSec === null ? tr('ok') : Math.round(c.ageSec / 60) + ' min')
          : esc(c.problem || tr('unavailable')))).join(' · ')
      : tr('no source answered')));
    if (q.drift.length) {
      li.push(tr('Fields reported but not rendered ({0}): {1}',
        esc(q.source), q.drift.map(esc).join(', ')));
    }
  }
  for (const c of d.calibration) {
    li.push(tr('Calibration {0} {1}: {2}', esc(c.source), esc(c.windowId), esc(c.text)));
  }
  if (d.bridge) li.push(tr('Status line: {0}', esc(d.bridge)));
  li.push(tr('Consent: {0} · {1} · attribution {2} · v{3}',
    esc(d.consent), esc(d.leader), esc(d.attribution), esc(d.version)));
  return '<ul>' + li.map(x => '<li>' + x + '</li>').join('') + '</ul>'
    + '<div class="wrap">'
    + '<button data-act="cmd" data-id="tokenPace.copyDiagnostics">' + tr('copy diagnostics') + '</button>'
    + '<button data-act="cmd" data-id="tokenPace.exportCsv">' + tr('export CSV') + '</button>'
    + '<button data-act="cmd" data-id="tokenPace.exportJson">' + tr('export JSON') + '</button>'
    + '<button data-act="cmd" data-id="tokenPace.copySummary">' + tr('copy summary') + '</button>'
    + '<button data-act="cmd" data-id="tokenPace.clearStoredData">' + tr('clear stored data') + '</button>'
    + '</div>';
}

function sDrill(): string {
  if (!vm.drill) return '';
  const w = columnWords();
  return '<h2>' + tr('Day {0}', esc(vm.drill.day)) + '</h2>'
    + '<div class="scroll"><table><thead><tr><th>' + w.model + '</th><th>' + w.usage + '</th><th>'
    + w.requests + '</th>'
    + (vm.showCost ? '<th>' + w.cost + '</th>' : '') + '</tr></thead><tbody>'
    + vm.drill.models.map((m: Payload) => '<tr><td data-h="' + w.model + '">' + esc(m.model) + '</td>'
      + '<td data-h="' + w.usage + '">' + esc(m.usageText) + '</td><td data-h="' + w.requests + '">'
      + esc(m.requests)
      + '</td>' + (vm.showCost ? '<td data-h="' + w.cost + '">' + esc(m.costText) + '</td>' : '')
      + '</tr>').join('')
    + (vm.drill.sessions.length
       ? vm.drill.sessions.map((s: Payload) => '<tr><td colspan="99" class="meta">' + esc(s.session) + ' · '
         + esc(s.project) + ' · ' + esc(s.usage) + '</td></tr>').join('') : '')
    + '</tbody></table></div>'
    + '<button data-act="drill" data-day="">' + tr('close') + '</button>';
}

const RENDER: Record<string, () => string> = {
  notices: sNotices, controls: sControls, footer: sFooter, drill: sDrill,
  summary: sSummary, quota: sQuota, context: sContext, kpis: sKpis, tokens: sTokens,
  chart: sChart, models: sModels, heatmap: sHeatmap, hours: sHours, records: sRecords,
  tools: sTools, budget: sBudget,
  history: sHistory, projects: sProjects, sessions: sSessions, dataQuality: sDataQuality,
};
/**
 * The renderer for a section key, or null. An own-property check, not a bare index: a bare
 * `RENDER[key]` answers 'constructor' with a function, and a key from the payload must never
 * pick anything but one of the sections above.
 */
function renderer(key: string): (() => string) | null {
  return Object.prototype.hasOwnProperty.call(RENDER, key) && typeof RENDER[key] === 'function'
    ? RENDER[key] : null;
}
/** A section's heading. A key this build does not know heads its section with itself. */
function titleOf(key: string): string {
  const titles: Record<string, string> = {
    summary: tr('Summary'), quota: tr('Quota'), context: tr('Context window'),
    kpis: tr('Key figures'),
    tokens: tr('Tokens'), chart: tr('Chart'), models: tr('Models'), heatmap: tr('Activity'),
    hours: tr('Time of day'), records: tr('Records'), tools: tr('Tools'), budget: tr('Budgets'),
    history: tr('Reset history'),
    projects: tr('Projects'), sessions: tr('Sessions'), dataQuality: tr('Data quality'),
  };
  return word(titles, key) || key;
}

// Above everything, quota cards included: a preview banner or the first-run box qualifies
// every figure on the page, not only the statistics the filter bar governs.
function sNotices(): string {
  let h = '';
  if (vm.firstRun) {
    h += '<div class="box info" role="status">' + esc(vm.firstRun.text)
      + (vm.firstRun.scanning ? '' : '<br><button data-act="cmd" data-id="tokenPace.rescan">'
        + tr('Re-read token history') + '</button>') + '</div>';
  }
  if (vm.preview) {
    h += '<div class="box" role="status">' + tr('Preview data — not a reading.') + '</div>';
  }
  return h;
}

function sControls(): string {
  return controls();
}

// Sections the range, provider and model chips do not filter: a provider's window is what
// it is whichever week is selected, the context reading belongs to one live session, and the
// Tokens section is fixed periods of everything — the running windows, today, the last 7 and
// 30 days, this week and month — for every provider and model.
const RANGE_FREE = ['quota', 'context', 'tokens'];

function sFooter(): string {
  // The footnotes already carry the pricing sentence (and the one about configured rates);
  // the line below is only the fallback for a model that does not, never a second copy. What
  // marks that sentence is the as-of date it carries — the only footnote that does — because
  // the sentence itself is written in whatever language the view model was built in.
  const asOf = vm.pricing && vm.pricing.asOf ? esc(vm.pricing.asOf) : '';
  const priced = !asOf || vm.footnotes.some((f: Payload) => String(f).indexOf(asOf) >= 0);
  return '<ul>' + vm.footnotes.map((f: Payload) => '<li>' + esc(f) + '</li>').join('')
    + (priced ? '' : '<li>' + (vm.pricing.custom ? tr('Prices as of {0} · your configured rates.', asOf)
                                                 : tr('Prices as of {0}.', asOf)) + '</li>')
    + '<li>' + tr('Generated {0}.', esc(vm.generatedAt)) + '</li></ul>';
}

/** Folded away by the reader, as the view model remembers it. */
function collapsed(key: string): boolean {
  const list = vm.ui && Array.isArray(vm.ui.collapsed) ? vm.ui.collapsed : [];
  return list.indexOf(key) >= 0;
}

function renderAll(): void {
  let h = '<div data-sec="notices" data-body="notices">' + sNotices() + '</div>';
  // The filter bar sits where its effect starts: below the leading sections it does not
  // apply to, above the first one it does. With the default order that puts the quota cards
  // on top and the chips between them and the statistics.
  let controlsPlaced = false;
  const controlsBlock = '<div data-sec="controls" data-body="controls">' + sControls() + '</div>';
  for (const key of vm.sections) {
    const render = renderer(key);
    if (!render) continue;
    if (!controlsPlaced && RANGE_FREE.indexOf(key) < 0) { h += controlsBlock; controlsPlaced = true; }
    // A native <details>: the fold is the browser's, so it is keyboard reachable and
    // announced as expandable, and the body stays in the document either way — a section
    // update writes into it whether the reader has it open or not.
    h += '<section data-sec="' + esc(key) + '"><details' + (collapsed(key) ? '' : ' open') + '>'
      + '<summary data-act="section" data-key="' + esc(key) + '"><h2>' + esc(titleOf(key))
      + '</h2>' + gear(key) + '</summary>'
      + '<div data-body="' + esc(key) + '">' + render() + '</div></details></section>';
  }
  if (!controlsPlaced) h += controlsBlock;
  h += '<div data-sec="drill" data-body="drill">' + sDrill() + '</div>';
  h += '<div class="foot" data-sec="footer" data-body="footer">' + sFooter() + '</div>';
  // The page's one mount point, written by the provider's own HTML; without it there is
  // nothing to render into and the throw is the honest outcome.
  document.getElementById('root')!.innerHTML = h;
  applyStyles();
  // The whole page was just written, drill panel included, so the day on screen is the day
  // in hand. Without this every full render leaves the marker empty and the next section
  // update mistakes a plain refresh for a new day — and scrolls away under the reader.
  shownDrill = vm.drill ? vm.drill.day : null;
}

/**
 * Replaces one section's body and nothing else. Scroll position and the caret in the date
 * inputs live in the untouched part of the document, which is the whole point.
 */
function renderSection(key: string): void {
  const body = document.querySelector('[data-body="' + key + '"]');
  const render = renderer(key);
  if (!body || !render) { renderAll(); return; }
  // An explanation open inside this body, and the focus on its block, live in the nodes
  // about to be replaced; both are put back on the nodes that replace them.
  const keep = keepPop(body);
  // The spark hover's mark names an svg in this body, and the quota section is rebuilt every
  // few seconds while the prompt-cache countdown ticks. Dropped here, so nothing holds on to
  // a node that has just left the document.
  if (sparkMark && body.contains && body.contains(sparkMark.svg)) sparkMark = null;
  body.innerHTML = render();
  applyStyles();
  restorePop(keep);
  // A day opened from the chart lands a whole page below it. Only on a new day, so a table
  // that merely refreshes cannot pull the page around under the reader.
  if (key === 'drill') {
    const day = vm.drill ? vm.drill.day : null;
    if (day && day !== shownDrill) {
      const sec = document.querySelector('[data-sec="drill"]');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest' });
    }
    shownDrill = day;
  }
}

/**
 * The CSP forbids inline style attributes; values set through the CSSOM are unaffected.
 * Each selector names the very attribute the line below reads, so the value is there.
 */
function applyStyles(): void {
  document.querySelectorAll<HTMLElement>('[data-w]').forEach(el => { el.style.width = el.dataset.w! + '%'; });
  document.querySelectorAll<HTMLElement>('[data-bh]').forEach(el => { el.style.height = el.dataset.bh! + '%'; });
  document.querySelectorAll<HTMLElement>('[data-x]').forEach(el => { el.style.left = el.dataset.x! + '%'; });
  document.querySelectorAll<HTMLElement>('[data-b]').forEach(el => { el.style.bottom = el.dataset.b! + '%'; });
  applyFits();
}

/**
 * The three decisions that need a measured page rather than a view model: which labels fit,
 * which tables are cut off, and where the heat map should start.
 */
function applyFits(): void {
  fitChart();
  fitScroll();
  scrollHeat();
}

/**
 * Labels are thinned by the width one column actually has. A label per column is only
 * readable above roughly 30 px; below that every n-th one is shown and the rest keep their
 * slot empty, so the ones that remain still sit over their own column. No number is lost:
 * every column carries its total in the title.
 */
function fitChart(): void {
  const chart = document.querySelector('.chart');
  if (!chart) return;
  const n = chart.children.length;
  const width = chart.clientWidth;
  if (!n || width <= 0) return;
  const per = (width - (n - 1) * 2) / n;
  const values = chart.querySelectorAll<HTMLElement>('.vlabel');
  const vEvery = per >= 30 ? 1 : Math.ceil(30 / Math.max(per, 1));
  values.forEach(el => { el.hidden = (Number(el.dataset.i) % vEvery) !== 0; });
  const axis = document.querySelector('.plot + .axis');
  if (!axis) return;
  const aEvery = per >= 34 ? 1 : Math.ceil(34 / Math.max(per, 1));
  axis.querySelectorAll('span').forEach(el => {
    // The text lives in the inner element that centres the overflow; writing it on the slot
    // itself would throw that element away on the first resize.
    const inner = el.firstElementChild || el;
    inner.textContent = (Number(el.dataset.i) % aEvery) === 0 ? (el.dataset.l || '') : '';
  });
}

/**
 * A table wider than its box scrolls, but nothing said so: at sidebar width five of the
 * twelve columns are simply not there. The hint is added only once the browser has measured
 * an overflow, and removed again when there is none.
 */
function fitScroll(): void {
  document.querySelectorAll('.scroll').forEach(el => {
    const over = el.scrollWidth > el.clientWidth + 1;
    const next = el.nextElementSibling;
    const hint = next && next.classList && next.classList.contains('scrollhint')
      ? (next as HTMLElement) : null;
    if (hint) { hint.hidden = !over; return; }
    if (!over) return;
    el.insertAdjacentHTML('afterend',
      '<div class="meta scrollhint">' + tr('scroll sideways for the remaining columns →') + '</div>');
  });
}

/**
 * A year of weeks does not fit a sidebar, and the left end is the oldest — for a fresh
 * install that is a wall of empty squares. Start at the newest week; the strip still scrolls,
 * and a reader who moved it is left alone.
 *
 * Pinning once was not enough. Narrowing the sidebar leaves the scroll offset where it is
 * while the scrollable width grows underneath it, so the strip that was at its newest week
 * ends up in the middle of last spring. The offset we set is remembered instead: as long as
 * the strip is still where we left it — or already at its right end, which is where the
 * browser clamps it when the sidebar is widened — it is pinned again on every render and
 * every resize. Anywhere else is the reader's doing and is not touched.
 */
function scrollHeat(): void {
  document.querySelectorAll<HTMLElement>('.heat').forEach(el => {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) { el.dataset.pin = ''; return; }
    const pin = el.dataset.pin;
    const ours = pin === undefined || pin === ''
      || Math.abs(el.scrollLeft - Number(pin)) <= 1 || el.scrollLeft >= max - 1;
    if (!ours) return;
    el.scrollLeft = max;
    // What the element actually took, not what we asked for: a browser that clamps or rounds
    // the offset would otherwise look like a reader on the very next pass.
    el.dataset.pin = String(el.scrollLeft);
  });
}

// -- events -----------------------------------------------------------------

function act(el: HTMLElement): void {
  const a = el.dataset.act;
  if (a === 'range') post({ type: 'setRange', preset: el.dataset.preset });
  else if (a === 'customRange') {
    const from = document.querySelector<HTMLInputElement>('[data-role="from"]');
    const to = document.querySelector<HTMLInputElement>('[data-role="to"]');
    if (from && to && from.value && to.value) post({ type: 'setRange', from: from.value, to: to.value });
  } else if (a === 'refresh') post({ type: 'refresh' });
  else if (a === 'cmd') post({ type: 'command', id: el.dataset.id });
  else if (a === 'sort') {
    const key = el.dataset.key;
    const dir = vm.models.sort.key === key && vm.models.sort.dir === 'desc' ? 'asc' : 'desc';
    post({ type: 'setSort', key: key, dir: dir });
  } else if (a === 'provider') {
    const s = el.dataset.src;
    const list = vm.ui.providers.slice();
    const i = list.indexOf(s);
    if (i >= 0) list.splice(i, 1); else list.push(s);
    post({ type: 'setFilter', providers: list, models: vm.ui.models });
  } else if (a === 'model') {
    const m = el.dataset.model;
    const list = vm.ui.models.slice();
    const i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1); else list.push(m);
    post({ type: 'setFilter', providers: vm.ui.providers, models: list });
  } else if (a === 'clearModels') {
    post({ type: 'setFilter', providers: vm.ui.providers, models: [] });
  } else if (a === 'moreModels') { allModels = !allModels; renderSection('controls'); }
  else if (a === 'moreRanges') { allRanges = !allRanges; renderSection('controls'); }
  else if (a === 'customDates') { showDates = !showDates; renderSection('controls'); }
  else if (a === 'section') post({ type: 'toggleSection', key: el.dataset.key });
  else if (a === 'compositionCache') post({ type: 'setCompositionCache', mode: el.dataset.mode });
  else if (a === 'sectionSettings') post({ type: 'openSectionSettings', key: el.dataset.key });
  else if (a === 'heatmapMetric') post({ type: 'setHeatmapMetric', metric: el.dataset.metric });
  else if (a === 'hourZone') post({ type: 'setHourZone', zone: el.dataset.zone });
  else if (a === 'drill') post({ type: 'drill', day: el.dataset.day || null });
  else if (a === 'costLine') { costLine = !costLine; renderSection('chart'); }
}

function target<T extends Element = HTMLElement>(ev: Event, sel: string): T | null {
  const t = ev.target as Element | null;
  return t && t.closest ? t.closest<T>(sel) : null;
}
document.addEventListener('click', (ev) => {
  const el = target(ev, '[data-act]');
  if (!el || !vm) return;
  // The gear lives inside the <summary>, whose default action is the fold: without both of
  // these, opening the settings would close the section on the way out.
  if (el.dataset.act === 'sectionSettings') { ev.stopPropagation(); ev.preventDefault(); }
  act(el);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const el = target(ev, '[data-act]');
  if (!el || !vm) return;
  // The same for the keyboard: the key press acts on the gear and stops there, so the press
  // that opens the settings does not fold the section under it.
  if (el.dataset.act === 'sectionSettings') {
    ev.stopPropagation();
    ev.preventDefault();
    act(el);
    return;
  }
  // A <summary> turns Enter and Space into a click of its own; acting here as well would
  // toggle the section twice and leave the fold where it started.
  if (el.tagName !== 'BUTTON' && el.tagName !== 'SELECT' && el.tagName !== 'SUMMARY') {
    ev.preventDefault();
    act(el);
  }
});
document.addEventListener('change', (ev) => {
  const el = target<HTMLSelectElement>(ev, '[data-act="metric"]');
  if (el && vm) post({ type: 'setMetric', metric: el.value });
});

// -- explanations: any block that carries data-explain and a .pop of its own ------------
//
// The key figures and the quota windows share one mechanism: the block is focusable, points
// at its panel with aria-describedby, and the panel opens on hover and on focus, closes on
// leave, blur and Escape, and hangs from whichever edge keeps it on the page.

/** The explanation currently open; opening a second one closes it. */
let openPop: HTMLElement | null = null;

function hidePop(): void {
  // A re-render can have taken the node out of the document underneath us. Hiding a detached
  // element is harmless, and dropping the reference is what matters.
  if (openPop) openPop.hidden = true;
  openPop = null;
}

/**
 * Opens one card's explanation. Which side it hangs from is measured, not assumed: a card in
 * the right half of the grid would push a left-anchored popover off the page, and the panel
 * is anything from a 260 px sidebar to a full editor column.
 *
 * It is the block's own panel that opens; a sparkline inside the block has a popover of its
 * own, and that one belongs to the hover.
 */
function showPop(card: Element): void {
  // The block's own popover, never a descendant: a quota window with history carries the
  // sparkline's hover label inside .sparkbox as well, it is written before the explanation,
  // and a plain '.pop' lookup answers in tree order — so it would find the empty one.
  const pop = card.querySelector ? card.querySelector<HTMLElement>(':scope > .pop') : null;
  if (!pop) return;
  hidePop();
  const box = card.getBoundingClientRect ? card.getBoundingClientRect() : null;
  const width = window.innerWidth || 0;
  if (box && width && box.left + box.width / 2 > width / 2) pop.classList.add('right');
  else pop.classList.remove('right');
  pop.hidden = false;
  openPop = pop;
}

/**
 * The block itself, never one of its children: mouseenter and mouseleave fire for the inner
 * elements as well, and a pointer crossing onto the sparkline is not a pointer leaving the
 * block. The popover is a child of the block, so hovering it keeps the block hovered.
 */
function explainCard(ev: Event): HTMLElement | null {
  const t = ev.target as HTMLElement | null;
  return t && t.hasAttribute && t.hasAttribute('data-explain') ? t : null;
}

/**
 * What a section refresh has to put back: the open explanation, by id, and whether the
 * keyboard focus was on its block. The quota section refreshes every few seconds while the
 * prompt-cache countdown ticks, and a refresh that closed the panel under the reader — or
 * dropped the focus a keyboard user had just placed — would make the explanation unreadable.
 */
function keepPop(body: Element): { id: string; focused: boolean } | null {
  if (!openPop || !body.contains || !body.contains(openPop)) return null;
  // The focus counts only when it sits on the explained block itself: with nothing focused
  // the active element is the page body, which contains every panel there is, and a hover
  // must not turn into a focus on the next refresh.
  const active = document.activeElement;
  const focused = !!(active && active.hasAttribute && active.hasAttribute('data-explain')
    && active.contains && active.contains(openPop));
  return { id: openPop.id, focused: focused };
}

function restorePop(keep: { id: string; focused: boolean } | null): void {
  if (!keep || !keep.id) return;
  const pop = document.getElementById(keep.id);
  const card = pop && pop.closest ? pop.closest<HTMLElement>('[data-explain]') : null;
  if (!card) { openPop = null; return; }
  if (keep.focused && card.focus) card.focus();
  showPop(card);
}

// mouseenter, mouseleave, focus and blur do not bubble; a capture-phase listener sees them
// all the same, so one pair of listeners survives every re-render of the section.
document.addEventListener('mouseenter', (ev) => {
  const card = explainCard(ev);
  if (card) showPop(card);
}, true);
document.addEventListener('mouseleave', (ev) => { if (explainCard(ev)) hidePop(); }, true);
document.addEventListener('focus', (ev) => {
  const card = explainCard(ev);
  if (card) showPop(card);
}, true);
document.addEventListener('blur', (ev) => { if (explainCard(ev)) hidePop(); }, true);
// Escape closes it wherever the focus is — the way a reader expects to dismiss a hover card.
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hidePop(); });

// -- the sparkline hover ----------------------------------------------------

/** The reading marked on a quota sparkline: its svg, the spark's geometry and the index. */
let sparkMark: { svg: Payload; g: SparkGeom; k: number } | null = null;

/**
 * The spark an svg was drawn from, looked up in the view model by provider and window: the
 * markup carries no second copy of the readings, and a re-rendered section is found again
 * by the same two names.
 */
function sparkData(svg: Payload): SparkGeom | null {
  if (!vm || !svg || !svg.getAttribute) return null;
  const src = svg.getAttribute('data-src'), win = svg.getAttribute('data-win');
  const q = (vm.quotas || []).find((c: Payload) => !!c && c.source === src);
  const w = q ? (q.windows || []).find((x: Payload) => !!x && x.id === win) : null;
  return w ? sparkGeometry(w.spark) : null;
}

/** The index of the reading nearest to an x in viewBox units. */
function sparkNearest(pts: SparkPoint[], u: number): number {
  let best = 0;
  for (let k = 1; k < pts.length; k++) {
    if (Math.abs(pts[k].x - u) < Math.abs(pts[best].x - u)) best = k;
  }
  return best;
}

function sparkHide(): void {
  if (!sparkMark) return;
  const dot = sparkMark.svg.querySelector('path.hov');
  if (dot) dot.removeAttribute('d');
  const box = sparkMark.svg.parentNode;
  const pop = box && box.querySelector ? box.querySelector('.pop') : null;
  if (pop) pop.hidden = true;
  sparkMark = null;
}

/**
 * Marks one reading and shows its label under it. The label's anchor slides with the
 * reading — at the left edge the box starts there, at the right edge it ends there — so it
 * never leaves the card, whatever the panel's width. Any other explanation open on the page
 * closes: one hover card at a time, as everywhere else.
 */
function sparkShow(svg: Payload, g: SparkGeom | null, k: number): void {
  if (!g || !g.pts.length) return;
  k = Math.max(0, Math.min(g.pts.length - 1, k));
  // The pointer moving within one reading's reach: nothing changes.
  if (sparkMark && sparkMark.svg === svg && sparkMark.k === k) return;
  if (sparkMark && sparkMark.svg !== svg) sparkHide();
  if (typeof hidePop === 'function') hidePop();
  const pt = g.pts[k];
  const dot = svg.querySelector('path.hov');
  if (dot) dot.setAttribute('d', 'M' + pt.x + ' ' + pt.y + 'h.01');
  const box = svg.parentNode;
  const pop = box && box.querySelector ? box.querySelector('.pop') : null;
  if (pop) {
    pop.textContent = pt.label;
    const share = ((pt.x / g.W) * 100).toFixed(2);
    pop.style.left = share + '%';
    pop.style.transform = 'translateX(-' + share + '%)';
    pop.hidden = !pt.label;
  }
  sparkMark = { svg: svg, g: g, k: k };
}

function isSpark(el: Payload): boolean {
  return !!(el && el.classList && el.classList.contains('spark') && el.classList.contains('q'));
}

// The nearest reading by x follows the pointer; the geometry is computed once per spark and
// kept while the pointer stays on it.
document.addEventListener('mousemove', (ev) => {
  const svg = target(ev, 'svg.spark.q');
  if (!svg) return;
  const g = sparkMark && sparkMark.svg === svg ? sparkMark.g : sparkData(svg);
  if (!g) return;
  const box = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
  if (!box || !(box.width > 0)) return;
  sparkShow(svg, g, sparkNearest(g.pts, ((ev.clientX - box.left) / box.width) * g.W));
});
document.addEventListener('mouseleave', (ev) => {
  if (sparkMark && ev.target === sparkMark.svg) sparkHide();
}, true);
// Reaching a spark by keyboard marks its newest reading; the arrow keys walk from there.
document.addEventListener('focus', (ev) => {
  if (!isSpark(ev.target)) return;
  const g = sparkData(ev.target);
  if (g) sparkShow(ev.target, g, g.pts.length - 1);
}, true);
document.addEventListener('blur', (ev) => {
  if (sparkMark && ev.target === sparkMark.svg) sparkHide();
}, true);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { sparkHide(); return; }
  if (!isSpark(ev.target)) return;
  const step = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
  if (!step) return;
  ev.preventDefault();
  // After Escape the focus is still on the spark: the next arrow starts again from the
  // newest reading rather than doing nothing.
  // `own` is only ever true with a mark in hand; nothing between here and there clears it.
  const own = sparkMark && sparkMark.svg === ev.target;
  const g = own ? sparkMark!.g : sparkData(ev.target);
  if (g) sparkShow(ev.target, g, own ? sparkMark!.k + step : g.pts.length - 1);
});

// Dragging the sidebar wider is exactly the case where more labels fit than did before.
window.addEventListener('resize', () => { if (vm) applyFits(); });

window.addEventListener('message', (ev) => {
  // Only the host drives the page. Measured in a real window: VS Code delivers the host's
  // messages with the page's own `vscode-webview://…` origin — from a frame that is neither
  // the parent nor the top, so the origin is the one thing to check. An event the page
  // dispatches to itself (a test harness) has an empty origin. Anything else is ignored,
  // whatever it says; the smoke test waits for the acknowledgement below, so a rule that
  // shut the host out would fail there before it shipped.
  if (ev.origin !== '' && ev.origin !== window.origin) return;
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'data') {
    vm = msg.payload;
    renderAll();
    // The acknowledgement the smoke test waits for: the page was built from a payload that
    // arrived, so the whole channel — host, frame, origin rule, renderer — is proven live.
    post({ type: 'rendered', sections: vm && Array.isArray(vm.sections) ? vm.sections.length : 0 });
    return;
  }
  if (msg.type === 'section' && vm) {
    Object.assign(vm, msg.payload);
    renderSection(msg.key);
  }
});
