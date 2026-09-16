# Folksam AI Investment Analysis — MVP

Minimal working version of the Folksam Challenge tool: paste an AI investment
case, get back scores and reasoning across the four evaluation categories,
plus a note on what's missing from the case description.

## What's in here

- `server.js` — Node/Express backend, one endpoint (`/api/evaluate`) that
  calls OpenRouter with a system prompt defining the four categories and
  asks for structured JSON back.
- `public/index.html` — plain HTML/JS frontend. Textarea in, category cards
  with scores/reasoning/confidence out, plus a "what's missing" panel.
- `.env.example` — copy to `.env` and add your real OpenRouter key.

## Run it

```
npm install
cp .env.example .env   # then edit .env and paste your OpenRouter key
npm start
```

Open http://localhost:3000

## What's already built

- Core scoring: effektökning, kompetenshöjning, nytto-/innovationshöjning,
  riskreducering, each with a score (1-5), a reasoning string, and a
  confidence level (low/medium/high).
- Overall score: simple average of the four, shown as a headline number.
- "What's missing" panel: model flags gaps in the case description that
  would change its assessment.
- Low temperature (0.2) set on the model call to reduce run-to-run
  inconsistency, since this is a scoring tool, not a creative one.
- Sourcing preference baked into the system prompt (prefer peer-reviewed
  research, McKinsey/Gartner-style reports, avoid forums/low quality blogs).
- Live web search grounding, one dedicated search call per category
  (not one shared call for all four), so each category's claim gets its
  own real chance at a real source instead of the whole evaluation
  sharing whatever one search happened to turn up. Citations (title + URL)
  show up under any category that got something genuinely relevant, empty
  otherwise. This costs 4 extra small model calls per evaluation on top of
  the main one, set `WEB_SEARCH=false` in `.env` to turn it off entirely if
  you need to save credits or speed things up. NOT tested against a real
  key yet, since building this session had no live OpenRouter key to call —
  test it with your key before relying on it for the demo.
- Cost is now actually weighed into the priority score. The model returns
  a cost tier (1-5) with its own reasoning, and the server (not the model)
  computes `priorityScore = average value score * cost multiplier`, so
  higher cost pulls the ranking down. This closes the gap where the brief
  asks for value weighed against cost but the old version just averaged
  the four value categories.
- Debate mechanic, first version: after scoring, the app automatically
  picks the weakest category (lowest confidence, tie-broken by lowest
  score) and asks the model to generate one skeptical challenge question
  about it, in the voice of a cautious committee member. You type a
  defense, and a second model call judges whether your reply added real
  new information or was just confident restatement, if it did, that
  category's score updates live and the priority score recalculates.
  This is the piece meant to make "don't trust this uncritically" actually
  true in practice, not just a disclaimer.
- Gap-fill on the "what's missing" list: each flagged gap now has two
  buttons, "see AI's best guess" (the model invents one plausible,
  clearly-labeled assumption for that gap and shows how the assessment
  would shift if it were true) and "answer it myself" (you type the real
  answer and get the same kind of updated assessment, treated as fact
  instead of a guess). Only categories that would actually change are
  shown, not the whole scorecard again. This doesn't touch the main
  scores on screen, it's a side-by-side "what if" view.

## Not built yet (from the brainstorm, in rough priority order)

1. The "different paths" view — same case scored under different company
   postures (risk-averse / growth-focused / cost-conscious). Cheap version:
   just reweight the four scores that already exist. Richer version: ask
   the model to reason differently per posture (separate calls).
2. Committee memory — logging human overrides over time so the tool
   calibrates to this specific group's risk appetite. Flagged as hard to
   demo live without seeded fake history, since there's no real override
   data yet.
3. Side-by-side comparison of multiple cases (the brief's own stretch goal).
4. Audit trail: log each evaluation (input, scores, reasoning, timestamp)
   somewhere persistent instead of only showing it in the browser.
5. Consistency check: run the same case 2-3 times and show the score range
   instead of a single number, if variance turns out to be a real problem.
6. The debate mechanic currently only challenges one category, once. It
   doesn't yet let you keep arguing multiple rounds, or challenge more
   than one category per case.

## Notes

- Model defaults to `google/gemini-2.0-flash-001` via OpenRouter, matching
  what the workshop confirmed was available. Change `OPENROUTER_MODEL` in
  `.env` if your team settles on something else.
- No database, no auth, no persistence, everything lives in the browser
  session. That's intentional for an MVP, add storage only if the team
  decides this direction is worth extending past Wednesday.
