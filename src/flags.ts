// SPDX-FileCopyrightText: 2026 Frederik Marx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 1.9 A3b: the flags of the language picker, as inline SVG markup — never emoji.
 *
 * Why drawings of our own: Windows' emoji font draws no flags (a regional-indicator pair shows as
 * the two letters "US"), Linux draws them only with a colour emoji font installed, and a picker
 * whose flags turn into letter pairs on the most common desktop is not the picker it was asked to
 * be. Markup written into the page is DOM, not a load: no font, no file, no CDN, nothing the page's
 * CSP would have to allow (§0).
 *
 * The rules every drawing keeps — test/flags.test.ts holds each of them:
 *
 *  • one 3:2 box, `FLAG_VIEWBOX`; the page sizes it by CSS, so the `<svg>` carries no width or height;
 *  • at most 1 KB each; only `<svg>`, `<g>`, `<rect>`, `<circle>`, `<path>` and `<polygon>`, and
 *    only the attributes of `FLAG_ATTRIBUTES` — no `style`, no `href`, no event handler, no `url(`;
 *  • `aria-hidden="true"` and `focusable="false"` on every `<svg>`: a flag is decoration. The
 *    language's name always stands beside it, because a flag is a country, not a language
 *    (the US flag marks English because Frederik chose it, Spain's Spanish, Brazil's Brazilian
 *    Portuguese, and the two Chinese entries carry the flags of the lead's list, §7a Q2);
 *  • simplified: no coat of arms, the US canton's fifty stars as a grid of dots (nine rows of six
 *    and five), Korea's trigrams as bars, Brazil without its motto band and stars. Each is drawn
 *    from the flag's public construction — China's stars on its 30 × 20 grid, Turkey's crescent
 *    and star from the flag law's circles, the sun of 繁體中文's flag with its twelve rays and ring;
 *  • `auto` is a globe drawn in `currentColor`, so forced colours repaint it; every country flag
 *    keeps its own colours (the page gives it `forced-color-adjust: none` and an outline, P2).
 *
 * Pure: no runtime import, no vscode, nothing computed from the environment. The page gets these strings
 * in front of its script (`const FLAGS`, 1.9 P2), as it gets SRC_IDS.
 */

import type { FlagId } from './languages'

/** Every flag is drawn in this box (3:2); the page sizes it by CSS. */
export const FLAG_VIEWBOX = '0 0 30 20'

/** The elements a drawing may use — a small tag scan in the tests holds every flag to them. */
export const FLAG_ELEMENTS: readonly string[] = ['svg', 'g', 'rect', 'circle', 'path', 'polygon']

/** The attributes a drawing may use. */
export const FLAG_ATTRIBUTES: readonly string[] = [
  'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'd', 'points', 'fill', 'stroke',
  'stroke-width', 'transform', 'aria-hidden', 'focusable', 'class',
]

/**
 * The one opening tag: the box, the page's class, and hidden from assistive technology. No `xmlns`:
 * markup inside an HTML page needs none, and its namespace URL is an `http` literal the privacy scan
 * (`npm run check:privacy`) would have to allow once the page carries these (1.9 P2).
 */
function svg(body: string): string {
  return `<svg class="flag" viewBox="${FLAG_VIEWBOX}" aria-hidden="true" focusable="false">${body}</svg>`
}

/**
 * 1.9 A: the flags as inline SVG markup, by `FlagId` and `auto`. Colours are the flags' published
 * ones as far as a small drawing needs them; the stripes and bands are the flags' own proportions.
 */
export const FLAG_SVG: Readonly<Record<FlagId | 'auto', string>> = Object.freeze({
  us: svg('<rect width="30" height="20" fill="#B22234"/><path d="M0 2.31h30M0 5.38h30M0 8.46h30M0 11.54h30M0 14.62h30M0 17.69h30" stroke="#FFF" stroke-width="1.54"/><rect width="12" height="10.77" fill="#3C3B6E"/><path d="M.7 1.08h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M1.7 2.15h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M.7 3.23h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M1.7 4.31h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M.7 5.38h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M1.7 6.46h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M.7 7.54h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M1.7 8.62h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6M.7 9.69h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6m1.4 0h.6" stroke="#FFF" stroke-width=".6"/>'),
  de: svg('<rect width="30" height="20" fill="#FFCE00"/><rect width="30" height="13.33" fill="#DD0000"/><rect width="30" height="6.67" fill="#000000"/>'),
  fr: svg('<rect width="30" height="20" fill="#EF4135"/><rect width="20" height="20" fill="#FFFFFF"/><rect width="10" height="20" fill="#0055A4"/>'),
  es: svg('<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>'),
  br: svg('<rect width="30" height="20" fill="#009C3B"/><polygon points="15,2.4 27.5,10 15,17.6 2.5,10" fill="#FFDF00"/><circle cx="15" cy="10" r="5" fill="#002776"/>'),
  it: svg('<rect width="30" height="20" fill="#CE2B37"/><rect width="20" height="20" fill="#FFFFFF"/><rect width="10" height="20" fill="#009246"/>'),
  jp: svg('<rect width="30" height="20" fill="#FFFFFF"/><circle cx="15" cy="10" r="6" fill="#BC002D"/>'),
  kr: svg('<rect width="30" height="20" fill="#FFFFFF"/><g transform="rotate(33.69 15 10)"><circle cx="15" cy="10" r="5" fill="#CD2E3A"/><path d="M10 10a5 5 0 0 0 10 0a2.5 2.5 0 0 0-5 0a2.5 2.5 0 0 1-5 0z" fill="#0047A0"/><path d="M7.08 7.5v5M5.83 7.5v5M4.58 7.5v5M22.92 7.5v2.29m0 .42v2.29M24.17 7.5v2.29m0 .42v2.29M25.42 7.5v2.29m0 .42v2.29" stroke="#000000" stroke-width=".83"/></g><g transform="rotate(-33.69 15 10)"><path d="M22.92 7.5v2.29m0 .42v2.29M24.17 7.5v5M25.42 7.5v2.29m0 .42v2.29M7.08 7.5v5M5.83 7.5v2.29m0 .42v2.29M4.58 7.5v5" stroke="#000000" stroke-width=".83"/></g>'),
  cn: svg('<rect width="30" height="20" fill="#EE1C25"/><g fill="#FFFF00"><polygon points="5,2 6.76,7.43 2.15,4.07 7.85,4.07 3.24,7.43"/><polygon points="9.14,2.51 10.39,1.08 10.22,2.97 9.25,1.34 11,2.09"/><polygon points="11.01,4.14 12.72,3.3 11.83,4.99 11.56,3.1 12.88,4.47"/><polygon points="11.04,6.73 12.94,6.66 11.44,7.83 11.96,6 12.62,7.79"/><polygon points="9.22,8.38 11,9.05 9.16,9.55 10.35,8.06 10.26,9.96"/></g>'),
  tw: svg('<rect width="30" height="20" fill="#FE0000"/><rect width="15" height="10" fill="#000095"/><polygon points="11.25,5 9.34,5.49 10.75,6.88 8.84,6.34 9.38,8.25 7.99,6.84 7.5,8.75 7.01,6.84 5.63,8.25 6.16,6.34 4.25,6.88 5.66,5.49 3.75,5 5.66,4.51 4.25,3.13 6.16,3.66 5.62,1.75 7.01,3.16 7.5,1.25 7.99,3.16 9.38,1.75 8.84,3.66 10.75,3.12 9.34,4.51" fill="#FFFFFF"/><circle cx="7.5" cy="5" r="2.13" fill="#000095"/><circle cx="7.5" cy="5" r="1.88" fill="#FFFFFF"/>'),
  ru: svg('<rect width="30" height="20" fill="#D52B1E"/><rect width="30" height="13.33" fill="#0039A6"/><rect width="30" height="6.67" fill="#FFFFFF"/>'),
  tr: svg('<rect width="30" height="20" fill="#E30A17"/><circle cx="10" cy="10" r="5" fill="#FFFFFF"/><circle cx="11.25" cy="10" r="4" fill="#E30A17"/><polygon points="13.92,10 18.44,8.53 15.65,12.38 15.65,7.62 18.44,11.47" fill="#FFFFFF"/>'),
  pl: svg('<rect width="30" height="20" fill="#DC143C"/><rect width="30" height="10" fill="#FFFFFF"/>'),
  cz: svg('<rect width="30" height="20" fill="#D7141A"/><rect width="30" height="10" fill="#FFFFFF"/><polygon points="0,0 15,10 0,20" fill="#11457E"/>'),
  auto: svg('<g fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="15" cy="10" r="8.4"/><path d="M6.6 10h16.8M7.9 5.5h14.2M7.9 14.5h14.2M15 1.6v16.8a4.2 8.4 0 0 1 0-16.8a4.2 8.4 0 0 1 0 16.8"/></g>'),
})
