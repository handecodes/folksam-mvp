import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
// Set WEB_SEARCH=false in .env to turn off live grounding (e.g. to save credits or speed things up).
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH !== "false";

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

function buildSystemPrompt() {
  return `You are an assistant that helps an investment committee at Folksam (a Swedish insurance company) reason through AI investment cases. You do NOT decide whether a case is good or bad. You produce a structured, honest, questionable draft assessment that a human committee will discuss, challenge, and refine.

Score the submitted AI investment case on exactly these four categories:
${CATEGORIES.map((c) => `- ${c.id} (${c.swedish} / ${c.english})`).join("\n")}

For each category, return:
- score: an integer from 1 (very weak) to 5 (very strong)
- reasoning: 2-4 sentences explaining specifically WHY this case gets that score, grounded in details from the case description. Do not restate generic AI benefits, tie the reasoning to what the case actually says (or doesn't say).
- confidence: "low", "medium", or "high" — how confident you are in this score given the information provided. Use "low" when the case description doesn't give you enough to judge that category well.

Leave citations as an empty array for every category, that's filled in separately afterward by a dedicated search pass per category, don't try to do it here.

Then return:
- missingInfo: a short list of concrete pieces of information that, if missing from the case description, would materially change your assessment (e.g. "no mention of who owns the data", "no rollout cost estimate"). Empty array if the case is well specified.
- costEstimate: your best estimate of the case's cost burden, as { "tier": 1-5, "label": "", "reasoning": "" }. tier 1 means low cost/effort, tier 5 means high cost/effort (development, infrastructure, ongoing operation combined). Base this on whatever cost/resource information the case gives you, and say explicitly in the reasoning if you're estimating with limited information.
- summary: 2-3 sentences summarizing the case as a discussion starter for a committee meeting, not a verdict. Explicitly note this is a plausible assessment, not a validated truth.

Do NOT compute an overall or priority score yourself, that is calculated separately from your category scores and cost estimate.

Respond in the same language the case description is written in (Swedish or English).

Return ONLY valid JSON matching this shape, no markdown fences, no extra text:
{
  "categories": {
    "effektokning": { "score": 1, "reasoning": "", "confidence": "low", "citations": [] },
    "kompetenshojning": { "score": 1, "reasoning": "", "confidence": "low", "citations": [] },
    "nyttoInnovationshojning": { "score": 1, "reasoning": "", "confidence": "low", "citations": [] },
    "riskreducering": { "score": 1, "reasoning": "", "confidence": "low", "citations": [] }
  },
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

function buildChallengeQuestionPrompt() {
  return `You are playing a specific role: a skeptical, experienced member of an investment committee at Folksam, reviewing an AI investment case. You've been given one category's score and reasoning. Your job is to write ONE sharp, specific, respectful challenge question that pokes at the weakest or least-supported part of that reasoning. Not generic skepticism, something a real person familiar with this exact case would ask.

Return ONLY valid JSON, no markdown fences: { "question": "" }`;
}

function buildChallengeResponsePrompt() {
  return `You are the same skeptical committee member. The user has replied to your challenge question defending their case. Decide honestly: does their reply add genuine new concrete information (numbers, specifics, plans, evidence) that should change the category's score, or is it just restated confidence, reassurance, or vague optimism with no new substance?

Rules:
- Only change the score if the reply gives you something concrete you didn't have before.
- If the reply is just confident-sounding reassurance with no new facts, do NOT change the score, and say so plainly, do not be swayed by tone or persuasiveness alone.
- Be honest and specific either way.

Return ONLY valid JSON, no markdown fences:
{
  "scoreChanged": false,
  "newScore": 1,
  "reasoning": "",
  "verdictNote": ""
}`;
}

const SOURCING_PREFERENCE = `Sourcing preference: prefer peer-reviewed research, established analyst firms (e.g. McKinsey, Gartner), and public company reports. Avoid forum posts, unverified blogs, or informal internet commentary. If search only turns up low-quality sources, return no citations rather than citing those. Never invent a title or URL, only cite something you actually have in front of you from search results.`;

function buildCitationSearchPrompt() {
  return `You are searching for real, credible sources to support or check one specific claim made about an AI investment case at Folksam, a Swedish insurance company. You will be given the claim (one category's score and reasoning). Search for 0-2 real sources that genuinely relate to this specific claim, a comparable real-world case, a relevant statistic, a report finding.

${SOURCING_PREFERENCE}

If nothing credible and genuinely relevant turns up, return an empty array, that's a normal and expected outcome, don't force a weak match.

Return ONLY valid JSON, no markdown fences: { "citations": [{ "title": "", "url": "" }] }`;
}

function buildGapFillPrompt() {
  return `You are reassessing an AI investment case for a Folksam investment committee, after new information has been added to fill a gap that was previously flagged as missing.

You'll be told whether the new information is:
(a) a real answer the user supplied, treat it as fact, or
(b) a request to invent a plausible assumption yourself, in which case first write ONE realistic, clearly speculative assumption for the missing detail, consistent with the rest of the case, something a reasonable person might guess, not a wild guess.

Then reassess the four categories (effektokning, kompetenshojning, nyttoInnovationshojning, riskreducering) given this new information. Only include a category in your response if its score or reasoning would meaningfully change, leave out categories that stay essentially the same, to keep the response focused on what actually matters.

Return ONLY valid JSON, no markdown fences:
{
  "assumption": "" or null if the user supplied a real answer,
  "changedCategories": {
    "categoryId": { "score": 1, "reasoning": "" }
  }
}`;
}

async function callModel({ systemPrompt, userMessage, temperature = 0.2, webSearch = false }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
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
  return JSON.parse(cleaned);
}

// Runs one dedicated, web-search-grounded call per category to find real citations,
// instead of relying on a single shared search pass for all four at once. A shared
// pass tends to surface at most one or two sources total; doing it per category
// gives each claim its own real chance at a real source.
async function findCitationsPerCategory(categories) {
  const entries = Object.entries(categories);
  const results = await Promise.allSettled(
    entries.map(([id, cat]) =>
      callModel({
        systemPrompt: buildCitationSearchPrompt(),
        userMessage: `Category: ${id}\nScore: ${cat.score}/5\nReasoning: ${cat.reasoning}`,
        temperature: 0.2,
        webSearch: true
      })
    )
  );
  results.forEach((result, i) => {
    const [id] = entries[i];
    if (result.status === "fulfilled" && Array.isArray(result.value.citations)) {
      categories[id].citations = result.value.citations;
    } else {
      categories[id].citations = [];
      if (result.status === "rejected") {
        console.error(`Citation search failed for ${id}:`, result.reason?.message);
      }
    }
  });
}

function hasRealKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return Boolean(apiKey) && apiKey !== "your_key_here";
}

// Fake response so the full UI/flow can be tested without spending any
// hackathon API credits. Used automatically whenever no real key is set.
function buildMockResult(caseText) {
  return {
    categories: {
      effektokning: {
        score: 3,
        reasoning: "MOCK DATA. This is a placeholder response, no model was called. Add a real OPENROUTER_API_KEY to .env to get real scoring.",
        confidence: "low",
        citations: [
          { title: "(mock) Example: McKinsey report on AI efficiency gains in insurance", url: "https://example.com/mock-source-1" },
          { title: "(mock) Example: industry survey on AI customer service deflection rates", url: "https://example.com/mock-source-1b" }
        ]
      },
      kompetenshojning: {
        score: 4,
        reasoning: "MOCK DATA. Placeholder reasoning for the skill/competence category, replace by running with a real key. This one legitimately has no citation in this mock, showing what an honest empty result looks like.",
        confidence: "medium",
        citations: []
      },
      nyttoInnovationshojning: {
        score: 2,
        reasoning: "MOCK DATA. Placeholder reasoning for the benefit/innovation category.",
        confidence: "low",
        citations: [
          { title: "(mock) Example: Gartner note on maturity of this AI use case pattern", url: "https://example.com/mock-source-3" }
        ]
      },
      riskreducering: {
        score: 3,
        reasoning: "MOCK DATA. Placeholder reasoning for the risk reduction category.",
        confidence: "medium",
        citations: [
          { title: "(mock) Example: Gartner fraud-detection benchmark", url: "https://example.com/mock-source-2" }
        ]
      }
    },
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

function buildMockChallengeQuestion() {
  return {
    question: "MOCK DATA. Example challenge: you're claiming a skill increase here, but who on the team actually has this expertise today, and what happens if they leave halfway through?"
  };
}

function buildMockChallengeResponse(defenseText) {
  const addedSomething = defenseText.length > 60;
  return addedSomething
    ? {
        scoreChanged: true,
        newScore: 4,
        reasoning: "MOCK DATA. Your reply looked detailed enough to count as new information in this fake evaluation, a real model would judge this for real.",
        verdictNote: "Score adjusted (mock)."
      }
    : {
        scoreChanged: false,
        newScore: 3,
        reasoning: "MOCK DATA. Your reply was short, so this mock logic treated it as not adding new concrete information.",
        verdictNote: "Score unchanged (mock)."
      };
}

function buildMockGapFill(missingItem, mode) {
  return {
    assumption:
      mode === "assume"
        ? `MOCK DATA. Example assumption for "${missingItem}": assuming a moderate, realistic answer consistent with the rest of the case.`
        : null,
    changedCategories: {
      effektokning: {
        score: 4,
        reasoning: `MOCK DATA. Example of how filling in "${missingItem}" might shift this category's score and reasoning, a real model would judge this for real.`
      }
    }
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
    const mockResult = buildMockResult(caseText);
    mockResult.priorityScore = computePriorityScore(mockResult.categories, mockResult.costEstimate.tier);
    return res.json({ result: mockResult, categories: CATEGORIES, postures: POSTURES, mode: "mock" });
  }

  try {
    // Main call: scores, reasoning, confidence, missing info, cost. No web search here,
    // citations are found separately below, one dedicated search per category.
    const parsed = await callModel({
      systemPrompt: buildSystemPrompt(),
      userMessage: caseText,
      temperature: 0.2
    });

    Object.values(parsed.categories).forEach((cat) => {
      cat.citations = [];
    });

    if (WEB_SEARCH_ENABLED) {
      await findCitationsPerCategory(parsed.categories);
    }

    parsed.priorityScore = computePriorityScore(parsed.categories, parsed.costEstimate?.tier ?? 3);

    res.json({ result: parsed, categories: CATEGORIES, postures: POSTURES, mode: "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error calling the model", detail: String(err) });
  }
});

// Gap-fill: show what the assessment would look like if a flagged missing piece
// of information were answered, either with the user's real answer or the model's
// own best-guess assumption (clearly labeled as speculative either way).
app.post("/api/fill-gap", async (req, res) => {
  const { caseText, missingItem, mode, answerText } = req.body || {};
  if (!caseText || !missingItem || !mode) {
    return res.status(400).json({ error: "caseText, missingItem and mode are required" });
  }
  if (mode === "user" && !answerText) {
    return res.status(400).json({ error: "answerText is required when mode is 'user'" });
  }

  if (!hasRealKey()) {
    return res.json({ ...buildMockGapFill(missingItem, mode), mode: "mock" });
  }

  const userMessage =
    mode === "user"
      ? `Case description:\n${caseText}\n\nMissing item that was flagged: ${missingItem}\nThe user supplied this real answer: ${answerText}`
      : `Case description:\n${caseText}\n\nMissing item that was flagged: ${missingItem}\nInvent a plausible assumption for this yourself, then reassess.`;

  try {
    const parsed = await callModel({
      systemPrompt: buildGapFillPrompt(),
      userMessage,
      temperature: mode === "assume" ? 0.4 : 0.2
    });
    res.json({ ...parsed, mode: "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error calling the model", detail: String(err) });
  }
});

// Step 1 of the debate flow: ask for a skeptical challenge question on one category.
app.post("/api/challenge", async (req, res) => {
  const { caseText, categoryId, categoryScore, categoryReasoning } = req.body || {};
  if (!caseText || !categoryId) {
    return res.status(400).json({ error: "caseText and categoryId are required" });
  }

  if (!hasRealKey()) {
    return res.json({ ...buildMockChallengeQuestion(), mode: "mock" });
  }

  const userMessage = `Case description:\n${caseText}\n\nCategory being challenged: ${categoryId}\nCurrent score: ${categoryScore}/5\nCurrent reasoning: ${categoryReasoning}`;

  try {
    const parsed = await callModel({ systemPrompt: buildChallengeQuestionPrompt(), userMessage, temperature: 0.4 });
    res.json({ ...parsed, mode: "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error calling the model", detail: String(err) });
  }
});

// Step 2 of the debate flow: evaluate the user's defense against the challenge.
app.post("/api/challenge/respond", async (req, res) => {
  const { caseText, categoryId, categoryScore, categoryReasoning, question, defense } = req.body || {};
  if (!caseText || !categoryId || !defense) {
    return res.status(400).json({ error: "caseText, categoryId and defense are required" });
  }

  if (!hasRealKey()) {
    return res.json({ ...buildMockChallengeResponse(defense), mode: "mock" });
  }

  const userMessage = `Case description:\n${caseText}\n\nCategory: ${categoryId}\nOriginal score: ${categoryScore}/5\nOriginal reasoning: ${categoryReasoning}\nYour challenge question: ${question}\nUser's defense: ${defense}`;

  try {
    const parsed = await callModel({ systemPrompt: buildChallengeResponsePrompt(), userMessage, temperature: 0.2 });
    res.json({ ...parsed, mode: "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error calling the model", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Folksam AI Investment Analysis MVP running on http://localhost:${PORT}`);
});
