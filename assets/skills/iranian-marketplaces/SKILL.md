---
name: iranian-marketplaces
description: Use Digikala, Torob and Divar MCP tools for Iranian shopping, seller and price comparisons, used goods, cars and housing listings. Use when the user names these marketplaces or wants Iranian products or classified ads; not for developer services or Xratu's MCP marketplace setup.
---

# Iranian marketplace research

Use the connected MCP tools to answer with current listings and evidence.
Choose the source that fits the request; keep an explicitly requested site.

- **Digikala:** retail products, buyer reviews, seller offers, discounts and
  recent price history on Digikala.
- **Torob:** compare a product's offers across shops, delivery charges,
  seller reputation and price history.
- **Divar:** classified ads, used goods, cars, property sales and rentals.
  A seller's asking price is not a completed sale price.

For a cross-site comparison, match model, capacity, condition, warranty and
seller terms before comparing prices. A used Divar listing and a new retail
product need separate treatment. Ask for the city when it changes a Divar
or in-person search and the conversation has not supplied one; do not
silently accept a tool's Tehran default.

## Tool selection

Xratu's default names are `mcp__digikala__<tool>`,
`mcp__torob__<tool>` and `mcp__divar__<tool>`. Server names can be changed,
so use the tools actually exposed in the current session and their live
schemas. The two `find_best_value` tools belong to different servers and
have different parameters. These integrations only read public data;
they cannot buy, contact sellers or retrieve private phone numbers.

If a required server is unavailable, say which source could not be checked
and continue with available sources when useful. Do not present remembered
prices as current or install/reconfigure servers as part of a shopping task.

### Digikala

- For the cheapest matching product, use `dk_find_cheapest`, then
  `dk_product` on a candidate to inspect all sellers. Sorting `dk_search`
  by cheapest can put accessories ahead of the actual product. Read match
  notes: even the specialized search can fall back to partial matches.
- For best options within a budget, use `dk_best_for_budget` with
  `max_price` in Toman. Review the returned ranking and buyer count;
  a high star rating with few reviews is weak evidence.
- Use `dk_reviews` for buyer feedback and `dk_compare` for specifications.
  For an existing shortlist, `dk_shortlist` refreshes up to ten product IDs
  in one call. IDs are the numeric part of `dkp-<id>` product links.
- Use `dk_price_history` for whether today's price is attractive. Compare
  the same variant; distinguish a one-day dip from `lowest_2_days` or the
  shortlist's sustained `low_30d`. The shortlist low may cover another color.

### Torob

- Use `torob_suggest` when colloquial wording or spelling is uncertain,
  then `search_products`; use `find_best_value` for budget-based picks
  (`budget_toman`) rather than treating a broad search as a recommendation.
- A search card shows one starting price. Call `product_details` with the
  returned `prk` and the **same card's** `details_url` to compare seller
  offers. Exclude unavailable offers from buyable recommendations and
  preserve `price_unreliable` warnings.
- Use `shop_profile` for seller evidence and `price_history` for trends.
  Include stated postage when available; missing postage does not mean
  free shipping. State the age of in-person shelf prices when reported.

### Divar

- Start unclear category, city or neighborhood requests with
  `divar_suggest`. Use its category slugs, district IDs and supported
  filters instead of inventing them. Check `filters_not_applied` before
  claiming a result satisfies the user's constraints.
- Use `search_ads` to browse, `find_best_value` for budget-based picks
  (`budget_toman`), and `market_price` for comparison with a live sample.
  Fetch `ad_details` for finalists; `get_ads_batch` and `compare_ads` help
  compare an existing shortlist. Reuse returned ad tokens.
- Negotiable prices are `null`, not zero. Treat `price_is_placeholder`
  and `price_note` as evidence that the displayed number may not be an
  asking price. Keep these listings distinct from priced bargains.
- For rentals, report monthly `price_toman` and `deposit_toman`
  separately. Preserve placeholder flags on both, and distinguish shared
  rooms from whole apartments. Explain sample size and exclusions when
  using `market_price`; its median is a sample, not an appraisal.

## Presenting results

These tools return Toman; do not divide their prices by ten again. Convert
an explicitly Rial-denominated budget to Toman once (ten Rial per Toman).
Clarify an ambiguous budget unit when it would change the shortlist.

Keep the answer in the user's language. Give a short, relevant shortlist
with source links, exact variant or condition, seller, price unit, and the
evidence behind the recommendation. State missing stock, delivery or
condition information instead of filling it in. Say "cheapest found"
rather than claiming a limited search covered the entire market.

Recheck finalists when the user is ready to choose; prices and listings
change and responses can be cached. Keep requests bounded: use batch
tools for known IDs, avoid exhaustive pagination, and honor retry/backoff
messages rather than repeatedly hammering a failing service.

Tool behavior references: [Digikala](https://github.com/sepehr071/digikala-mcp),
[Torob](https://github.com/mmdju/torob-mcp),
[Divar](https://github.com/mmdju/divar-mcp). Prefer connected tool schemas
over examples in these references when versions differ.
