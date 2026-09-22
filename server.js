import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// The four evaluation criteria from the Folksam brief.
// Swedish key kept as the id (matches the brief), englishLabel is just for display.
const CATEGORIES = [
  { id: "effektokning", swedish: "Effektökning", english: "Efficiency gain" },
  { id: "kompetenshojning", swedish: "Kompetenshöjning", english: "Skill / competence increase" },
  { id: "nyttoInnovationshojning", swedish: "Nytto-/innovationshöjning", english: "Benefit / innovation increase" },
  { id: "riskreducering", swedish: "Riskreducering", english: "Risk reduction" }
];

// Case-level pass: no longer scores the four categories here. Category scoring
// (effektokning/kompetenshojning/nyttoInnovationshojning/riskreducering) now happens
// once PER build approach (ai-only / mixed / dev-team) in buildApproachesPrompt,
// because the score genuinely depends on which resources/team are doing the work,
// not just on the case in the abstract. This pass only covers what's genuinely
// case-level: what's missing from the description, overall cost burden, and a
// plain-language summary for the committee.
function buildSystemPrompt() {
  return `You are an assistant that helps an investment committee at Folksam (a Swedish insurance company) reason through AI investment cases. You do NOT decide whether a case is good or bad. You produce a structured, honest, questionable draft assessment that a human committee will discuss, challenge, and refine.

You are NOT scoring the case's value categories here, that happens separately, per build approach, elsewhere. Here you only return:
- missingInfo: a short list of concrete pieces of information that, if missing from the case description, would materially change an assessment of it (e.g. "no mention of who owns the data", "no rollout cost estimate", "no team or resourcing mentioned at all"). Empty array if the case is well specified.
- costEstimate: your best estimate of the case's overall cost burden, as { "tier": 1-5, "label": "", "reasoning": "" }. tier 1 means low cost/effort, tier 5 means high cost/effort (development, infrastructure, ongoing operation combined). Base this on whatever cost/resource information the case gives you, and say explicitly in the reasoning if you're estimating with limited information. This is a rough, case-level read, a more detailed per-approach cost breakdown happens separately.
- summary: 2-3 sentences summarizing the case as a discussion starter for a committee meeting, not a verdict. Explicitly note this is a plausible assessment, not a validated truth.

Respond in the same language the case description is written in (Swedish or English).

Return ONLY valid JSON matching this shape, no markdown fences, no extra text:
{
  "missingInfo": [],
  "costEstimate": { "tier": 1, "label": "", "reasoning": "" },
  "summary": ""
}`;
}

// Priority score is computed here, not by the model, so it's consistent and explainable:
// average value score, adjusted by a cost multiplier. Higher cost tier pulls the score down.
const COST_MULTIPLIERS = { 1: 1.3, 2: 1.15, 3: 1.0, 4: 0.85, 5: 0.7 };

// Posture lenses: the same 4 category scores + cost tier, reweighted for how much a given
// company stance cares about each category. Numbers only, never re-generates reasoning text —
// the underlying evidence doesn't change, only how much weight a viewer puts on each part.
// Fixed, hand-picked weights (not AI-generated) so the math stays transparent and auditable,
// same philosophy as COST_MULTIPLIERS above.
const POSTURES = [
  {
    id: "balanced",
    label: "Balanced (default)",
    description: "Equal weight across all four categories, today's default view.",
    weights: { effektokning: 1, kompetenshojning: 1, nyttoInnovationshojning: 1, riskreducering: 1 },
    costMultipliers: COST_MULTIPLIERS
  },
  {
    id: "risk-averse",
    label: "Risk-averse",
    description: "Weighs risk reduction heavily, treats novelty/innovation as a risk rather than a virtue.",
    weights: { effektokning: 1, kompetenshojning: 1, nyttoInnovationshojning: 0.5, riskreducering: 2 },
    costMultipliers: COST_MULTIPLIERS
  },
  {
    id: "growth-focused",
    label: "Growth-focused",
    description: "Weighs innovation and efficiency gains heavily, more tolerant of risk.",
    weights: { effektokning: 1.5, kompetenshojning: 1, nyttoInnovationshojning: 2, riskreducering: 0.5 },
    costMultipliers: COST_MULTIPLIERS
  },
  {
    id: "cost-conscious",
    label: "Cost-conscious",
    description: "Same weight on the four value categories, but cost tier swings the priority score much harder.",
    weights: { effektokning: 1, kompetenshojning: 1, nyttoInnovationshojning: 1, riskreducering: 1 },
    costMultipliers: { 1: 1.6, 2: 1.25, 3: 1.0, 4: 0.7, 5: 0.4 }
  }
];

function computeWeightedPriorityScore(categories, costTier, posture) {
  const weights = posture.weights;
  let weightedSum = 0;
  let weightTotal = 0;
  Object.entries(categories).forEach(([id, cat]) => {
    const w = weights[id] ?? 1;
    weightedSum += cat.score * w;
    weightTotal += w;
  });
  const avg = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const multiplier = posture.costMultipliers[costTier] ?? 1.0;
  const priority = avg * multiplier;
  return Math.round(Math.min(5, Math.max(0.5, priority)) * 10) / 10;
}

function computePriorityScore(categories, costTier) {
  return computeWeightedPriorityScore(categories, costTier, POSTURES[0]);
}

// Fixed display/response order for the three build approaches: AI-only, Mixed,
// Dev-team-only, mixed in the middle since it's the approach whose whole point is
// sitting between the two extremes on cost/risk/effort.
const APPROACH_ORDER = ["ai-only", "mixed", "dev-team"];

function sortApproaches(approaches) {
  const byId = new Map((approaches || []).map((a) => [a.id, a]));
  return APPROACH_ORDER.map((id) => byId.get(id)).filter(Boolean);
}

// --- Build-approach comparison (AI-only / dev-team-only / mixed) ---
// Cost is computed here in code from a fixed hourly rate card, same philosophy as
// COST_MULTIPLIERS above: the model estimates *structure* (roles, hours, weeks,
// required inputs, risk read), the server turns that into SEK so every run is
// comparable and auditable instead of the model just inventing a total.
const ROLE_RATES_SEK_PER_HOUR = {
  junior: 450, // e.g. a junior developer, ~1-2 years experience
  mid: 800, // e.g. a mid-level generalist developer
  senior: 1200, // e.g. a senior/principal developer or engineering lead
  specialist: 1300, // e.g. security, data governance, ML/AI engineering specialists
  lead: 1500, // e.g. architect / engineering lead owning the overall decision
  ai: 200 // AI build capacity: token/API cost + tooling license, amortized per hour of work produced
};
const SENIORITY_LEVELS = Object.keys(ROLE_RATES_SEK_PER_HOUR);

const COST_TIER_LABELS = { 1: "Very low", 2: "Low", 3: "Medium", 4: "High", 5: "Very high" };

function bucketCostToTier(sek) {
  if (sek <= 20000) return 1;
  if (sek <= 60000) return 2;
  if (sek <= 150000) return 3;
  if (sek <= 400000) return 4;
  return 5;
}

function computeApproachCost(approach) {
  const roles = Array.isArray(approach.roles) ? approach.roles : [];
  const sek = roles.reduce((sum, r) => {
    const rate = ROLE_RATES_SEK_PER_HOUR[r.seniority] ?? ROLE_RATES_SEK_PER_HOUR.mid;
    const count = Number(r.count) || 1;
    const hours = Number(r.hoursEstimate) || 0;
    return sum + rate * count * hours;
  }, 0);
  return { costSEK: Math.round(sek), costTier: bucketCostToTier(sek), costLabel: COST_TIER_LABELS[bucketCostToTier(sek)] };
}

function buildApproachesPrompt() {
  return `You are helping a Folksam investment committee understand what it would actually take to BUILD a proposed AI investment case, compared across three different build approaches. This is a companion analysis to the value/cost/risk scoring, focused specifically on team composition, timeline, and required inputs, so the committee can see concrete tradeoffs side by side, not just abstract scores.

Given the case description, produce exactly three approaches, always in this order and always all three, even if one is a poor fit (say so in its narrative/riskNotes instead of omitting it):

1. id "ai-only": built primarily by AI coding agents/assistants, with the minimum viable human oversight (someone must still define acceptance criteria and sign off, that person still counts as a role).
2. id "dev-team": built entirely by a human developer team, no AI coding assistance anywhere in the build.
3. id "mixed": the work is split by module/component, AI builds the well-patterned, low-criticality, easily-verifiable parts, named human specialists build the ambiguous/critical/security-sensitive parts, and every AI-built module has a named human reviewer.

For each approach, return:
- narrative: 2-3 sentences, specific to this case, describing how the work would actually get done under this approach.
- roles: an array of role lines needed, each { "roleLabel": short human-readable role name (e.g. "Senior full-stack developer", "Security engineer", "AI build capacity"), "seniority": one of exactly ${JSON.stringify(SENIORITY_LEVELS)} (use "ai" only for AI build-capacity lines), "count": integer number of people/units in this role, "hoursEstimate": integer estimated hours PER PERSON/UNIT for the whole project (not per week) }. Every approach must include at least one role. "ai-only" must still include at least one human role (the sign-off/reviewer) at low hours. Ground hours in the case's apparent size/complexity, don't default to the same number every time.
- timeWeeks: integer, estimated elapsed calendar weeks to deliver (accounting for realistic parallelization, not just total hours / people).
- requiredInputs: array of concrete things that must exist BEFORE this specific approach can start (e.g. "clear acceptance criteria and test cases" for ai-only, "a domain expert available for questions" for dev-team, "a named reviewer per AI-built module" for mixed). Specific to this case and this approach, not generic.
- riskNotes: 1-2 sentences on what's most likely to go wrong with this specific approach for this specific case.
- moduleSplit: for "mixed" only, an array of { "module": short name, "builder": "ai" or "human", "reviewer": role/person description, "rationale": short reason }. Empty array for "ai-only" and "dev-team".
- categories: score THIS SPECIFIC APPROACH (not the case in the abstract) on exactly these four categories: ${CATEGORIES.map((c) => `${c.id} (${c.swedish} / ${c.english})`).join(", ")}. For each, return { "score": 1-5, "reasoning": "", "confidence": "low"|"medium"|"high" }.
  The scoring LOGIC is the same across all three approaches, only the inputs change:
  * effektokning (efficiency gain): how much faster/cheaper delivery is under THIS approach's actual roles/hours/timeWeeks you just estimated above, not a generic "AI is fast" assumption.
  * kompetenshojning (skill/competence increase): how much the specific roles you named in THIS approach would grow their skills or lower the skill barrier to get started, given who (or what) is actually doing the work.
  * nyttoInnovationshojning (benefit/innovation increase): whether THIS approach's team/resource mix realistically enables trying things that wouldn't be feasible otherwise, given its actual time/cost constraints.
  * riskreducering (risk reduction): this is the resources check — does THIS approach's specific team/reviewer setup (the roles, and for mixed, the named reviewer per AI-built module) actually cover the case's criticality and security/data-sensitivity needs, or does it leave gaps? An approach with no named reviewer for a critical module, or with critical work assigned to a mismatched seniority level, must score LOWER here than one with matched, adequate review, regardless of which approach it is. Low confidence when the case doesn't give you enough to judge given that approach's specific resourcing.
  Do not just copy the same four scores across all three approaches, each approach's roles/hours/reviewers are different, so the reasoning and scores should genuinely differ approach to approach.

Do NOT compute or mention a total cost in SEK yourself, that's calculated separately from your role/hours estimates. Do NOT compute an overall/priority score, that's calculated separately from your category scores and cost.

Respond in the same language as the case description.

Return ONLY valid JSON, no markdown fences, no extra text, matching this shape:
{
  "approaches": [
    { "id": "ai-only", "narrative": "", "roles": [{ "roleLabel": "", "seniority": "lead", "count": 1, "hoursEstimate": 1 }], "timeWeeks": 1, "requiredInputs": [], "riskNotes": "", "moduleSplit": [], "categories": { "effektokning": { "score": 1, "reasoning": "", "confidence": "low" }, "kompetenshojning": { "score": 1, "reasoning": "", "confidence": "low" }, "nyttoInnovationshojning": { "score": 1, "reasoning": "", "confidence": "low" }, "riskreducering": { "score": 1, "reasoning": "", "confidence": "low" } } },
    { "id": "mixed", "narrative": "", "roles": [], "timeWeeks": 1, "requiredInputs": [], "riskNotes": "", "moduleSplit": [], "categories": {} },
    { "id": "dev-team", "narrative": "", "roles": [], "timeWeeks": 1, "requiredInputs": [], "riskNotes": "", "moduleSplit": [], "categories": {} }
  ]
}`;
}

const APPROACH_LABELS = {
  "ai-only": "AI-only",
  "dev-team": "Dev team only",
  mixed: "Mixed (AI + team)"
};

async function callModel({ systemPrompt, userMessage, temperature = 0.2, webSearch = false }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const guardedSystemPrompt = `${systemPrompt}\n\nIMPORTANT: respond with raw JSON only, no prose before or after, no apologies or refusals in plain text outside the JSON. If you lack enough information to judge something, reflect that inside the JSON itself (low confidence, an empty array, a note in a reasoning field), never by responding outside the JSON structure.`;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      messages: [
        { role: "system", content: guardedSystemPrompt },
        { role: "user", content: userMessage }
      ],
      ...(webSearch ? { plugins: [{ id: "web" }] } : {})
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Model request failed (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) {}
    }
    throw new Error(`Model did not return valid JSON, got: "${cleaned.slice(0, 200)}"`);
  }
}

function hasRealKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return Boolean(apiKey) && apiKey !== "your_key_here";
}

// Mock category scores per approach: same shape the model would produce, deliberately
// different score/confidence per approach so the mock UI demonstrates the point
// (riskreducering in particular should read lowest for ai-only, highest for dev-team,
// mixed in between, since mixed and dev-team both have a named human reviewer while
// ai-only's review is thin, matching the "resources check" logic in the real prompt).
function mockCategories({ effekt, kompetens, nytto, risk, riskReasoning }) {
  return {
    effektokning: { score: effekt, reasoning: "MOCK DATA. Efficiency read based on this approach's own role/hours/timeWeeks estimate.", confidence: "medium" },
    kompetenshojning: { score: kompetens, reasoning: "MOCK DATA. Skill-growth read based on who (or what) is actually doing the work in this approach.", confidence: "medium" },
    nyttoInnovationshojning: { score: nytto, reasoning: "MOCK DATA. Innovation read based on what this approach's time/cost constraints actually allow trying.", confidence: "low" },
    riskreducering: { score: risk, reasoning: `MOCK DATA. ${riskReasoning}`, confidence: "medium" }
  };
}

function buildMockApproaches(caseText) {
  return {
    approaches: [
      {
        id: "ai-only",
        label: APPROACH_LABELS["ai-only"],
        narrative: `MOCK DATA. Example of how an AI-only build might approach this case (${caseText.length} chars submitted): AI coding agents draft the whole system, one lead does a final sign-off before release.`,
        roles: [
          { roleLabel: "Engineering lead (sign-off only, mock)", seniority: "lead", count: 1, hoursEstimate: 12 },
          { roleLabel: "AI build capacity (mock)", seniority: "ai", count: 1, hoursEstimate: 80 }
        ],
        timeWeeks: 2,
        requiredInputs: ["MOCK DATA. Clear, testable acceptance criteria", "MOCK DATA. Access to a staging environment"],
        riskNotes: "MOCK DATA. Without a dedicated human reviewer beyond final sign-off, subtle logic errors could ship unnoticed.",
        moduleSplit: [],
        categories: mockCategories({
          effekt: 5,
          kompetens: 2,
          nytto: 3,
          risk: 2,
          riskReasoning: "Resources check: only a final sign-off role, no dedicated reviewer for AI-generated logic, so risk coverage is thin."
        })
      },
      {
        id: "mixed",
        label: APPROACH_LABELS.mixed,
        narrative: "MOCK DATA. Example of a split approach: AI builds the well-patterned parts, a named specialist builds the critical/ambiguous parts, each AI-built module has a named reviewer.",
        roles: [
          { roleLabel: "Full-stack developer + AI pairing (mock)", seniority: "mid", count: 1, hoursEstimate: 90 },
          { roleLabel: "Specialist reviewer (mock)", seniority: "specialist", count: 1, hoursEstimate: 40 },
          { roleLabel: "AI build capacity (mock)", seniority: "ai", count: 1, hoursEstimate: 60 }
        ],
        timeWeeks: 4,
        requiredInputs: ["MOCK DATA. A module-by-module suitability read", "MOCK DATA. A named reviewer per AI-built module"],
        riskNotes: "MOCK DATA. Risk is scoped to whichever modules AI actually touches, assuming the split is honored in practice.",
        moduleSplit: [
          { module: "MOCK: input form", builder: "ai", reviewer: "Full-stack developer (mock)", rationale: "MOCK DATA. High pattern, low criticality." },
          { module: "MOCK: core business logic", builder: "human", reviewer: "Specialist reviewer (mock)", rationale: "MOCK DATA. Low pattern, high criticality." }
        ],
        categories: mockCategories({
          effekt: 4,
          kompetens: 4,
          nytto: 4,
          risk: 4,
          riskReasoning: "Resources check: named human reviewer on every AI-built module, and the critical module is human-built outright, so coverage matches criticality."
        })
      },
      {
        id: "dev-team",
        label: APPROACH_LABELS["dev-team"],
        narrative: "MOCK DATA. Example of a traditional, fully human-built approach: a small developer team builds and reviews every part manually, no AI coding assistance.",
        roles: [
          { roleLabel: "Senior developer (mock)", seniority: "senior", count: 1, hoursEstimate: 220 },
          { roleLabel: "Mid-level developer (mock)", seniority: "mid", count: 1, hoursEstimate: 180 }
        ],
        timeWeeks: 8,
        requiredInputs: ["MOCK DATA. Dedicated developer time blocked off", "MOCK DATA. Domain expert available for questions"],
        riskNotes: "MOCK DATA. Slower and more expensive, but lower risk of unverified AI-generated logic.",
        moduleSplit: [],
        categories: mockCategories({
          effekt: 2,
          kompetens: 3,
          nytto: 2,
          risk: 5,
          riskReasoning: "Resources check: every line is written and reviewed by a named senior/mid developer, highest resource coverage of the three."
        })
      }
    ]
  };
}

// Fake response so the full UI/flow can be tested without spending any
// hackathon API credits. Used automatically whenever no real key is set.
// Only covers what's genuinely case-level now (missingInfo/costEstimate/summary),
// the four value categories are scored per build-approach instead, see buildMockApproaches.
function buildMockResult(caseText) {
  return {
    missingInfo: [
      "This is mock output, no case was actually analyzed",
      `You submitted ${caseText.length} characters of case text`
    ],
    costEstimate: {
      tier: 3,
      label: "Medium",
      reasoning: "MOCK DATA. Placeholder cost estimate, replace by running with a real key."
    },
    summary: "MOCK MODE: no OpenRouter key is set, so this is fake data to test the UI. Set OPENROUTER_API_KEY in .env for a real assessment."
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasKey: hasRealKey(), mode: hasRealKey() ? "live" : "mock" });
});

app.post("/api/evaluate", async (req, res) => {
  const caseText = (req.body?.caseText || "").trim();
  if (!caseText) {
    return res.status(400).json({ error: "caseText is required" });
  }

  if (!hasRealKey()) {
    // No key set (or forced via .env) — return mock data instead of erroring,
    // so the UI/flow is fully testable before hackathon day.
    return res.json({ result: buildMockResult(caseText), mode: "mock" });
  }

  try {
    // Case-level pass only: missingInfo, overall costEstimate, summary. The four
    // value categories are no longer scored here, see /api/build-approaches —
    // they're scored once per build approach (ai-only/mixed/dev-team) instead,
    // since the score genuinely depends on which resources are doing the work.
    const parsed = await callModel({
      systemPrompt: buildSystemPrompt(),
      userMessage: caseText,
      temperature: 0.2
    });

    res.json({ result: parsed, mode: "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error calling the model", detail: String(err) });
  }
});

// Build-approach comparison: for the same case, what would it actually take to
// build it AI-only, dev-team-only, or mixed (split by module)? The model estimates
// roles/hours/weeks/required-inputs/risk per approach, cost in SEK is computed
// server-side from ROLE_RATES_SEK_PER_HOUR so it's consistent across runs.
app.post("/api/build-approaches", async (req, res) => {
  const caseText = (req.body?.caseText || "").trim();
  if (!caseText) {
    return res.status(400).json({ error: "caseText is required" });
  }

  if (!hasRealKey()) {
    const mock = buildMockApproaches(caseText);
    mock.approaches.forEach((a) => {
      Object.assign(a, computeApproachCost(a));
      a.priorityScore = computePriorityScore(a.categories, a.costTier);
    });
    return res.json({
      approaches: sortApproaches(mock.approaches),
      categories: CATEGORIES,
      rateCard: ROLE_RATES_SEK_PER_HOUR,
      mode: "mock"
    });
  }

  try {
    const parsed = await callModel({
      systemPrompt: buildApproachesPrompt(),
      userMessage: caseText,
      temperature: 0.3
    });

    const approaches = (parsed.approaches || []).map((a) => {
      const withCost = { ...a, label: APPROACH_LABELS[a.id] || a.id, ...computeApproachCost(a) };
      withCost.priorityScore = computePriorityScore(withCost.categories || {}, withCost.costTier);
      return withCost;
    });

    res.json({ approaches: sortApproaches(approaches), categories: CATEGORIES, rateCard: ROLE_RATES_SEK_PER_HOUR, mode: "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error calling the model", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Folksam AI Investment Analysis MVP running on http://localhost:${PORT}`);
});
