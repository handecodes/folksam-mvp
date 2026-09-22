# Folksam AI Investment Analysis — MVP

Minimal working version of the Folksam Challenge tool: paste an AI investment
case, get back a case-level summary (what's missing, overall cost burden), and
a side-by-side comparison of three ways to actually BUILD it — AI-only, a mixed
AI+human split by module, and a dev-team-only build — each rated on the four
Folksam evaluation categories separately, since the score genuinely depends on
which resources are doing the work.

## What's in here

- `server.js` — Node/Express backend, two endpoints:
  - `POST /api/evaluate` — case-level pass: what's missing from the
    description, an overall cost-burden estimate, and a plain-language summary.
  - `POST /api/build-approaches` — the main event: three build approaches
    (ai-only / mixed / dev-team), each with a narrative, team/roles, elapsed
    weeks, required inputs, a risk note, and the four value categories scored
    for that specific approach.
- `public/index.html` — plain HTML/JS frontend. Textarea in, a case-summary
  strip + "what's missing" panel, then a 3-column build-approach comparison.
- `.env.example` — copy to `.env` and add your real OpenRouter key.

## Run it

```
npm install
cp .env.example .env   # then edit .env and paste your OpenRouter key
npm start
```

Open http://localhost:3000


## What's already built

- Case-level pass (`/api/evaluate`): `missingInfo` (concrete gaps that would
  change an assessment), an overall `costEstimate` (tier 1-5 + reasoning), and
  a `summary` framed as a discussion starter, not a verdict. This pass no
  longer scores the four value categories, see below for why.
- Build-approach comparison (`/api/build-approaches`), rendered as three
  columns, **AI-only, Mixed, Dev team only, in that fixed order (mixed in the
  middle)**, since mixed is the approach whose whole point is sitting between
  the two extremes on cost/time/risk. For each approach:
  - a narrative of how the work would actually get done
  - team/roles needed (role, seniority, headcount, hours)
  - estimated elapsed weeks
  - what has to exist before that approach can even start
  - a risk note specific to that approach and case
  - for the mixed column only, the actual module-by-module split
    (builder AI/human, named reviewer, rationale)
  - **the same four value categories (effektökning, kompetenshöjning,
    nytto-/innovationshöjning, riskreducering), each scored separately FOR
    THAT APPROACH** — not once for the case in the abstract. The scoring logic
    is identical across all three approaches, only the inputs differ: each
    category is judged against that approach's own roles/hours/timeline, and
    riskreducering specifically is a resources check — does that approach's
    actual team/reviewer setup cover the case's criticality, or does it leave
    a gap? An approach with no named reviewer on a critical module scores
    lower there than one with matched review, regardless of which approach
    (AI-only, mixed, or dev-team) it is.
  - a `priorityScore` per approach, computed server-side the same way as
    before: average of the four category scores, adjusted by a cost-tier
    multiplier (`COST_MULTIPLIERS` in `server.js`), so it's consistent and
    explainable rather than another number the model just states.
  - SEK cost per approach, also computed server-side from a fixed rate card
    (`ROLE_RATES_SEK_PER_HOUR`: junior 450, mid 800, senior 1200, specialist
    1300, lead 1500, AI build capacity 200 SEK/h) applied to the model's own
    role/hours estimates for that approach, same "compute the number in code,
    not by the model" philosophy used throughout.
  - Triggered by its own "Compare build approaches" button, separate from
    `/api/evaluate`, so it doesn't cost extra tokens on every case submission.
- Low temperature (0.2-0.3) on both model calls to reduce run-to-run
  inconsistency, since this is a scoring tool, not a creative one.
- Mock mode: when no real `OPENROUTER_API_KEY` is set, both endpoints return
  clearly-labeled fake data with the same shape, so the full UI/flow is
  testable without spending API credits. `buildMockApproaches` in `server.js`
  deliberately varies its mock category scores per approach (ai-only lowest on
  riskreducering, dev-team highest) to demonstrate the intended pattern even
  without a live key.

## Removed from the previous version

The single case-level scorecard, its debate/challenge-and-defend mechanic,
the gap-fill "see AI's best guess" / "answer it myself" actions, the per-
category live citation search, and the posture-weighting toggle were all
removed. They were all built around scoring the case once, in the abstract —
now that the four categories are scored once per build approach instead
(which is the more useful comparison), those mechanics didn't have a single
case-level score left to operate on. Re-introducing an equivalent debate/
citation mechanic per-approach is a reasonable next step if there's time, see
below.

## Not built yet (from the brainstorm, in rough priority order)

1. Side-by-side comparison of multiple different cases (the brief's own
   stretch goal), separate from the build-approach comparison which compares
   three ways to build the *same* case.
2. A per-approach debate/challenge mechanic — the old case-level version was
   removed since it needs a single target score to argue about; re-doing it
   per approach (e.g. "challenge the mixed approach's riskreducering score")
   is possible but not yet built.
3. Per-approach citations — the old version ran one web-search call per
   category; re-doing that per (approach × category) would be 12 extra model
   calls per comparison, so it needs a deliberate cost/value tradeoff call
   before building it back in.
4. Committee memory — logging human overrides over time so the tool
   calibrates to this specific group's risk appetite. Flagged as hard to
   demo live without seeded fake history, since there's no real override
   data yet.
5. Audit trail: log each evaluation (input, scores, reasoning, timestamp)
   somewhere persistent instead of only showing it in the browser.
6. Consistency check: run the same case 2-3 times and show the score range
   instead of a single number, if variance turns out to be a real problem.

## Notes

- Model defaults to `google/gemini-2.0-flash-001` via OpenRouter, matching
  what the workshop confirmed was available. Change `OPENROUTER_MODEL` in
  `.env` if your team settles on something else.
- No database, no auth, no persistence, everything lives in the browser
  session. That's intentional for an MVP, add storage only if the team
  decides this direction is worth extending past Wednesday.
