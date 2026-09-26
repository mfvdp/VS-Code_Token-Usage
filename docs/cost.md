<!--
SPDX-FileCopyrightText: 2026 Frederik Marx
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# The “API cost” column

Part of the [Token Pace documentation](../README.md#documentation).

What this usage would have cost through the provider API at list prices, computed per model,
because the rates differ by a factor of 50.

**On a subscription you do not pay these amounts.** The figure has no billing relationship;
it only answers “what would this have been through the API”. Every such number carries a `~`.

**Prices as of 6 September 2026**, sourced from [docs.claude.com](https://docs.claude.com) and
[developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing); the
legacy Anthropic rows (Claude 4.x and 3.x) come from an earlier check of the same table on
13 August 2026, and the **Claude Opus 5.5** row from a check of Anthropic's pricing page on
**24 September 2026** ([platform.claude.com](https://platform.claude.com/docs/en/about-claude/pricing)).
Every rule carries the day it was read and names the page it was read from — `docs.claude.com`,
`platform.claude.com` or `developers.openai.com`, the host names an export lists as its `sources` —,
so a rate never applies retroactively without saying so: a bucket from a day no rule covers is
priced from the nearest known rule and marked `approximate`. The dashboard's footnote names both
days — `Prices as of 2026-09-06; checked later: claude-opus-5-5 (2026-09-24).` —, under the provider
switch's Codex view the table's alone, and the Models table's `list as of` date is the row's own.

**Claude Opus 5.5** (1.8): $4 per million input tokens, $5 for a 5-minute cache write, $8 for a
1-hour cache write, $0.20 for a cache hit and $20 for output; fast mode $8 in and $40 out. Until 1.8
the table had no row for it, so its usage was reported as unpriced — left out of the total, the model
named. Since 1.8 it is priced everywhere the page shows a cost, and its usage from the days before
24 September 2026 is priced from this row and marked `approximate`. It also changes the
family fallback (*Unknown models*, below): an Opus model the table does not know now borrows
Opus 5.5's rates, the newest priced Opus.

* **Anthropic cache rates** are fixed multiples of the input rate — 5-minute write 1.25×,
  1-hour write 2×, read 0.1× — and the two write TTLs are counted separately. The read multiple
  is overridden where it is not universal: Fable 5.1 and Mythos 5.1 read cache at a flat
  $0.25/MTok (0.025×), and deriving it from the multiple would overstate cache-heavy usage
  fourfold; Opus 5.5 reads it at $0.20/MTok (0.05×).
* **OpenAI**: the cached-read rate is stated separately, cache writes are not charged, and
  `input_tokens` already includes the cached tokens — counting both would pay for them twice.
* **Fast mode** is priced only where the table actually publishes fast rates. Today that is
  Claude **Opus 5.5** ($8 / $40), **Opus 5** and **Opus 4.8** ($10 / $50) — twice their standard
  rates; their cache rates are scaled by the same factor, which is stated rather than applied
  silently — and GPT-6 Astra; Opus 4.6 accepts fast requests but runs and bills them at its
  standard rates. Fast-mode usage of any other model is reported as **unpriced** with the reason
  *fast rate unknown* and left out of the total — the tokens are known, only their price is not.
  Billing it at the standard rate would understate fast turns by a factor of two or more.
* **US-only inference** (`usage.inference_geo === "us"`) carries a **1.1×** surcharge, applied to
  the token cost of those buckets.
* **Web search** is billed per call, not per token: **$10 per 1,000 searches** (Anthropic). Web
  fetch is free. Codex reports no such counter and contributes nothing there.

**Your own rates.** `tokenPace.pricing.multiplier` scales every list price for a contract
discount (`0.9` for 10 % off). `tokenPace.customPrices` merges **field-wise** over the built-in
table, so you can correct a single rate and leave the rest alone; keys are normalised, so
`claude-opus-5[1m]` and `Anthropic/GPT-5` both find their model. Non-numeric or negative values
are ignored, not guessed. As soon as either applies, the figures are labelled “at your
configured rates”, and `tokenPace.pricing.showListPrice` adds the undiscounted figure as a second
column, in the manner of the `amount` / `list_amount` pair of the provider analytics APIs. The CSV
and JSON [exports](export.md) carry both amounts for every bucket, whatever `showListPrice` says —
`costUsd` at your configured rates and `listCostUsd` at the list price — with the day of the rule
each was priced by (`priceFrom`) and whether no rule covered its day (`priceApproximate`). Where a
custom price alone prices a model the table does not know, the two amounts are the same: a discount
against a price that was never published would be an invention.

**Unknown models.** `tokenPace.unknownModelPricing: strict` (default) reports a lower bound and
names the models rather than inventing a number. `family` opts in to borrowing the newest priced
model of the same family (`claude-opus-4-9` → `claude-opus-5-5`, `gpt-5.7-mini` → `gpt-5.4-mini`),
and every figure so derived is marked as a family fallback in the tooltip, the dashboard
footnotes, the markdown summary and the export.

`tokenPace.showCost: false` hides the column everywhere.

Amounts are shown to the cent below $100 and rounded to whole dollars from $100 up, where
the cents no longer carry information anyone acts on. Exactly zero is a dash, because no
usage says something different from $0.00; a real amount under a cent shows as `<$0.01`
rather than rounding away to nothing.
