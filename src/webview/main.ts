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
  // A reset text that already says the window has reset is a sentence, not a duration; a
  // clock time ("14:20", "2:05 PM") takes the absolute wording, a countdown the relative one.
  if (r.indexOf(due) >= 0) return r;
  return /\d:\d\d/.test(r) ? tr('resets at {0}', r) : tr('resets {0}', r);
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
    // A limit the provider reports as reached is red wherever it is shown: the bar below wears
    // 'error' for it, and so does the chip — the pace level alone would leave it dim whenever
    // the pace happened to be fine.
    const chipLevel = w.display === 'limitReached' ? 'error' : w.level;
    const verdict = [said ? (judged && chipLevel !== 'ok' ? '▲ ' : '') + esc(said) : '', esc(state)]
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
      + (verdict ? '<span class="verdict' + (judged ? ' ' + esc(chipLevel) : '') + '">'
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
    // 1.6 N7: how much of what this machine counted over the window came from Claude Code's
    // subagents — the view model's words, a share of tokens and never of the quota, dim like every
    // line of the card that is not the provider's reading. Absent (Codex, no bounds, nothing
    // counted, an older build) is no line at all.
    if (typeof w.agentShare === 'string' && w.agentShare) {
      h += '<div class="meta agshare">' + shareLine(w.agentShare, w.agentShareParts) + '</div>';
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

/**
 * 1.6 N7: a window's subagent share line, escaped, with its percent kept whole — "58 %" is a figure
 * and its unit, and a 260 px sidebar broke the line between the two. The words are the view model's;
 * the one figure with a space in it, the share, is found where the line ends it and wrapped. The
 * token figures ("≈176.5K") have no break opportunity of their own.
 */
function shareLine(text: string, parts: Payload): string {
  const s = esc(text);
  const p = parts && typeof parts.share === 'string' && parts.share ? esc(parts.share) : '';
  const at = p ? s.lastIndexOf(p) : -1;
  return at < 0 ? s : s.slice(0, at) + '<span class="nobr">' + p + '</span>' + s.slice(at + p.length);
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
  // 1.6 N7: the subagent tokens of the last seven days counted two ways, and why the two differ.
  // The figures and the note are the view model's; only the two labels are the page's.
  const ag = d.agents;
  if (ag && typeof ag.records === 'string' && typeof ag.buckets === 'string') {
    li.push(tr('Agent records, last 7 days') + ': ' + esc(ag.records) + ' · '
      + tr('Subagent tokens in the hour buckets, last 7 days') + ': ' + esc(ag.buckets)
      + (typeof ag.note === 'string' && ag.note ? '<div class="meta agnote">' + esc(ag.note) + '</div>' : ''));
  }
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

// -- agents -----------------------------------------------------------------
//
// The Agents section: the agents that run now, as a list on top, and the Claude Code sessions
// of the last seven days, the workflow runs inside them and the agents they spawned, as one
// tree under it — collapsed, the sessions only, until the reader opens a node. Every word and
// figure a row shows is the view model's — the label, the usage, the duration, the state and
// the sentence that derives it, the tally of the agents below a node — and so is every row of the
// details panel. What is decided here is the structure, which nodes are open and which one is
// selected, and one thing a view model cannot deliver: a clock that moves between two pushes.
// 1.6 L1: and the keyboard — the tree is WAI-ARIA's tree pattern, one stop of the Tab key with
// roving tabindex on its items (agentTab, agentRove), the pattern's keys (agentKeyMove), the focus
// found again by key after a push (keepFocus, restoreFocus).

/**
 * The states a node can be drawn in. A state this build does not know is drawn as unknown.
 * `stopped` (1.6): the parent recorded a stop — an end, but no failure.
 */
const AGENT_STATES = ['running', 'done', 'failed', 'stopped', 'unknown', 'active', 'idle'];
/**
 * The kinds of node. Only these ever reach a class name. `noreply` (1.6 D4): a run's collector —
 * the run's agents without a counted reply, counted in one row, never listed.
 */
const AGENT_KINDS = ['session', 'workflow', 'agent', 'pending', 'noreply'];
/**
 * Far deeper than the tree builder ever nests (MAX_TREE_DEPTH in src/agentTree.ts, with the
 * session and the workflow run above it), so the guard only ever stops a payload that is not a
 * tree the builder made.
 */
const AGENT_MAX_DEPTH = 24;
/**
 * 1.6 P7b: the least room, in the name's font size, an agent's model that gives way keeps on its
 * row: its dot with a space either side and the ellipsis, " · …" (11.6 + 13 px at 13 px). With
 * less it is taken off the name whole (fitAgentNames).
 */
const AGENT_MODEL_ROOM_EM = 1.9;
/**
 * 1.6 D10: whether a row of the tree — and of the running list — marks an output that is a lower
 * bound with ⚠, inside its usage figure, titled with the view model's reason ("⚠ lower bound — 2
 * of 41 replies unfinished"). Off, the rows carry no mark and the details' Output note alone says
 * it (the markdown marks its lines either way). On since 1.6 P7: the lead's call on the screenshot
 * check of 1.6 §3 D10 (§7a Q5) — six of 22 rows marked, none taller, the mark in the figures' line
 * where it does not compete with the glyphs. This one line turns it off again.
 */
const ROW_LOWER_BOUND_MARK: boolean = true;

function agentState(v: Payload): string {
  return AGENT_STATES.indexOf(v) >= 0 ? String(v) : 'unknown';
}

/**
 * A node's state in words, for the title of its glyph. Built on the call, like displayWords(),
 * because the words are the reader's language. Only a session is active or idle, and its words
 * name it; the other five are the states of an agent, a workflow run or a pending launch.
 */
function agentStateWord(state: string): string {
  const words: Record<string, string> = {
    running: tr('running'), done: tr('done'), failed: tr('failed'), stopped: tr('stopped'), unknown: tr('unknown'),
    active: tr('active session'), idle: tr('idle session'),
  };
  return word(words, state);
}

/**
 * The title of a state glyph. A state the tree builder inferred carries the tilde every
 * estimate on this page carries, and says it was derived; one the parent or the workflow
 * journal recorded says so instead. A node that does not say which it is gets the tilde: a
 * state is only ever called recorded when the view model says it was.
 */
function agentStateTitle(state: string, derived: Payload): string {
  const w = agentStateWord(state);
  return derived === false ? tr('{0} · recorded', w) : '~' + tr('{0} · derived', w);
}

/**
 * A node's state for a screen reader (1.6 N9): "running, derived", "done, recorded" — words, as
 * the title says them for the eye ("~running · derived"), without the tilde a screen reader would
 * read as a sign. A node that does not say which it is counts as derived, as its title does.
 */
function agentStateSpoken(state: string, derived: Payload): string {
  const w = agentStateWord(state);
  return derived === false ? tr('{0}, recorded', w) : tr('{0}, derived', w);
}

/**
 * The glyph itself is drawn by the stylesheet from the state class, so it never ends up in the
 * copied text of the page; the image role and its label are what a screen reader gets instead —
 * the state in words (1.6 N9), where the title keeps the page's "~running · derived". An attempt
 * the workflow journal superseded (1.6 D7) keeps its own glyph — dimmed with its row — and its
 * title and label say why it is dimmed.
 */
function agentGlyph(state: string, derived: Payload, superseded = false): string {
  const why = superseded ? tr('superseded by a later attempt') : '';
  const title = agentStateTitle(state, derived) + (why ? ' · ' + why : '');
  const spoken = agentStateSpoken(state, derived) + (why ? ', ' + why : '');
  return '<span class="ag-st ag-' + esc(state) + '" role="img" aria-label="' + spoken + '" title="'
    + title + '"></span>';
}

/** A time stamp from the payload, or null: only a positive, finite number of milliseconds is one. */
function agentTs(v: Payload): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** A text of the payload, escaped, or the dash that stands for its absence. */
function orDash(v: Payload): string {
  return typeof v === 'string' && v !== '' ? esc(v) : '–';
}

/**
 * The time since a moment, as the live spans print it, in the units the page's durations are
 * written in: 42 s, 12 min 05 s, then 1 h 02 min, then 2 d 3 h. Not a clock reading: "12:05"
 * beside a start time reads as a time of day, which a count in units cannot. The abbreviations
 * are the ones the German page writes as well, so the text needs no translation and cannot
 * drift from one. A moment slightly in the future — two clocks a second apart — reads 0 s
 * rather than a negative time.
 */
function sinceText(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (x: number): string => (x < 10 ? '0' : '') + x;
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + two(s % 60) + ' s';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ' + two(m % 60) + ' min';
  return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
}

/**
 * A span the page's one timer keeps current (see tickLive): the time since the stamp, written
 * now and rewritten every second without a render. The only figure on the page this script
 * computes rather than reads — a clock between two pushes is the one thing a push cannot carry.
 */
function liveSince(ts: number): string {
  return '<span data-live="since" data-ts="' + esc(ts) + '">' + esc(sinceText(Date.now() - ts)) + '</span>';
}

/**
 * A clock time of the view model's — `startClock`, `lastClock` (1.6 N9): "14:20", or "2026-09-01
 * 14:20" on another day — or null. The page formats no time of its own.
 */
function agentClock(v: Payload): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * 1.6 N9: a ticking part of a row for the eye, and for a screen reader the same fact as words
 * that stand still — "running for 12 min 05 s" is "since 14:20" to the ear, which a clock
 * rewritten every second would otherwise interrupt, or be read out of date. Without the view
 * model's clock time there are no such words, and the ticking part stays readable.
 */
function spokenTwin(eye: string, words: string | null): string {
  return words === null ? eye : '<span aria-hidden="true">' + eye + '</span><span class="sr">' + words + '</span>';
}

/**
 * How long a running agent has been silent, in whole minutes (1.6 N5): "4 min", then "1 h 05 min".
 * Minutes only — the silence is stated from three minutes on, and its seconds would tick past
 * without saying more.
 */
function silentText(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + (m % 60 < 10 ? '0' : '') + (m % 60) + ' min';
}

/**
 * 1.6 N5: the silence of a running agent — " · silent for 4 min" after the row's figures — from its
 * last activity on, written for every node the view model says may be silent (`silence`) and shown
 * by the page's clock only once AGENT_SILENT_MS have passed since it: until then it is there,
 * hidden, and the timer (tickLive) shows it the second it is due, with no push. The separator is
 * inside it, so a hidden one leaves no dot behind. No colour: the figures' own tone. It is a part
 * of the figures' line (`ag-fp`) of its own. For a screen reader (1.6 N9) the ticking minutes are
 * "silent since 14:21", from the view model's `lastClock`, and shown and hidden with them.
 */
function liveSilent(ts: number | null, clock: string | null): string {
  if (ts === null) return '';
  const ms = Date.now() - ts;
  const due = ms >= AGENT_SILENT_MS;
  const eye = '<span class="nobr">' + tr('silent for {0}', '<span class="ag-for">' + (due ? esc(silentText(ms)) : '') + '</span>')
    + '</span>';
  return '<span class="ag-fp ag-silent" data-live="silent" data-ts="' + esc(ts) + '"' + (due ? '' : ' hidden') + '>'
    + '<span aria-hidden="true"> · </span>'
    + spokenTwin(eye, clock === null ? null : tr('silent since {0}', esc(clock))) + '</span>';
}

/**
 * 1.6 D10: the ⚠ of an output that is a lower bound, for the end of the row's usage figure — only
 * while ROW_LOWER_BOUND_MARK is on, and only with the view model's reason, which is its title: a
 * mark nobody can ask about says less than none. For a screen reader it is "lower bound".
 */
function lowerMark(n: Payload): string {
  if (!ROW_LOWER_BOUND_MARK || !n || n.lowerBound !== true) return '';
  const why = typeof n.lowerBoundText === 'string' && n.lowerBoundText !== '' ? n.lowerBoundText : '';
  if (!why) return '';
  return ' <span class="ag-lb" role="img" aria-label="' + tr('lower bound') + '" title="' + esc(why) + '">⚠</span>';
}

/**
 * What the agents below a node came to (1.6 N1), as the view model wrote it — "427 started ·
 * 112 ✓ · 12 ✕ · 295 ↻ · ~8 ?" — for the eye. The tally is a part of its row's figures' line
 * (1.6 N6): each of its parts is a part of that line of its own (`ag-fp`), hidden from a screen
 * reader, which would read the glyphs as shapes. The same in words — `tallySpoken` — is the end of
 * the tree item's name (1.6 L1, see agentSpoken), which a screen reader announces on the item.
 * Nothing for a node without a tally: no count is not a count of none.
 */
function agentTally(n: Payload): string[] {
  const shown = typeof n.tallyText === 'string' && n.tallyText !== '' ? n.tallyText : '';
  if (!shown) return [];
  return shown.split(' · ').map((p: string) => '<span class="ag-t" aria-hidden="true">' + esc(p) + '</span>');
}

/**
 * A tally in words (1.6 N1) — "427 started, 112 done, 12 failed, …" — for the name of its tree
 * item; the glyphs are read out rather than nothing when the view model sent no words.
 */
function agentTallyWords(n: Payload): string {
  const shown = typeof n.tallyText === 'string' && n.tallyText !== '' ? n.tallyText : '';
  if (!shown) return '';
  return typeof n.tallySpoken === 'string' && n.tallySpoken !== '' ? n.tallySpoken : shown;
}

/**
 * A session's figures: what its own transcript used, since its first line, and — as a figure
 * of its own, never added to it — what its agents of the last seven days used; its span from
 * the first line to the last, which says so in its title, ends its line after the tally
 * (sessionSpan, 1.6 P7b). Two figures of two different
 * spans side by side, each named, so neither reads as the other's part or as their sum. The
 * name comes first — "own 1.2M · agents 434.6K" — since a figure in front of "agents" reads as a
 * number of agents, and the tally beside it counts agents. A session without agents shows no
 * agents figure at all, rather than a dash that reads as one that was not counted.
 */
function sessionFigures(n: Payload): string[] {
  // 1.6 D10: a session's lower bound is its own transcript's, so the mark goes with its own figure.
  const out = [tr('own {0}', orDash(n.usage) + lowerMark(n))];
  if (typeof n.usageAgents === 'string' && n.usageAgents !== '') out.push(tr('agents {0}', orDash(n.usageAgents)));
  return out;
}

/** A session's span, the last figure of its row (1.6 P7b), titled with what it is. */
function sessionSpan(n: Payload): string {
  return '<span title="' + tr('span from the first to the last line') + '">' + orDash(n.duration) + '</span>';
}

/**
 * 1.6 N6: the second line of a row — its figures, in the dim tone, under its name: what it used
 * (a session: its own transcript's and, apart, its agents'), then its duration or — while it runs —
 * the live clock since its start in the duration's place, then how long a running agent has been
 * silent (N5), then the tally of the agents below it (N1), where the row shows one. A session's and
 * a run's line puts its tally before its duration (1.6 P7b, the lead's call): what the agents
 * below it came to is what the row is there to say, the span or the duration the least of it, and
 * so the first to give way — and so does a run's collector's (1.6 P10c, the lead's call):
 * "– · 263 started · … · –", its trailing dash the first to go. Every part is an `ag-fp` of the
 * line, whole or not at all: the line
 * never wraps, and where a narrow sidebar has no room for the last parts, fitAgentFigures takes
 * them off the line whole and ends it on "…" — never a figure torn in two, never a third line (a
 * screen reader still gets every one). A lower bound's ⚠ is inside the usage part (D10). Nothing
 * of a launch nobody has read a line of, or of a collector's agents, was counted: dashes, and a
 * collector no clock at all (1.6, lead note).
 *
 * 1.6 L1: the line carries an `id` in the tree — its item's description (`aria-describedby`), so a
 * screen reader on the item gets its figures after its name: "12.3K lower bound since 14:20".
 */
function agentFigLine(n: Payload, kind: string, state: string, tally: string[], id = ''): string {
  const start = kind === 'noreply' ? null : agentTs(n.startTs);
  const clock = state === 'running' && start !== null;
  const nobr = (f: string): string => '<span class="nobr">' + f + '</span>';
  const head = (kind === 'session' ? sessionFigures(n) : [orDash(n.usage) + lowerMark(n)]).map(nobr);
  // In the duration's place, while it runs, the time since the start, ticking: the running glyph
  // beside the name says what it counts, and the line has no room to spare for "running for" at 260 px.
  const since = agentClock(n.startClock);
  const time = clock
    ? spokenTwin(nobr(liveSince(start as number)), since === null ? null : tr('since {0}', esc(since)))
    : nobr(kind === 'session' ? sessionSpan(n) : orDash(n.duration));
  const open = '<span class="ag-fig"' + (id ? ' id="' + esc(id) + '"' : '') + '>';
  if (kind === 'session' || kind === 'workflow' || kind === 'noreply') {
    return open + figParts(head, 0) + figParts(tally, head.length)
      + figParts([time], head.length + tally.length) + '</span>';
  }
  const silent = n.silence === true && kind === 'agent' ? liveSilent(agentTs(n.lastTs), agentClock(n.lastClock)) : '';
  return open + figParts(head.concat([time]), 0) + silent + figParts(tally, head.length + 1) + '</span>';
}

/**
 * Parts of a figures' line, each an `ag-fp` of its own with the separator in front of it — so a
 * part that fitAgentFigures takes off the line takes its dot with it — the first one of the
 * line without. `from` is how many parts stand before these on the line.
 */
function figParts(parts: string[], from: number): string {
  return parts.map((p: string, i: number) => '<span class="ag-fp">'
    + (from + i > 0 ? '<span aria-hidden="true"> · </span>' : '') + p + '</span>').join('');
}

/**
 * The "more" steps the reader took under an open node (1.6 D3), as the view state keeps them;
 * 0 for a node with none.
 */
function agentPagesOf(key: string): number {
  const list = vm && vm.ui && Array.isArray(vm.ui.agentsMore) ? vm.ui.agentsMore : [];
  for (const e of list) {
    if (e && typeof e === 'object' && e.key === key && typeof e.pages === 'number' && Number.isFinite(e.pages)) return e.pages;
  }
  return 0;
}

/** How many children of an open node the payload does not carry (1.6 D3); 0 when it carries them all. */
function agentRest(n: Payload): number {
  const v = n.childrenMore;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : 0;
}

/**
 * How many children a node has, for the `aria-setsize` of each of them (1.6 L1): the view model's
 * `childrenTotal` — the children in the forest, shown or not —, never fewer than the page carries
 * and the "more" line counts.
 */
function agentSetSize(n: Payload, shown: number): number {
  const t = n.childrenTotal;
  const total = typeof t === 'number' && Number.isInteger(t) && t >= 0 ? t : 0;
  return Math.max(total, shown + agentRest(n));
}

/**
 * The line after the last child of an open node that holds more children than the payload
 * carries (1.6 D3): "50 more · 377 not shown" — how many the next step shows, and how many are
 * not shown now — or "12 more" when the next step shows the rest. While a step can be taken it
 * asks the host for the next fifty; once the node took its last step, or when the page had no
 * room for any of its children at all (the payload's cap, where another step would only ask for
 * more), it is the count alone: "377 not shown". The numbers are the view model's and the paging
 * steps src/agentTree.ts's; nothing here decides which children those are.
 *
 * 1.6 L1: the line is an item of the tree like its siblings — a treeitem of the node's group, one
 * level below the node, the next place after its shown children — reached with the arrow keys,
 * and Enter or Space takes the step; for the mouse, the words are the target (`data-act`). It
 * names its node in `data-more`, which is how the focus finds it again after a push.
 */
function agentMoreRow(n: Payload, key: string, shown: number, level: number, size: number, rove: AgentRoving): string {
  const rest = agentRest(n);
  if (!rest || !key) return '';
  const step = Math.min(AGENT_PAGING.groupChildren, rest);
  const control = shown > 0 && agentPagesOf(key) < AGENT_PAGING.morePages;
  const words = !control ? tr('{0} not shown', esc(fullNum(rest)))
    : rest <= step ? tr('{0} more', esc(fullNum(step)))
      : tr('{0} more · {1} not shown', esc(fullNum(step)), esc(fullNum(rest)));
  const body = control
    ? '<span class="ag-more" data-act="agentMore" data-key="' + esc(key) + '">' + words + '</span>'
    : '<span class="ag-more">' + words + '</span>';
  return '<li role="treeitem" class="ag-k-more" data-more="' + esc(key) + '" tabindex="' + agentTab(rove, { key: key, more: true })
    + '" aria-level="' + level + '" aria-setsize="' + size + '" aria-posinset="' + (shown + 1) + '">'
    + '<div class="ag-line"><span class="ag-pad"></span>' + body + '</div></li>';
}

/**
 * One node and, once the reader opened it, what the view model sent of everything under it. The
 * tree starts closed: only the sessions are drawn, and each says what the agents below it came
 * to. A leaf has no toggle and keeps its place in the column with an empty slot. A closed node's
 * children are not in the payload at all (1.6 D3): whether it has any is the node's own say
 * (`hasChildren`), which open nodes are open is the reader's, kept with the view state, and the
 * next push brings the children the moment a node is opened — at most fifty at a time, and a
 * line after them says how many more there are.
 *
 * 1.6 N6: every row is two lines — its glyph and its name ("Explore · opus-5 · 94f3", the short id
 * dimmed; a session's project after it), then its figures under the name (see agentFigLine). Both
 * lines keep to one line whatever the width: a name too long for it gives way where it is worth
 * least — an agent's model, a session's project, a session's or a run's short id (1.6 P7b, see
 * agentLabel) — and says itself whole in its title.
 *
 * 1.6 L1: the tree is a tree to the keyboard as well (WAI-ARIA's tree pattern). The item — the
 * `<li role="treeitem">` — is what takes the focus, one item at a time (`tabindex` 0 on the
 * current one, see agentTab, −1 on every other), and the keys are the tree's (agentTreeKeys).
 * Its level, its place among its siblings and how many they are — the view model's
 * `childrenTotal`, the ones the payload does not carry counted — are its `aria-level`,
 * `aria-posinset` and `aria-setsize`; `aria-expanded` on a node with children, `aria-selected` on
 * every node. Its name is words (agentSpoken), its figures its description. The toggle and the
 * row inside it are the mouse's targets, no controls of their own: the toggle hidden from a screen
 * reader — the item says whether it is open —, the row the part a click selects by, which
 * `data-pressed` marks while the details stand under it.
 */
function agentNode(n: Payload, expanded: string[], selected: string | null, panel: AgentPanel | null,
  depth: number, pos: number, size: number, rove: AgentRoving): string {
  if (!n || typeof n !== 'object') return '';
  const key = typeof n.key === 'string' ? n.key : '';
  const kids = (depth < AGENT_MAX_DEPTH && Array.isArray(n.children) ? n.children : [])
    .filter((c: Payload) => !!c && typeof c === 'object');
  const parent = n.hasChildren === true || kids.length > 0;
  const open = key !== '' && expanded.indexOf(key) >= 0;
  const on = key !== '' && key === selected;
  // 1.6 N2: the details open inside this entry when they belong under this row — once a page.
  const here = panelHere(panel, 'tree', key);
  const state = agentState(n.state);
  const kind = AGENT_KINDS.indexOf(n.kind) >= 0 ? String(n.kind) : 'agent';
  // 1.6 D7: an attempt the workflow journal superseded — dimmed, its own state kept.
  const superseded = n.superseded === true;
  // Before the children: the current item is the first one in document order that is it.
  const tab = agentTab(rove, { key: key, more: false });
  const fold = parent
    ? '<span class="ag-fold" data-act="agentToggle" data-key="' + esc(key) + '" aria-hidden="true"></span>'
    : '<span class="ag-pad"></span>';
  // The tally of the agents below the node (1.6 N1) ends the figures' line. A session's and a
  // run's stand whether the node is open or not: what failed, was retried or is still unknown
  // among 400 agents is not something to count off the rows. An agent's stands only while its
  // children are on screen with their own glyphs: closed, or open with none of them sent. The
  // tally is the view model's, taken on the whole tree, so it counts the children the page does
  // not carry as well.
  const tally = kind === 'agent' && parent && open && kids.length ? [] : agentTally(n);
  const fid = agentFigId(key);
  const row = '<span class="ag-row" data-act="agentSelect" data-key="' + esc(key)
    + '" data-pressed="' + here + '">' + agentGlyph(state, n.derived, superseded)
    + '<span class="ag-text">' + agentLabel(n, kind) + agentFigLine(n, kind, state, tally, fid) + '</span></span>';
  // The panel after the row's line and before the children, so the node's own details stand
  // between it and what is below it; it takes the tree's whole width, however deep the node.
  // Its Copy ID button is a stop of the Tab key only while the item it belongs to is the current one.
  const details = here && panel ? agentDetails(panel.d, panel.node, depth, tab === '0') : '';
  const total = agentSetSize(n, kids.length);
  const group = parent && open
    ? kids.map((c: Payload, i: number) => agentNode(c, expanded, selected, panel, depth + 1, i + 1, total, rove)).join('')
      + agentMoreRow(n, key, kids.length, depth + 2, total, rove)
    : '';
  return '<li role="treeitem" class="ag-k-' + esc(kind) + (superseded ? ' ag-sup' : '') + '" data-key="' + esc(key)
    + '" tabindex="' + tab + '" aria-level="' + (depth + 1) + '" aria-setsize="' + size + '" aria-posinset="' + pos + '"'
    + (parent ? ' aria-expanded="' + open + '"' : '') + ' aria-selected="' + on + '"'
    + ' aria-label="' + agentSpoken(n, state, superseded, tally.length > 0) + '"'
    + (fid ? ' aria-describedby="' + esc(fid) + '"' : '') + '>'
    + '<div class="ag-line">' + fold + row + '</div>'
    + details
    + (group ? '<ul role="group">' + group + '</ul>' : '')
    + '</li>';
}

/**
 * 1.6 L1: a tree item's name for a screen reader — its node's whole name (`fullLabel`, the model's
 * whole id; a session's project after it, as its title has it), its state in words (N9: "running,
 * derived"; a superseded attempt says so) and, where its row shows a tally, the tally in words:
 * "Explore · claude-opus-5 · 94f3, running, derived", "Workflow run Tue 11:40 · cfe7718d, running,
 * derived, 8 started, 3 done, about 2 running". Escaped: it is an attribute.
 */
function agentSpoken(n: Payload, state: string, superseded: boolean, withTally: boolean): string {
  const full = typeof n.fullLabel === 'string' && n.fullLabel !== '' ? n.fullLabel
    : typeof n.label === 'string' && n.label !== '' ? n.label : '–';
  const sub = typeof n.sub === 'string' && n.sub !== '' ? ' · ' + n.sub : '';
  const said = agentStateSpoken(state, n.derived) + (superseded ? ', ' + tr('superseded by a later attempt') : '');
  const tally = withTally ? agentTallyWords(n) : '';
  return esc(full + sub) + ', ' + said + (tally ? ', ' + esc(tally) : '');
}

/**
 * 1.6 L1: the id of a tree row's figures' line — its item's `aria-describedby` — made of the node's
 * key, which is one in the tree; none for a key that could not be one (empty, or with a space,
 * which would split the reference in two).
 */
function agentFigId(key: string): string {
  return key !== '' && !/\s/.test(key) ? 'agf-' + key : '';
}

/**
 * A row's first line after its glyph: the node's name as the view model wrote it (1.6 N6) —
 * "Explore · opus-5 · 94f3", "Session Tue 14:20 · 9d0eb37a", "Workflow run Tue 00:19 · cfe7718d" —
 * on one line, the whole name, the model id in full, its title. The last part of an agent's, a
 * session's and a run's name is its short id, in the dim tone (§7a Q11); a session's project
 * follows it, dim as well, while attribution names one. When the line has no room for all of it,
 * each part gives way in the order of what it is worth to the row (1.6 P7b, the lead's call), cut
 * with an ellipsis:
 *
 * - an agent: the model first, the dot in front of it with it — the type is what tells Explore
 *   from Plan from general-purpose, and the short id the agent from its siblings, so both stay
 *   whole; only a line too short for those two alone would cut the type. A launch likewise, its
 *   last word ("launched") whole as an agent's id is;
 * - a session and a run: a session's project first, then the short id, down to its ellipsis — so
 *   a run never loses the time it is named by. The prefix word and the time stay whole; only a
 *   line too short for both — a run of six days ago named by its date, in a 260 px sidebar — cuts
 *   the word, never the time.
 *
 * A run's collector (1.6 D4) is named in words — "263 agent(s) without a counted reply" — cut
 * like any name.
 */
function agentLabel(n: Payload, kind: string): string {
  const v = n.label;
  const parts = typeof v === 'string' && v !== '' ? v.split(' · ') : ['–'];
  const sub = typeof n.sub === 'string' && n.sub !== '' ? n.sub : '';
  const full = typeof n.fullLabel === 'string' && n.fullLabel !== '' ? n.fullLabel : typeof v === 'string' ? v : '';
  const title = full ? full + (sub ? ' · ' + sub : '') : '';
  const part = (cls: string, html: string): string => '<span class="' + cls + '">' + html + '</span>';
  // The separators are parts of their own, which never give way, so a part cut short keeps its
  // dot and its space in front of the next one — but the model's, which goes with it.
  const dot = '<span class="ag-dot"> · </span>';
  let body: string;
  if ((kind === 'agent' || kind === 'pending') && parts.length >= 2) {
    const model = parts.slice(1, -1).join(' · ');
    body = part('ag-np ag-type', orDash(parts[0]))
      + (model ? part('ag-np ag-model', ' · ' + orDash(model)) : '') + dot
      + (kind === 'agent' ? part('ag-sid', orDash(parts[parts.length - 1])) : part('ag-np ag-end', orDash(parts[parts.length - 1])));
  } else if ((kind === 'session' || kind === 'workflow') && parts.length >= 2) {
    const id = parts.pop() as string;
    const name = parts.join(' · ');
    const at = nameStart(name, agentClock(n.startClock));
    // Without a start the page can tell from its name, the name before the id is one part, and
    // gives way last, as the prefix word does.
    body = (at === null ? part('ag-np ag-pre', orDash(name)) : part('ag-np ag-pre', esc(at[0])) + part('ag-np ag-when', esc(at[1])))
      + dot + part('ag-sid ag-give', orDash(id));
  } else {
    body = part('ag-np', orDash(parts.join(' · ')));
  }
  return '<span class="ag-label"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + body
    // The project's dot goes with it: it gives way first, and whole.
    + (sub ? '<span class="ag-proj"> · ' + esc(sub) + '</span>' : '')
    + '</span>';
}

/**
 * 1.6 P7b: a session's or a run's name before its short id — "Session Tue 14:20" — as its prefix
 * word and the time it is named by, the space in front of the time with it: ["Session",
 * " Tue 14:20"]. The page formats no time of its own (N9): it finds the time the view model named
 * the node by from the node's own clock time, `startClock` — "14:20", or "2026-09-01 14:20" on
 * another day, the same clock reading of the same start — whose clock the name ends on, after the
 * weekday or the date that is the word in front of it. Null when the name does not end so (no
 * start, or a view model of another build): the name is then one part.
 */
function nameStart(name: string, clock: string | null): [string, string] | null {
  if (clock === null) return null;
  const time = clock.replace(/^\d{4}-\d{2}-\d{2} /, '');
  if (time === '' || name.length <= time.length + 1 || name.slice(-(time.length + 1)) !== ' ' + time) return null;
  const head = name.slice(0, name.length - time.length - 1);
  const cut = head.lastIndexOf(' ');
  if (cut <= 0) return null;
  return [head.slice(0, cut), head.slice(cut) + ' ' + time];
}

/**
 * 1.6 N2: where the selected node's details are drawn, and whether they already are. The panel
 * stands under one row of the node — its tree row or its row in the running list — and only
 * under one: `drawn` is set by the first entry that takes it.
 */
interface AgentPanel { key: string; at: AgentPlace; d: Payload; node: Payload; drawn: boolean }

/** The lists a node's row can stand in: the tree, the running list, the 7-day block's largest agents (1.6 L3). */
type AgentPlace = 'tree' | 'now' | 'week';

/** Whether the panel belongs under this row of `where`, and if so takes it: true once a page. */
function panelHere(panel: AgentPanel | null, where: AgentPlace, key: string): boolean {
  if (!panel || panel.drawn || panel.at !== where || key === '' || key !== panel.key) return false;
  panel.drawn = true;
  return true;
}

/**
 * Where the details of the last render stand — the node and the list of the row they are
 * under — or null when none is drawn. A click on that very row closes them; a click on any other
 * row, the same node's other row included, opens them under that one (see act()). Escape closes
 * them from anywhere in the section and puts the focus back on that row.
 */
let agentPanelAt: { key: string; from: AgentPlace } | null = null;

/**
 * 1.6 L1: an item of the tree as the keyboard knows it — a node, by its key, or the "more" line
 * under the node of that key.
 */
interface AgentItemRef { key: string; more: boolean }

/**
 * The item the keyboard was last on in the tree, then the items above it, the nearest first —
 * kept across renders, so the tree's one stop of the Tab key stays where the reader left it, and
 * the focus finds its way back after a push, to the item or, when that one is gone, to the nearest
 * one above it that is still drawn. Empty until the tree first had the focus.
 */
let agentFocusPath: AgentItemRef[] = [];

/** Whether the focus is on the tree while its section is rewritten under it; only during that render. */
let agentFocusInTree = false;

/** The current item of one render — the one whose `tabindex` is 0 — and whether it was written yet. */
interface AgentRoving { current: AgentItemRef | null; taken: boolean }

/**
 * The `tabindex` of the next item written: 0 for the current one, −1 for every other (roving
 * `tabindex`). Without a current item the first one written — the first session — is it. One
 * item a render, whatever the payload holds.
 */
function agentTab(rove: AgentRoving, ref: AgentItemRef): string {
  if (rove.taken) return '-1';
  if (rove.current !== null && (rove.current.key !== ref.key || rove.current.more !== ref.more)) return '-1';
  rove.taken = true;
  return '0';
}

/**
 * The item that is the tree's stop of the Tab key in this render (1.6 L1): the one the keyboard was
 * last on while it is drawn, else the nearest one above it that is — while the focus is in the
 * tree, else the first session; with the focus elsewhere the selected node when its row is drawn,
 * else the first session (null).
 */
function agentCurrent(roots: Payload[], expanded: string[], selected: string | null): AgentItemRef | null {
  for (const p of agentFocusPath) {
    if (p.more ? agentMoreShown(roots, expanded, p.key, 0) : agentShown(roots, expanded, p.key, 0)) return p;
  }
  if (!agentFocusInTree && selected !== null && agentShown(roots, expanded, selected, 0)) return { key: selected, more: false };
  return null;
}

/**
 * Whether the "more" line under the node of `key` is drawn: the node is drawn, open, has children
 * and holds more of them than the payload carries — the rule agentNode and agentMoreRow draw it by.
 */
function agentMoreShown(list: Payload, expanded: string[], key: string, depth: number): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((n: Payload) => {
    if (!n || typeof n !== 'object' || typeof n.key !== 'string' || n.key === '' || expanded.indexOf(n.key) < 0) return false;
    const kids = depth < AGENT_MAX_DEPTH && Array.isArray(n.children) ? n.children : [];
    if (n.key === key && agentRest(n) > 0 && (n.hasChildren === true || kids.some((c: Payload) => !!c && typeof c === 'object'))) return true;
    return depth < AGENT_MAX_DEPTH && agentMoreShown(n.children, expanded, key, depth + 1);
  });
}

/**
 * Whether the row of `key` is drawn in the tree: the node is in the payload and every node above
 * it is open — the rule agentNode draws by, bounded the same way.
 */
function agentShown(list: Payload, expanded: string[], key: string, depth: number): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((n: Payload) => !!n && typeof n === 'object' && typeof n.key === 'string' && n.key !== ''
    && (n.key === key || (depth < AGENT_MAX_DEPTH && expanded.indexOf(n.key) >= 0
      && agentShown(n.children, expanded, key, depth + 1))));
}

/**
 * One row of the running list: the running glyph and the node's name on its first line, as the
 * tree row writes them (1.6 N6), its figures on the second — its usage, how long it has been
 * running (the live clock) and, from three minutes on, how long it has been silent — and under
 * them, a line of its own, where it sits. The row sends the message a tree row sends, so it opens
 * the same details; unlike a tree row it is a button of its own (1.6 L1: the running list stays a
 * list of buttons, each a stop of the Tab key, ahead of the tree); `data-list` tells it apart from
 * that tree row, which may be on the page as well. A pending launch reads as the
 * hint it is, as in the tree. A run's collector (1.6 D4) is one row for all of its agents without
 * a counted reply, and says how many of them run in the clock's place: it has no start of its own
 * to run a clock from (lead note on P5b).
 */
function agentNowRow(it: Payload, panel: AgentPanel | null): string {
  const key = typeof it.key === 'string' ? it.key : '';
  // 1.6 N2: the row is pressed while the details stand under it, and they stand in its item.
  const on = panelHere(panel, 'now', key);
  const kind = it.kind === 'pending' || it.kind === 'noreply' ? String(it.kind) : 'agent';
  const start = kind === 'noreply' ? null : agentTs(it.startTs);
  // 1.6 D10: marked as the tree's row is, while the page marks rows at all.
  const head = ['<span class="nobr">' + orDash(it.usage) + lowerMark(it) + '</span>'];
  if (start !== null) {
    const eye = '<span class="nobr">' + tr('running for {0}', liveSince(start)) + '</span>';
    const since = agentClock(it.startClock);
    head.push(spokenTwin(eye, since === null ? null : tr('since {0}', esc(since))));
  }
  const members = typeof it.running === 'number' && Number.isInteger(it.running) && it.running >= 1 ? it.running : 0;
  if (kind === 'noreply' && members > 0) {
    head.push('<span class="nobr">' + (members === 1 ? tr('~1 of them running') : tr('~{0} of them running', esc(fullNum(members))))
      + '</span>');
  }
  // 1.6 N5: and how long it has been silent, as on its tree row.
  const silent = it.silence === true && kind === 'agent' ? liveSilent(agentTs(it.lastTs), agentClock(it.lastClock)) : '';
  // Each part keeps together while it fits a line and breaks inside only when it cannot.
  const where: string[] = typeof it.context === 'string' && it.context !== ''
    ? it.context.split(' · ').map((p: string) => orDash(p)) : [];
  if (it.waiting === true) where.push(tr('waits for a child agent'));
  return '<li class="ag-k-' + kind + '"><button class="ag-row" data-act="agentSelect" data-key="' + esc(key)
    + '" data-list="now" aria-pressed="' + on + '">' + agentGlyph('running', true)
    + '<span class="ag-text">' + agentLabel({ label: it.label, fullLabel: it.fullLabel, sub: null }, kind)
    + '<span class="ag-fig">' + figParts(head, 0) + silent + '</span>'
    + (where.length ? '<span class="meta ag-ctx">' + where.map(w => '<span>' + w + '</span>').join(' · ') + '</span>' : '')
    + '</span></button>' + (on && panel ? agentDetails(panel.d, panel.node, null) : '') + '</li>';
}

/**
 * The running list, the first block of the section: every agent and launch that runs now,
 * wherever the tree has it — a closed branch, a session the tree does not list — so nobody has
 * to open the tree to find one. Longest-running first, as the view model ordered them, and
 * what it left out counted under them. With nothing running it is one quiet line and no
 * heading. A payload without the list — an older build's — says nothing about what runs, not
 * that nothing does. 1.6 L3: the first line — the heading or the quiet line — ends on the
 * disclosure of the 7-day block (agentsWeekToggle). The heading counts the running agents (1.6 §2.3): the view model's
 * `running`, which a run's collector adds its running members to (D4) — the number the sessions'
 * tallies give —, where it is one; the rows otherwise.
 */
function agentsNow(a: Payload, panel: AgentPanel | null): string {
  if (!Array.isArray(a.runningNow)) return '';
  const items = agentNowItems(a);
  const n = a.runningMore;
  const more = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.round(n) : 0;
  // 1.6 L3: the first line — the heading, or the one line that says nothing runs — carries the
  // disclosure of the 7-day block at its end.
  const toggle = agentsWeekToggle(a);
  if (!items.length && !more) return '<div class="ag-now"><p class="meta">' + tr('No agent is running.') + '</p>' + toggle + '</div>';
  const r = a.running;
  const count = typeof r === 'number' && Number.isInteger(r) && r >= items.length + more ? r : items.length + more;
  return '<div class="ag-now"><div class="name" role="heading" aria-level="3">'
    + tr('Running now ({0})', count) + '</div>' + toggle
    + (items.length ? '<ul>' + items.map((it: Payload) => agentNowRow(it, panel)).join('') + '</ul>' : '')
    + (more ? '<p class="meta">' + tr('and {0} more', more) + '</p>' : '')
    + '</div>';
}

/**
 * 1.6 L3: whether the 7-day block is open — the reader's say, kept with the view state — and
 * whether the view model built it for this push: the block is drawn only when both are so.
 */
function agentsWeekOpen(): boolean {
  return !!vm && !!vm.ui && vm.ui.agentsWeekOpen === true;
}

function agentsWeekShown(a: Payload): boolean {
  return agentsWeekOpen() && !!a && !!a.week && typeof a.week === 'object';
}

/**
 * 1.6 L3 (§7a Q12): the disclosure of the 7-day block, at the end of the running block's first
 * line — a button that says whether the block is open (`aria-expanded`) and, while it is drawn,
 * which block it opens (`aria-controls`). It asks the host to open or close it, which keeps the
 * state with the rest of the view state; the twisty is drawn by the stylesheet.
 */
function agentsWeekToggle(a: Payload): string {
  const open = agentsWeekOpen();
  return '<button class="ag-wkbtn" data-act="agentsWeek" aria-expanded="' + open + '"'
    + (agentsWeekShown(a) ? ' aria-controls="ag-week"' : '') + '>' + tr('Last 7 days') + '</button>';
}

/** The largest agents the 7-day block draws: the payload's, each an object — none while the block is not drawn. */
function agentWeekItems(a: Payload): Payload[] {
  if (!agentsWeekShown(a) || !Array.isArray(a.week.top)) return [];
  return a.week.top.filter((x: Payload) => !!x && typeof x === 'object' && typeof x.key === 'string' && x.key !== '');
}

/**
 * 1.6 L3: a cost of the 7-day block as the view model wrote it — `~$4.20`, or `–` — with the
 * ` ⚠` behind a sum that holds only some of its agents turned into the page's mark of a lower
 * bound: titled with why, "lower bound" to a screen reader.
 */
function weekCost(v: Payload): string {
  if (typeof v !== 'string' || v === '') return '–';
  if (!/ ⚠$/.test(v)) return esc(v);
  return esc(v.slice(0, -2)) + ' <span class="ag-lb" role="img" aria-label="' + tr('lower bound') + '" title="'
    + tr('not every agent has a price: the sum is a lower bound') + '">⚠</span>';
}

/**
 * 1.6 L3: one of the largest agents of the 7 days, as a row of the running list is drawn: its
 * glyph and its name on the first line, its figures on the second — its usage, its share of the
 * block's total and, with costs shown, its cost — and where it sits on a line of its own. It
 * selects its node as a tree row does, and says it stands in this list (`data-list`), so the
 * details open under it; they are drawn in its item, under the row.
 */
function agentWeekRow(it: Payload, panel: AgentPanel | null): string {
  const key = typeof it.key === 'string' ? it.key : '';
  const on = panelHere(panel, 'week', key);
  const nobr = (f: string): string => '<span class="nobr">' + f + '</span>';
  const figs = [orDash(it.usage), orDash(it.share)].concat(typeof it.cost === 'string' ? [weekCost(it.cost)] : []).map(nobr);
  const where: string[] = typeof it.context === 'string' && it.context !== ''
    ? it.context.split(' · ').map((p: string) => orDash(p)) : [];
  return '<li class="ag-k-agent"><button class="ag-row" data-act="agentSelect" data-key="' + esc(key)
    + '" data-list="week" aria-pressed="' + on + '">' + agentGlyph(agentState(it.state), it.derived)
    + '<span class="ag-text">' + agentLabel({ label: it.label, fullLabel: it.fullLabel, sub: null }, 'agent')
    + '<span class="ag-fig">' + figParts(figs, 0) + '</span>'
    + (where.length ? '<span class="meta ag-ctx">' + where.map(w => '<span>' + w + '</span>').join(' · ') + '</span>' : '')
    + '</span></button>' + (on && panel ? agentDetails(panel.d, panel.node, null) : '') + '</li>';
}

/**
 * 1.6 L3: a row's type and model as the view model wrote them — "workflow-subagent · opus-5" —
 * each part kept whole, so a narrow column breaks the name between the two and never inside a
 * model's id at its hyphens.
 */
function weekLabel(v: Payload): string {
  if (typeof v !== 'string' || v === '') return '–';
  return v.split(' · ').map((p: string) => '<span class="nobr">' + esc(p) + '</span>').join(' · ');
}

/** 1.6 L3: a row's type and model with the model's whole id, as its title — nothing when the payload names neither. */
function weekTitle(r: Payload): string {
  const whole = [r.type, r.model].filter((x: Payload) => typeof x === 'string' && x !== '').join(' · ');
  return whole ? ' title="' + esc(whole) + '"' : '';
}

/**
 * 1.6 L3: where the agent tokens of the last seven days went — after the running list, before the
 * tree, while the reader has it open. A table by type and model, the largest usage first, with how
 * many agents, their usage, its share of the whole and the median of one agent's, and — with costs
 * shown — what it would have cost through the API; a row for all of them together; a line for the
 * combinations the table leaves out; then the largest agents themselves, as rows that open their
 * details. Every figure is the view model's: the page counts, sums and sorts nothing. A narrow
 * sidebar stacks the table as it stacks every table of the page, each value with its column's name.
 */
function agentsWeek(a: Payload, panel: AgentPanel | null): string {
  if (!agentsWeekShown(a)) return '';
  const wk = a.week;
  const rows = (Array.isArray(wk.rows) ? wk.rows : []).filter((r: Payload) => !!r && typeof r === 'object');
  const top = agentWeekItems(a);
  let h = '<div class="ag-week" id="ag-week" role="region" aria-labelledby="ag-week-h">'
    + '<div class="name" id="ag-week-h" role="heading" aria-level="3">' + tr('Last 7 days · where the agent tokens went') + '</div>';
  if (!rows.length) return h + '<p class="empty">' + tr('No agent of the last 7 days has a counted request.') + '</p></div>';
  // The cost column only while the view model wrote a cost at all — `tokenPace.showCost` on.
  const cost = typeof wk.totalCost === 'string';
  const head = [tr('Type · model'), tr('Agents'), tr('Usage'), tr('Share'), tr('Median per agent')].concat(cost ? [tr('~Cost')] : []);
  const count = (v: Payload): string => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? esc(fullNum(v)) : '–');
  const cell = (i: number, html: string): string => '<td data-h="' + head[i] + '">' + html + '</td>';
  h += '<div class="scroll"><table class="ag-wkt"><thead><tr>' + head.map((x) => '<th>' + x + '</th>').join('')
    + '</tr></thead><tbody>'
    + rows.map((r: Payload) => '<tr>'
      + cell(0, '<span' + weekTitle(r) + '>' + weekLabel(r.label) + '</span>')
      + cell(1, count(r.agents)) + cell(2, orDash(r.usage)) + cell(3, orDash(r.share)) + cell(4, orDash(r.median))
      + (cost ? cell(5, weekCost(r.cost)) : '') + '</tr>').join('')
    // Every agent of the block, the combinations the table leaves out included. A share of the
    // whole and a median of one agent's are no figures of the whole: those two cells stay empty.
    + '<tr class="ag-wkall"><td>' + tr('All agents') + '</td>' + cell(1, count(wk.agents)) + cell(2, orDash(wk.total))
    + '<td></td><td></td>' + (cost ? cell(5, weekCost(wk.totalCost)) : '') + '</tr>'
    + '</tbody></table></div>';
  if (typeof wk.other === 'string' && wk.other !== '') h += '<p class="meta">' + esc(wk.other) + '</p>';
  if (top.length) {
    h += '<div class="name ag-wktop" role="heading" aria-level="4">'
      + (top.length === 1 ? tr('The largest agent') : tr('The {0} largest agents', top.length)) + '</div>'
      + '<ul>' + top.map((it: Payload) => agentWeekRow(it, panel)).join('') + '</ul>';
  }
  return h + '</div>';
}

/** The items of the running list the page draws: the payload's, each an object. */
function agentNowItems(a: Payload): Payload[] {
  return Array.isArray(a.runningNow) ? a.runningNow.filter((x: Payload) => !!x && typeof x === 'object') : [];
}

/** Every node of the tree as it arrived, depth first, bounded like the renderer above. */
function agentNodes(roots: Payload[]): Payload[] {
  const out: Payload[] = [];
  const walk = (list: Payload, depth: number): void => {
    if (!Array.isArray(list) || depth > AGENT_MAX_DEPTH) return;
    for (const n of list) {
      if (!n || typeof n !== 'object') continue;
      out.push(n);
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/**
 * The details of the selected node, in the words the view model wrote. The state row carries
 * the sentence the state was derived with. The one figure added here is how long ago the node
 * last changed — from the node the details belong to — and it ticks: the row the view model
 * marks `live` keeps its time and gets the clock in place of its note, which is the same age
 * written once at build time (the markdown view keeps that note); a model without such a row
 * gets one of its own. How a row is laid out is the row's own `kind`, never a guess from its
 * label, its words or the first character of its note: a figure (the default) sits beside its
 * label, its note after a space; a sentence takes the whole width under it, its note set off
 * by " · ", as the state sentence does. The row marked `copy` carries the Copy ID button,
 * which asks the host to copy the id of the node whose details are open — the value that row
 * shows, and nothing the page could choose.
 *
 * Whether the state was recorded, and when the node last changed, come from the node's row
 * where the payload has one — so the panel and the row cannot disagree — and otherwise from the
 * details themselves: a row of the running list says neither, and a recorded outcome is never
 * guessed to be an estimate for want of one.
 *
 * 1.6 N2: the panel is drawn inside the entry of the row it belongs to, under that row. In the
 * tree `depth` is the node's level, which the panel steps back out of (`data-ind`, see
 * applyStyles), so it takes the tree's whole width however deep the node sits; under a row of the
 * running list it is null.
 *
 * 1.6 L1: in the tree the panel belongs to its item, and its Copy ID button is reached with Tab
 * from that item — only while it is the tree's current item (`reach`); otherwise the button is
 * out of the Tab order, and the tree stays one stop of it.
 *
 * 1.6 L2: under the state, the view model's one-line overview of the node (`overview`) — what an
 * agent used, how long it ran, how many requests and tool calls — across the whole width, its
 * label a screen reader's alone; and a row of kind `bar` (the token mix) is drawn across that width
 * too: its parts as one bar, each part's width its share — set through the CSSOM like every bar of
 * the page (`data-w`, see applyStyles), never an inline style —, its title the part's words, and
 * under the bar the same words, which is what a screen reader reads: the bar itself is hidden from
 * it. A bar without a part this page can draw is its words alone.
 */
function agentDetails(d: Payload, node: Payload, depth: number | null, reach = true): string {
  const derived = node && typeof node.derived === 'boolean' ? node.derived : d.derived;
  const lastTs = (node ? agentTs(node.lastTs) : null) || agentTs(d.lastTs);
  // Unbreakable, like the figures of a row: the clock's text is rewritten every second, and a
  // narrow value column would otherwise tear "40 s" across two lines.
  const ago = lastTs === null ? '' : '<span class="nobr">' + tr('{0} ago', liveSince(lastTs)) + '</span>';
  // 1.6 N9: beside the row's own time ("11:59"), the ticking age is for the eye alone — the time
  // is the words a screen reader gets, and they stand still.
  const agoBeside = ago ? '<span aria-hidden="true">' + ago + '</span>' : '';
  const lastLabel = tr('Last activity');
  let placed = !ago;
  let copied = false;
  let rows = '';
  for (const r of Array.isArray(d.rows) ? d.rows : []) {
    if (!r || typeof r !== 'object') continue;
    const live = !placed && r.live === 'ago';
    if (live) placed = true;
    const bar = r.kind === 'bar';
    const wide = r.kind === 'sentence' || bar ? ' class="ag-wide"' : '';
    const hasNote = typeof r.note === 'string' && r.note !== '';
    const note = hasNote ? '<span class="meta">' + esc(r.note) + '</span>' : '';
    // One button per panel, on the first row that asks for it.
    const copy = r.copy === true && !copied
      ? ' <button class="ag-copy" data-act="cmd" data-id="tokenPace.copyAgentId"' + (reach ? '' : ' tabindex="-1"') + '>'
        + tr('Copy ID') + '</button>' : '';
    if (copy) copied = true;
    // An id has no space to break at, and a launch's tool_use id is wider than the value column
    // of a narrow sidebar: it may break anywhere rather than run out of the panel.
    const value = copy ? '<span class="ag-id">' + orDash(r.value) + '</span>' : bar ? agentMix(r) : orDash(r.value);
    rows += '<dt' + wide + '>' + orDash(r.label) + '</dt><dd' + wide + '>' + value
      + (live ? ' · ' + agoBeside : note ? (wide ? ' · ' : ' ') + note : '')
      + copy + '</dd>';
  }
  const own = placed ? '' : '<dt>' + lastLabel + '</dt><dd>' + ago + '</dd>';
  const ind = typeof depth === 'number' && depth > 0 ? ' data-ind="' + Math.min(depth, AGENT_MAX_DEPTH) + '"' : '';
  const overview = typeof d.overview === 'string' && d.overview !== ''
    ? '<dt class="sr">' + tr('Summary') + '</dt><dd class="ag-wide ag-overview">' + agentClauses(d.overview) + '</dd>' : '';
  return '<div class="ag-details"' + ind + ' role="region" aria-label="' + tr('Details') + '">'
    + '<div class="name">' + orDash(d.title) + '</div><dl>'
    + '<dt class="ag-wide">' + tr('State') + '</dt><dd class="ag-wide">'
    + agentGlyph(agentState(d.state), derived)
    + ' ' + orDash(d.stateText) + '</dd>' + overview + own + rows + '</dl></div>';
}

/**
 * 1.6 L2: a line of the view model's clauses joined by " · " — the overview, the token mix's words —
 * with each clause kept whole, so a narrow panel breaks the line between two clauses and never
 * between a figure and its unit ("60 %", "29 min"). The words stay the view model's, character for
 * character.
 */
function agentClauses(text: Payload): string {
  return String(text).split(' · ').map((c: string) => '<span class="nobr">' + esc(c) + '</span>').join(' · ');
}

/** 1.6 L2: the colour of each part of an agent's token mix — the Tokens section's own for the same kind. */
const MIX_CLASS: Record<string, string> = { fresh: 'c1', cacheWrite: 'c2', cacheRead: 'c4', output: 'c5' };

/**
 * 1.6 L2: a bar row of the details — the token mix. Its parts in their order, each as wide as its
 * share (a finite number from 0 to 1; anything else is not drawn), then the row's words. The bar is
 * the eye's; the words say the same to everyone.
 */
function agentMix(r: Payload): string {
  const parts = (Array.isArray(r.parts) ? r.parts : []).filter((p: Payload) => p && typeof p === 'object'
    && typeof p.share === 'number' && isFinite(p.share) && p.share > 0 && p.share <= 1 && word(MIX_CLASS, p.part));
  const words = typeof r.value === 'string' && r.value !== '' ? agentClauses(r.value) : '–';
  if (!parts.length) return words;
  return '<span class="ag-mix" aria-hidden="true">' + parts.map((p: Payload) => '<i class="cs ' + word(MIX_CLASS, p.part)
    + '" data-w="' + (p.share * 100).toFixed(2) + '" title="' + esc(p.label) + '"></i>').join('') + '</span>'
    + '<span class="ag-mixtext">' + words + '</span>';
}

/**
 * The running list, the tree, what it had to leave out, and the details of the selected node
 * under its row. Which nodes are open and which one is selected is the view state's (vm.ui), the
 * details are what the view model built for that selection (vm.agents.selected); both travel
 * in the same push, so a pressed row and the panel under it cannot disagree. Selecting opens
 * nothing, and the view model sends details only while the node's row is on the page — in the
 * tree or in the running list; a node inside a closed branch has none until the branch is opened
 * again (1.6 D3). No chip of the filter bar applies: the section is the last seven days whatever
 * the range says.
 *
 * 1.6 N2: the panel opens under the row that was clicked — `ui.agentSelectedIn` — when the page
 * has both of the node's rows, and under the one it has otherwise: a running agent's row in the
 * list is gone once it ends, its tree row once a node above it is closed. Only that row is
 * pressed. Details for a node with no row on the page at all are drawn nowhere.
 *
 * 1.6 L3: between the running list and the tree, while the reader has it open, the 7-day block
 * (agentsWeek) — whose largest agents are a third place a node's details can open under.
 */
function sAgents(): string {
  agentPanelAt = null;
  const a = vm.agents;
  const roots: Payload[] = a && Array.isArray(a.roots) ? a.roots : [];
  const note = a && typeof a.note === 'string' && a.note ? esc(a.note) : '';
  if (!roots.length) {
    return '<p class="empty">' + (note || tr('No Claude Code session in the last 7 days.')) + '</p>';
  }
  const ui = vm.ui || {};
  const expanded = Array.isArray(ui.agentsExpanded)
    ? ui.agentsExpanded.filter((k: Payload) => typeof k === 'string') : [];
  const selected = typeof ui.agentSelected === 'string' ? ui.agentSelected : null;
  const panel = agentPanelOf(a, roots, expanded, ui.agentSelectedIn);
  // 1.6 L1: the tree's one stop of the Tab key. A current item the render does not reach after all
  // — a payload that is no tree the builder made — hands it to the first session.
  const items = roots.filter((n: Payload) => !!n && typeof n === 'object');
  const draw = (rove: AgentRoving): string => items
    .map((n: Payload, i: number) => agentNode(n, expanded, selected, panel, 0, i + 1, items.length, rove)).join('');
  const rove: AgentRoving = { current: agentCurrent(roots, expanded, selected), taken: false };
  let nodes = draw(rove);
  if (!rove.taken && rove.current !== null) {
    if (panel) panel.drawn = false;
    nodes = draw({ current: null, taken: false });
  }
  // The outer list is only the frame: its items belong to the tree itself, and the list under
  // a node is that node's group.
  let h = agentsNow(a, panel) + agentsWeek(a, panel)
    + '<div class="agtree" role="tree" aria-label="' + tr('Agents') + '"><ul role="none">' + nodes + '</ul></div>';
  if (panel && panel.drawn) agentPanelAt = { key: panel.key, from: panel.at };
  const omitted = Number(a.omittedRoots);
  if (omitted > 0) {
    h += '<p class="empty">' + tr('{0} older session(s) not shown.', esc(Math.round(omitted))) + '</p>';
  }
  if (note) h += '<p class="empty">' + note + '</p>';
  // 1.6 D10: no line about the lower bound under the tree any more. The details' Output note
  // says it with its numbers, and a row marks it itself while ROW_LOWER_BOUND_MARK is on.
  return h;
}

/**
 * 1.6 N2: under which row the selected node's details go, or null when there are none to draw.
 * The place the reader clicked (`where`, the view state's `agentSelectedIn`: the tree's unless it
 * says the running list's) while the page has that row; the node's other row when it has only that one; none when it has neither —
 * the view model only sends details for a node with a row on the page, but a payload is not
 * taken on trust, and a panel with no row to stand under has nowhere to go.
 */
function agentPanelOf(a: Payload, roots: Payload[], expanded: string[], where: Payload): AgentPanel | null {
  const d = a.selected;
  if (!d || typeof d !== 'object' || typeof d.key !== 'string' || d.key === '') return null;
  const key = d.key;
  const items = agentNowItems(a);
  const tops = agentWeekItems(a);
  const has: Record<AgentPlace, boolean> = {
    tree: agentShown(roots, expanded, key, 0),
    now: items.some((x: Payload) => x.key === key),
    week: tops.some((x: Payload) => x.key === key),
  };
  // The row the reader clicked first, then the node's other rows: the tree's, the running list's,
  // the 7-day block's (1.6 L3).
  const order: AgentPlace[] = where === 'now' ? ['now', 'tree', 'week'] : where === 'week' ? ['week', 'tree', 'now'] : ['tree', 'now', 'week'];
  const at = order.find((p) => has[p]) || null;
  if (at === null) return null;
  // The node the panel belongs to, for its clock and whether its state was recorded: its tree
  // node where the payload carries one, else its item of the running list or of the block.
  const node = agentNodes(roots).find((n: Payload) => n.key === key) || items.find((x: Payload) => x.key === key)
    || tops.find((x: Payload) => x.key === key) || null;
  return { key: key, at: at, d: d, node: node, drawn: false };
}

/**
 * The page's one timer. Every second it rewrites the text of the live spans — how long a
 * running node has been running, and the last activity in the details — from the clock, and
 * shows a running agent's silence the second it reaches AGENT_SILENT_MS (1.6 N5), with its
 * minutes; it does nothing else: no render, no message, no request. A page without such a span
 * costs two empty queries a second.
 */
function tickLive(): void {
  // 1.6 N6: a clock that grows a unit ("59 s" → "1 min 00 s"), and a silence that appears, may
  // no longer leave room on its row's figures' line; the line is fitted again then, and only then.
  let grown = false;
  document.querySelectorAll<HTMLElement>('[data-live="since"]').forEach(el => {
    const ts = Number(el.dataset.ts);
    if (!Number.isFinite(ts)) return;
    const next = sinceText(Date.now() - ts);
    if (typeof el.textContent === 'string' && el.textContent.length !== next.length) grown = true;
    el.textContent = next;
  });
  document.querySelectorAll<HTMLElement>('[data-live="silent"]').forEach(el => {
    const ts = Number(el.dataset.ts);
    if (!Number.isFinite(ts)) return;
    const ms = Date.now() - ts;
    const due = ms >= AGENT_SILENT_MS;
    if (el.hidden === due) grown = true;
    el.hidden = !due;
    const min = typeof el.querySelector === 'function' ? el.querySelector('.ag-for') : null;
    if (min && due) {
      const next = silentText(ms);
      if (typeof min.textContent === 'string' && min.textContent.length !== next.length) grown = true;
      min.textContent = next;
    }
  });
  if (grown) fitAgentFigures();
}

let liveTimer: number | null = null;

/** Starts the timer above, once — with the first payload, which is what gives it anything to tick. */
function startLive(): void {
  if (liveTimer === null) liveTimer = window.setInterval(tickLive, 1000);
}

const RENDER = new Map<string, () => string>([
  ['notices', sNotices], ['controls', sControls], ['footer', sFooter], ['drill', sDrill],
  ['summary', sSummary], ['quota', sQuota], ['agents', sAgents], ['context', sContext], ['kpis', sKpis], ['tokens', sTokens],
  ['chart', sChart], ['models', sModels], ['heatmap', sHeatmap], ['hours', sHours], ['records', sRecords],
  ['tools', sTools], ['budget', sBudget],
  ['history', sHistory], ['projects', sProjects], ['sessions', sSessions], ['dataQuality', sDataQuality],
]);
/**
 * The renderer for a section key, or null. Chosen by comparing the key with each literal, not
 * by looking it up: a key from the payload never selects a function by name, so there is no
 * name it could pick that is not one of the sections above.
 */
function renderer(key: string): (() => string) | null {
  switch (key) {
    case 'notices': return sNotices;
    case 'controls': return sControls;
    case 'footer': return sFooter;
    case 'drill': return sDrill;
    case 'summary': return sSummary;
    case 'quota': return sQuota;
    case 'agents': return sAgents;
    case 'context': return sContext;
    case 'kpis': return sKpis;
    case 'tokens': return sTokens;
    case 'chart': return sChart;
    case 'models': return sModels;
    case 'heatmap': return sHeatmap;
    case 'hours': return sHours;
    case 'records': return sRecords;
    case 'tools': return sTools;
    case 'budget': return sBudget;
    case 'history': return sHistory;
    case 'projects': return sProjects;
    case 'sessions': return sSessions;
    case 'dataQuality': return sDataQuality;
    default: return null;
  }
}
/** A section's heading. A key this build does not know heads its section with itself. */
function titleOf(key: string): string {
  const titles: Record<string, string> = {
    summary: tr('Summary'), quota: tr('Quota'), agents: tr('Agents'), context: tr('Context window'),
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
// it is whichever week is selected, the agent tree is the sessions of the last seven days,
// the context reading belongs to one live session, and the Tokens section is fixed periods
// of everything — the running windows, today, the last 7 and 30 days, this week and month —
// for every provider and model.
const RANGE_FREE = ['quota', 'agents', 'context', 'tokens'];

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
  // A section that is not on the page has no body to write into. Its fields are already in
  // `vm` (the message handler assigned them), so the next render draws it current; a change
  // of which sections are shown arrives as a whole-page push, never as a fragment. Rewriting
  // the whole page here instead reset every scroll position with each such push.
  if (!body || !render) return;
  // An explanation open inside this body, and the focus on its block, live in the nodes
  // about to be replaced; both are put back on the nodes that replace them.
  const keep = keepPop(body);
  // The spark hover's mark names an svg in this body, and the quota section is rebuilt every
  // few seconds while the prompt-cache countdown ticks. Dropped here, so nothing holds on to
  // a node that has just left the document.
  if (sparkMark && body.contains && body.contains(sparkMark.svg)) sparkMark = null;
  // The agents section is rewritten every few seconds while agents run. A keyboard user on a
  // row of the running list, or on an item of the tree, stays there; dropping the focus would
  // send them back to the top of the page with every push.
  const focus = key === 'agents' ? keepFocus(body) : null;
  agentFocusInTree = !!(focus && focus.tree);
  try {
    body.innerHTML = render();
  } finally {
    agentFocusInTree = false;
  }
  applyStyles();
  restorePop(keep);
  if (focus) restoreFocus(body, focus);
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
 * Where the focus is inside `body`, to put it back after the body is rewritten; null when it is
 * elsewhere. On an item of the agent tree (1.6 L1) — or on the Copy ID button of its details,
 * which belong to it — `tree`: the item is found again by the path agentFocusPath keeps, taken
 * here. On a control otherwise, by what it does, what it names and which list it stands in. The
 * list matters because a running agent has two rows that do the same thing — one in the running
 * list, one in the tree — and a keyboard user on either has to come back to that one, not to
 * whichever comes first.
 */
function keepFocus(body: Element): AgentFocus | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || !body.contains || !body.contains(el)) return null;
  const li = agentItemOf(el);
  if (li) {
    agentFocusPath = agentPathOf(li);
    return { act: '', key: '', list: '', tree: true, copy: li !== el };
  }
  if (!el.dataset) return null;
  // 1.6 L3: the 7-day block's disclosure names no node; it is found again by what it does.
  const act = el.dataset.act, key = el.dataset.key || '';
  return act && (key || act === 'agentsWeek') ? { act: act, key: key, list: el.dataset.list || '' } : null;
}

/** What keepFocus found: a control by what it does and whom it names, or an item of the tree. */
interface AgentFocus { act: string; key: string; list: string; tree?: boolean; copy?: boolean }

/**
 * Puts the focus back on the control that does the same thing to the same node, in the same
 * list — or, for the tree (1.6 L1), on the item with the same key, else on the nearest item above
 * it that is still drawn (a "more" line that is gone — its node shows every child now — hands it
 * to that node), else on the first session; and back on the Copy ID button when it was there and
 * its item's details still stand. A control that is gone takes the focus nowhere.
 */
function restoreFocus(body: Element, f: AgentFocus): void {
  if (!body.querySelectorAll) return;
  if (f.tree) { agentFocusBack(body, f.copy === true); return; }
  const all = body.querySelectorAll<HTMLElement>('[data-act]');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.dataset.act === f.act && (el.dataset.key || '') === f.key && (el.dataset.list || '') === f.list) { el.focus(); return; }
  }
}

/** The item of the tree `el` is — or whose details panel holds it (the Copy ID button); null otherwise. */
function agentItemOf(el: Payload): HTMLElement | null {
  if (!el || typeof el.closest !== 'function') return null;
  const li = el.closest('li[role="treeitem"]');
  if (!li || typeof li.closest !== 'function' || !li.closest('.agtree')) return null;
  if (li === el) return li;
  const det = el.closest('.ag-details');
  return det && det.parentElement === li ? li : null;
}

/** An item of the tree as the keyboard knows it (AgentItemRef): its node's key, or its node's for a "more" line. */
function agentRefOf(li: Payload): AgentItemRef {
  const d = li && li.dataset ? li.dataset : {};
  return typeof d.more === 'string' ? { key: d.more, more: true } : { key: typeof d.key === 'string' ? d.key : '', more: false };
}

/** The item and every item above it in the tree, the nearest first. */
function agentPathOf(li: Payload): AgentItemRef[] {
  const out: AgentItemRef[] = [];
  let x = li;
  while (x && out.length <= AGENT_MAX_DEPTH + 1) {
    out.push(agentRefOf(x));
    const up = x.parentElement;
    x = up && typeof up.closest === 'function' ? up.closest('.agtree li[role="treeitem"]') : null;
  }
  return out;
}

/** The item of the node of `key` among the tree's items in `body` — never a "more" line — or null. */
function agentItemByKey(body: Element, key: string): HTMLElement | null {
  const items = Array.from(body.querySelectorAll<HTMLElement>('.agtree li[role="treeitem"]'));
  return items.find((x) => { const r = agentRefOf(x); return !r.more && r.key === key; }) || null;
}

/** Puts the focus back on the tree after a push (restoreFocus): the item, the nearest one above it, the first session. */
function agentFocusBack(body: Element, copy: boolean): void {
  const items = Array.from(body.querySelectorAll<HTMLElement>('.agtree li[role="treeitem"]'));
  for (let k = 0; k < agentFocusPath.length; k++) {
    const p = agentFocusPath[k];
    const li = items.find((x) => { const r = agentRefOf(x); return r.key === p.key && r.more === p.more; });
    if (!li) continue;
    const button = copy && k === 0 && li.querySelector ? li.querySelector<HTMLElement>(':scope > .ag-details .ag-copy') : null;
    (button || li).focus();
    return;
  }
  if (items.length) items[0].focus();
}

/**
 * 1.6 L1: the item that took the focus — by the keyboard, by a click on it or on its details, or
 * put back after a push — is the tree's one stop of the Tab key from now on: `tabindex` 0 on it,
 * −1 on the one before, and its details' Copy ID button (only its own) in the Tab order after it.
 */
function agentRove(li: HTMLElement): void {
  const tree = li.closest ? li.closest('.agtree') : null;
  if (!tree) return;
  tree.querySelectorAll<HTMLElement>('li[role="treeitem"][tabindex="0"]').forEach((x) => { if (x !== li) x.setAttribute('tabindex', '-1'); });
  li.setAttribute('tabindex', '0');
  tree.querySelectorAll<HTMLElement>('.ag-details .ag-copy').forEach((b) => {
    const det = b.closest ? b.closest('.ag-details') : null;
    b.setAttribute('tabindex', det && det.parentElement === li ? '0' : '-1');
  });
  agentFocusPath = agentPathOf(li);
}

/** An item of the tree for agentKeyMove: its level, whether it is a node with children and open, whether it is a "more" line. */
interface AgentKeyItem { level: number; parent: boolean; open: boolean; more: boolean }

/**
 * 1.6 L1: what a key does on the item `i` of the tree's drawn items, in document order (WAI-ARIA's
 * tree pattern): the item to move the focus to, or what to ask the host for — to open or close
 * the node (`toggle`), to select it or clear its selection (`select`), the next fifty children
 * (`more`) —, or null for a key that is not the tree's. The focus moves only; it selects nothing.
 *
 * - ↓ / ↑: the next / the previous item; Home / End: the first / the last.
 * - →: a closed node opens; on an open one the focus goes to its first child; elsewhere nothing.
 * - ←: an open node closes; elsewhere the focus goes to the item above it, if there is one.
 * - Enter, Space: a node is selected — or, whose details stand under its row, cleared —; on a
 *   "more" line the next fifty.
 */
function agentKeyMove(items: AgentKeyItem[], i: number, key: string): { focus?: number; act?: 'toggle' | 'select' | 'more' } | null {
  const it = items[i];
  if (!it) return null;
  const last = items.length - 1;
  switch (key) {
    case 'ArrowDown': return { focus: Math.min(i + 1, last) };
    case 'ArrowUp': return { focus: Math.max(i - 1, 0) };
    case 'Home': return { focus: 0 };
    case 'End': return { focus: last };
    case 'ArrowRight':
      if (it.more || !it.parent) return { focus: i };
      if (!it.open) return { act: 'toggle' };
      return { focus: i < last && items[i + 1].level === it.level + 1 ? i + 1 : i };
    case 'ArrowLeft':
      if (!it.more && it.parent && it.open) return { act: 'toggle' };
      for (let j = i - 1; j >= 0; j--) if (items[j].level < it.level) return { focus: j };
      return { focus: i };
    case 'Enter':
    case ' ':
      return { act: it.more ? 'more' : 'select' };
    default:
      return null;
  }
}

/** An item as agentKeyMove reads it, from the attributes agentNode and agentMoreRow write. */
function agentKeyItem(li: HTMLElement): AgentKeyItem {
  const level = Number(li.getAttribute('aria-level'));
  const exp = li.getAttribute('aria-expanded');
  return { level: Number.isFinite(level) && level >= 1 ? level : 1, parent: exp === 'true' || exp === 'false',
    open: exp === 'true', more: !!li.dataset && typeof li.dataset.more === 'string' };
}

/** The mouse's target inside an item that does what a key asked for: its toggle, its row, its "more" words. */
function agentControlOf(li: HTMLElement, what: 'toggle' | 'select' | 'more'): HTMLElement | null {
  const cls = what === 'toggle' ? 'ag-fold' : what === 'select' ? 'ag-row' : 'ag-more';
  const el = li.querySelector ? li.querySelector<HTMLElement>(':scope > .ag-line > .' + cls) : null;
  return el && el.dataset && el.dataset.act ? el : null;
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
  // 1.6 N2: a details panel inside a nested entry of the agent tree steps back out of the levels
  // above it (the stylesheet multiplies the level by the indent of one).
  document.querySelectorAll<HTMLElement>('[data-ind]').forEach(el => { el.style.setProperty('--ag-ind', el.dataset.ind!); });
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
  fitAgentNames();
  fitAgentFigures();
}

/**
 * 1.6 P7b: an agent's model, where its row's name has no room for it, gives way on an ellipsis
 * (see agentLabel) — while the room it has left holds its dot and the ellipsis, " · …"; below that
 * it would be a sliver of a dot, which says nothing, and it is taken off the name whole
 * (`ag-gone`, out of sight and still in the page for a screen reader) so the name reads
 * "workflow-subagent · f6a7", the whole name in its title. Measured first for every name and
 * written after; run with the page's other fits, and when a closed section opens.
 */
function fitAgentNames(): void {
  const models = document.querySelectorAll<HTMLElement>('.ag-label > .ag-model');
  if (!models.length) return;
  models.forEach(m => { if (m.classList) m.classList.remove('ag-gone'); });
  const off: HTMLElement[] = [];
  models.forEach(m => {
    if (typeof m.getBoundingClientRect !== 'function' || !(m.scrollWidth > m.clientWidth + 0.5)) return;
    const size = (typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(m).fontSize) : NaN) || 13;
    // " · …": the dot and its two spaces, and the ellipsis — 1.9 of the font's size.
    if (m.getBoundingClientRect().width < size * AGENT_MODEL_ROOM_EM) off.push(m);
  });
  off.forEach(m => m.classList.add('ag-gone'));
}

/**
 * 1.6 N6: an agent row's figures are one line (see agentFigLine). Where a narrow sidebar leaves
 * that line too little room, its last parts come off it whole — on an agent's row the tally's last
 * counts first, then the tally, the silence, the clock; on a session's, a run's and a collector's
 * the span or the duration first, then the tally's last counts (1.6 P7b, P10c) — and the line ends
 * on "…" (`ag-cut`):
 * what stays is never a figure torn in two, and the row never takes a third line. A part taken off stays in the page for
 * a screen reader (`ag-gone` hides it from the eye alone — its text at no size, still in the line:
 * 1.6 P10c, so a screen reader hears it with no space of its own before the next comma), so the row
 * still says everything to the ear, and the details panel says everything to the eye. The first part — the usage, with its ⚠ —
 * always stays. Measured first for every line and written after, so a page of rows is laid out twice
 * at most; run after every render, on a resize, when a closed section opens, and when the clock
 * grows a line (tickLive). A page without such a line costs one query.
 */
function fitAgentFigures(): void {
  const lines = document.querySelectorAll<HTMLElement>('.ag-fig');
  if (!lines.length) return;
  lines.forEach(el => {
    if (!el.classList) return;
    el.classList.remove('ag-cut');
    el.querySelectorAll<HTMLElement>('.ag-gone').forEach(p => p.classList.remove('ag-gone'));
  });
  const plan: Array<{ el: HTMLElement; gone: HTMLElement[] }> = [];
  lines.forEach(el => {
    if (typeof el.getBoundingClientRect !== 'function' || !(el.scrollWidth > el.clientWidth + 0.5)) return;
    const parts = Array.from(el.children).filter(p => p.classList && p.classList.contains('ag-fp')
      && !(p as HTMLElement).hidden) as HTMLElement[];
    // The room the ellipsis needs at the end of the line: a no-break space and the ellipsis.
    const size = (typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(el).fontSize) : NaN) || 11;
    const room = el.getBoundingClientRect().left + el.clientWidth - size * 1.4;
    let keep = parts.length;
    while (keep > 1 && parts[keep - 1].getBoundingClientRect().right > room) keep--;
    plan.push({ el: el, gone: parts.slice(keep) });
  });
  plan.forEach(x => {
    x.el.classList.add('ag-cut');
    x.gone.forEach(p => p.classList.add('ag-gone'));
  });
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
  else if (a === 'agentToggle') {
    // Opens a closed node or closes an open one; the host keeps which, so it survives a reload.
    const key = el.dataset.key;
    if (key) post({ type: 'agentToggle', key: key });
  } else if (a === 'agentMore') {
    // The next fifty children of an open node; the host keeps how many, as it keeps the open ones.
    const key = el.dataset.key;
    if (key) post({ type: 'agentMore', key: key });
  } else if (a === 'agentsWeek') {
    // 1.6 L3: opens or closes the 7-day block; the host keeps which, as it keeps the open nodes.
    post({ type: 'agentsWeek' });
  } else if (a === 'agentSelect') {
    // The row whose details are open under it closes them again: a second click clears the
    // selection. 1.6 N2: any other row opens them under itself — the same node's other row too,
    // which moves them there — and says which list it stands in: the tree, the running list, or
    // (1.6 L3) the 7-day block's largest agents.
    const key = el.dataset.key;
    const list = el.dataset.list;
    const from = list === 'now' || list === 'week' ? list : 'tree';
    if (!key) return;
    const open = agentPanelAt !== null && agentPanelAt.key === key && agentPanelAt.from === from;
    post(open ? { type: 'agentSelect', key: null } : { type: 'agentSelect', key: key, from: from });
  }
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

// -- the agents' details panel: Escape --------------------------------------
//
// 1.6 N2: Escape anywhere in the Agents section closes an open details panel and puts the focus
// back on the row it stands under — unless a hover card or a sparkline's tip is open: the page's
// own Escape closes that first (the two listeners above), and only the next Escape the panel.
// Registered for the capture phase, so it sees whether one of them is open before their own
// listeners have closed it. The host's push that answers the message redraws the section
// without the panel, and the focus stays on the row across it (keepFocus / restoreFocus).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !vm || !agentPanelAt) return;
  if (openPop !== null || sparkMark !== null) return;
  const t = ev.target as Element | null;
  const sec = t && t.closest ? t.closest('[data-sec="agents"]') : null;
  const body = sec && sec.querySelector ? sec.querySelector('[data-body="agents"]') : null;
  // Only a panel on screen: not one inside a section the reader has folded away.
  const fold = sec ? sec.querySelector<HTMLDetailsElement>('details') : null;
  if (!body || !body.querySelector('.ag-details') || (fold && !fold.open)) return;
  const at = agentPanelAt;
  ev.preventDefault();
  // 1.6 L1: in the tree the row is its item's — the item takes the focus, as it takes it anywhere
  // in the tree; in the running list it is the row's own button.
  if (at.from === 'tree') {
    const li = agentItemByKey(body, at.key);
    if (li) li.focus();
  } else {
    restoreFocus(body, { act: 'agentSelect', key: at.key, list: at.from });
  }
  post({ type: 'agentSelect', key: null });
}, true);

// -- the agent tree: the keyboard -------------------------------------------
//
// 1.6 L1: WAI-ARIA's tree pattern. The tree is one stop of the Tab key; inside it the keys of
// agentKeyMove move the focus from item to item, open and close nodes, select them and take the
// "more" steps — through the very targets the mouse clicks (act), so a key asks the host for
// nothing a click would not. Only a key on the item itself, and without a modifier: in its details
// the Copy ID button keeps its own keys, and a key with Ctrl, Alt, Meta or Shift is not the tree's.
document.addEventListener('keydown', (ev) => {
  if (!vm || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  const li = ev.target as HTMLElement | null;
  if (!li || typeof li.getAttribute !== 'function' || li.getAttribute('role') !== 'treeitem' || typeof li.closest !== 'function') return;
  const tree = li.closest('.agtree');
  if (!tree) return;
  const all = Array.from(tree.querySelectorAll<HTMLElement>('li[role="treeitem"]'));
  const i = all.indexOf(li);
  if (i < 0) return;
  const move = agentKeyMove(all.map(agentKeyItem), i, ev.key);
  if (move === null) return;
  // Handled, whatever it does: an arrow never scrolls the page under the tree, Space neither.
  ev.preventDefault();
  if (typeof move.focus === 'number') {
    const to = all[move.focus];
    if (to && to !== li) to.focus();
    return;
  }
  const control = move.act ? agentControlOf(li, move.act) : null;
  if (control) act(control);
});
// The item that takes the focus is the tree's stop of the Tab key (agentRove) — the keyboard's
// and a click's alike: a click on a row focuses its item, the one element of it that can take it.
document.addEventListener('focusin', (ev) => {
  const li = agentItemOf(ev.target);
  if (li) agentRove(li);
});

// Dragging the sidebar wider is exactly the case where more labels fit than did before.
window.addEventListener('resize', () => { if (vm) applyFits(); });
// 1.6 N6: a section opened after its render was laid out with no width at all; its agent rows'
// figures are fitted to the width it has now. The toggle event does not bubble.
document.addEventListener('toggle', () => { if (vm) { fitAgentNames(); fitAgentFigures(); } }, true);

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
    startLive();
    return;
  }
  if (msg.type === 'section' && vm) {
    Object.assign(vm, msg.payload);
    renderSection(msg.key);
  }
});
