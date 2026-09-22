# Folksam AI Investment Analysis — build spec

Give this file to an AI coding tool on hackathon day to build the app. It's a full spec, not a summary, everything needed to build it is here.

## goal

A tool that takes a text description of an AI investment case and returns a structured, reasoned assessment across four value categories, plus a cost estimate and a combined priority score. It's a discussion starter for an investment committee, not a decision engine, so it has to resist being trusted uncritically, not just say so.

## stack

Node.js + Express backend, one server file. Plain HTML/CSS/JS frontend, no framework, no build step. LLM calls go through OpenRouter (`https://openrouter.ai/api/v1/chat/completions`), default model `google/gemini-2.0-flash-001`, configurable via `OPENROUTER_MODEL` env var. No database, no auth, everything lives in the browser session.

Mock mode is required: when `OPENROUTER_API_KEY` is unset or still the placeholder value, every endpoint returns clearly-labeled fake data instead of calling the model. This lets the full UI/flow get tested without spending API credits, and means the app never hard-errors just because a key isn't set yet.

## the four categories

Fixed, always these four, ids match the brief:

- `effektokning` — Effektökning / efficiency gain
- `kompetenshojning` — Kompetenshöjning / skill-competence increase
- `nyttoInnovationshojning` — Nytto-/innovationshöjning / benefit-innovation increase
- `riskreducering` — Riskreducering / risk reduction

Each category, once scored, has this shape: `{ score: 1-5, reasoning: string, confidence: "low"|"medium"|"high", citations: [{title, url}] }`.

## priority score (computed in code, not by the model)

```
COST_MULTIPLIERS = { 1: 1.3, 2: 1.15, 3: 1.0, 4: 0.85, 5: 0.7 }
avg = average of the four category scores
priorityScore = clamp(avg * COST_MULTIPLIERS[costTier], 0.5, 5), rounded to 1 decimal
```

Higher cost tier pulls the score down. This has to be computed server-side for consistency, don't let the model compute it.

## endpoints

**GET /api/health** → `{ ok: true, hasKey: bool, mode: "live"|"mock" }`

**POST /api/evaluate** — body `{ caseText: string }`. Main scoring call: send `caseText` to the model with the scoring system prompt (below), get back categories (score/reasoning/confidence, citations left empty), `missingInfo` (array of concrete gaps in the case description), `costEstimate: {tier, label, reasoning}`, `summary`. Then, if web search is enabled, run one dedicated search call per category to fill in citations (see below). Then compute `priorityScore` server-side. Response: `{ result: {...}, categories: CATEGORIES, mode }`.

**POST /api/fill-gap** — body `{ caseText, missingItem, mode: "assume"|"user", answerText? }`. `answerText` required when `mode` is `"user"`. Reassesses the case given new information for one missing item, either the user's real answer (treated as fact) or an AI-invented plausible assumption (clearly labeled as speculative). Returns `{ assumption: string|null, changedCategories: { categoryId: {score, reasoning} } }` — only categories that would meaningfully change, not the whole scorecard.

**POST /api/challenge** — body `{ caseText, categoryId, categoryScore, categoryReasoning }`. Generates one skeptical, specific challenge question targeting the given category, in the voice of a cautious committee member. Returns `{ question: string }`.

**POST /api/challenge/respond** — body `{ caseText, categoryId, categoryScore, categoryReasoning, question, defense }`. Judges whether the user's defense adds genuine new concrete information (changes the score) or is just confident restatement (doesn't). Returns `{ scoreChanged: bool, newScore: number, reasoning: string, verdictNote: string }`.

All endpoints return mock data (see mock section) when no real API key is set, same response shape, values clearly marked "MOCK DATA".

## citations: one dedicated search per category, not one shared search

Don't do a single web search covering all four categories at once, in testing that surfaced at most one source total. Instead, after the main scoring call, run four separate `Promise.allSettled` calls in parallel, one per category, each with OpenRouter's `plugins: [{ id: "web" }]` enabled, each searching for 0-2 real sources relevant to that specific category's claim. Sourcing rule for the prompt: prefer peer-reviewed research, McKinsey/Gartner-style analyst reports, public company reports, avoid forums and low-quality blogs, never invent a title or URL, return an empty array rather than force a weak match. If one category's search call fails, don't fail the whole request, just leave that category's citations empty and log it. Add a `WEB_SEARCH=false` env toggle to turn this off entirely (saves 4 model calls per evaluation).

## system prompts

**Scoring prompt** (main `/api/evaluate` call, temperature 0.2, no web search):

> You are an assistant that helps an investment committee at Folksam (a Swedish insurance company) reason through AI investment cases. You do NOT decide whether a case is good or bad. You produce a structured, honest, questionable draft assessment that a human committee will discuss, challenge, and refine.
>
> Score the case on the four categories above. For each: score 1-5, reasoning (2-4 sentences, grounded in specifics from the case, not generic AI benefits), confidence (low/medium/high, low when the case doesn't give enough to judge). Leave citations empty, that's filled in separately. Then: missingInfo (concrete gaps that would change the assessment, empty array if well specified), costEstimate ({tier 1-5, label, reasoning}, tier 1 low cost/effort, tier 5 high, say explicitly if estimating with limited information), summary (2-3 sentences, framed as a discussion starter, not a verdict). Do NOT compute an overall or priority score yourself. Always respond in English, regardless of the case description's language. Return ONLY valid JSON, no markdown fences.

**Citation search prompt** (per category, temperature 0.2, web search on): search for 0-2 real sources relevant to one category's specific claim (a comparable real case, a relevant statistic, a report finding), apply the sourcing rule above, return `{citations: [{title, url}]}`, empty array if nothing credible turns up.

**Gap-fill prompt** (temperature 0.4 for `mode: "assume"`, 0.2 for `mode: "user"`): given a previously-flagged missing item and either a user-supplied real answer or a request to invent one plausible clearly-speculative assumption, reassess the four categories and return only the ones that would meaningfully change.

**Challenge question prompt** (temperature 0.4): play a skeptical, experienced committee member, write one sharp specific challenge question targeting the weakest part of one category's reasoning, not generic skepticism.

**Challenge response prompt** (temperature 0.2): judge honestly whether the user's reply adds genuine new concrete information (numbers, specifics, plans, evidence) or is just confident-sounding reassurance with no new substance. Only change the score if there's something concrete that wasn't there before. Don't be swayed by tone or persuasiveness alone.

## frontend flow

Textarea for case input → submit to `/api/evaluate` → render: priority score headline, cost tier row, a card per category (score, a bar, reasoning, confidence badge, citations list), a missing-info list, then auto-trigger the debate flow (pick the weakest category client-side: lowest confidence, tie-broken by lowest score, call `/api/challenge`).

Each missing-info item gets two buttons: "see AI's best guess" (calls `/api/fill-gap` with `mode: "assume"`) and "answer it myself" (shows a textarea, calls `/api/fill-gap` with `mode: "user"`). Render the assumption (if any) and the changed categories as a diff-style side note, don't touch the main scorecard.

Debate box: shows the challenge question, a textarea for the user's defense, submit calls `/api/challenge/respond`. If `scoreChanged`, update that category's score/bar/reasoning live in the DOM and recompute the priority score client-side (mirror the same `COST_MULTIPLIERS` formula, no round trip needed).

Show a mock-mode banner on page load if `/api/health` reports `mode: "mock"`.

## mock mode

When no real key is set, every endpoint returns fake but structurally identical data instead of calling OpenRouter, clearly labeled "MOCK DATA" in every reasoning/text field so it's never mistaken for a real assessment. This is what makes the app demoable and testable without burning hackathon API credits.

## build order

1. `/api/evaluate` with the four categories, mock mode, priority score formula. This alone is a working demo.
2. Frontend to call it and render the cards.
3. Debate mechanic (`/api/challenge` + `/api/challenge/respond`), this is the main differentiator, don't skip it.
4. Gap-fill (`/api/fill-gap`).
5. Per-category citations, this is the most expensive part (4 extra model calls per evaluation), do it last and keep the `WEB_SEARCH=false` toggle so it can be turned off if credits run low.
