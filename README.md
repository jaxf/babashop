# Babashop — Courtside

A buildless, basketball-themed Sleeper league dashboard for league `1401342003886714880`.

## Pages

- Courtside: league snapshot, power leaders and searchable team directory.
- Standings: sortable standings, weekly matchup selector and season records.
- Power rankings: performance, recent scoring and luck context.
- Draft: draft value reports and team links.
- Schedule: opponent strength and remaining schedule.
- Front office: interactive player trade machine, move filters and explained ratings.
- Team: roster grades, trends, schedule, form and transactions.

## Run and deploy

Serve this directory with `python3 -m http.server 8080`. No build step, dependencies or API key. GitHub Pages serves the root of `main`.

Run model checks with `node tests/ratings.test.cjs`.

## Ratings

`ratings.js` uses league-scored **weekly** player points (not NBA per-game averages). Production is 75% season average / 25% recent three-week average, normalized above the observed pool's 80th-percentile replacement baseline. Draft capital supplies a nonlinear prior; production weight is `weeks / (weeks + 4)`. Unknown values stay ungraded. Inactive players have zero value, while missing NBA affiliation without production is treated as unknown. Injury flags lower confidence.

Package values subtract 12 baseline units per player. Balanced deals score 70; value differences move the score up or down. Low/medium confidence shrinks the difference from neutral by .55/.8. Picks use a round heuristic with 15% annual discount; FAAB is normalized to league budget. These are **current-value estimates**, not trade-date verdicts, forecasts, or optimized lineup recommendations. The sandbox supports players; completed transactions include picks and FAAB. Eligibility, keeper rules, game schedules and recovery forecasts are not modeled.

Incomplete current weeks are excluded from analytics. Matchups still display live scores. Public Sleeper endpoints supply all data; no roster mutations or trades are submitted.
