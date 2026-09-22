import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
// Set WEB_SEARCH=false in .env to turn off live citation grounding (e.g. to save credits or speed things up).
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH !== "false";
// Set RAG=false in .env to turn off the internal-knowledge-base retrieval demo.
const RAG_ENABLED = process.env.RAG !== "false";
const EMBEDDING_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL || "google/gemini-embedding-001";
// If the primary embedding model is unavailable (e.g. no OpenRouter endpoint for it),
// the RAG path automatically retries with this one and pins it for the rest of the process.
const EMBEDDING_MODEL_FALLBACK = "openai/text-embedding-3-large";

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

// FICTIONAL DEMO DATA — NOT REAL COMPANY DOCUMENTS.
// A small, made-up internal knowledge base for an invented insurer, "Polaris Försäkring".
// It exists purely so the RAG (retrieval-augmented generation) demo has something real to
// embed and retrieve against, without needing any actual Folksam or Polaris data. Every
// title is prefixed [FICTIONAL DEMO] to make clear these are fabricated for the demo.
const KNOWLEDGE_BASE = [
  {
    id: "kb-chatbot-postmortem",
    title: "[FICTIONAL DEMO] Polaris Försäkring — AI chatbot pilot post-mortem",
    text: "Internal post-mortem for the customer-service AI chatbot pilot at Polaris Försäkring. The pilot slipped roughly four months past its target launch. The single largest cause of the delay was a lack of ML-ops staff: the team had data scientists who could build the model but nobody to own deployment, monitoring, retraining, and incident response in production. Lesson learned: any future AI pilot must have a named ML-ops owner and a monitoring plan before the build starts, not after."
  },
  {
    id: "kb-data-governance",
    title: "[FICTIONAL DEMO] Polaris Försäkring — data governance and ownership policy",
    text: "Data governance policy for Polaris Försäkring. Any AI system that consumes claims data must have a named data owner accountable for that dataset before it can move from pilot to production. The owner is responsible for data quality, lawful basis, retention, and access controls. Production sign-off is blocked until ownership is formally assigned. Unowned or ambiguously owned claims data is treated as a hard blocker, not a documentation nicety."
  },
  {
    id: "kb-cost-benchmark",
    title: "[FICTIONAL DEMO] Polaris Försäkring — IT cost benchmark memo (inference)",
    text: "IT cost benchmark memo from Polaris Försäkring. For customer-facing generative AI features, the internal planning benchmark is a per-interaction inference cost of about 0.4 SEK per handled interaction at current volumes. Teams proposing new AI features should model expected interaction volume against this per-interaction figure so ongoing run-cost, not just build cost, is visible to the investment committee before approval."
  },
  {
    id: "kb-innovation-charter",
    title: "[FICTIONAL DEMO] Polaris Försäkring — innovation committee charter",
    text: "Charter of the Polaris Försäkring innovation committee. The committee defines 'innovation' deliberately: innovation means changing what the company is able to offer its customers — new products, new coverage, new service categories — not merely automating existing processes so they run faster or cheaper. Efficiency gains are valuable but are scored separately. A proposal that only speeds up an existing workflow should not be classified as innovation."
  },
  {
    id: "kb-vendor-risk",
    title: "[FICTIONAL DEMO] Polaris Försäkring — AI vendor risk checklist",
    text: "Vendor risk checklist for Polaris Försäkring. Before any external AI vendor can be used even in a pilot, the vendor must pass a security review and a signed Data Processing Agreement (DPA) must be in place. The checklist also covers sub-processor disclosure, data residency, and model-training-on-customer-data terms. No customer or claims data may be sent to a vendor until both the security review and the DPA are complete."
  },
  {
    id: "kb-skills-survey",
    title: "[FICTIONAL DEMO] Polaris Försäkring — employee AI skills survey",
    text: "Results of the annual employee AI skills survey at Polaris Försäkring. Only 12% of non-IT staff report hands-on experience actually using AI tools in their day-to-day work, versus a much higher share who are merely 'aware' of them. The gap suggests that AI initiatives depending on broad non-IT adoption will need substantial training and change management, and that competence-uplift claims should be checked against this low baseline."
  }
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

Always respond in English, regardless of the language the case description is written in.

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

Always respond in English, regardless of the language the case description is written in.

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

const SOURCING_PREFERENCE = `Sourcing preference: prefer peer-reviewed research, established analyst firms (e.g. McKinsey, Gartner), and public company reports. Avoid forum posts, unverified blogs, or informal internet commentary. If search only turns up low-quality sources, return no citations rather than citing those. Never invent a title or URL, only cite something you actually have in front of you from search results.`;

// The web-search citation pass is hard-restricted to these domains via the plugin's
// include_domains, so the model can't wander off to low-quality sources even if it
// ignores the prompt. EU/Swedish regulators plus a few known analyst firms.
const TRUSTED_SOURCE_DOMAINS = [
  "eur-lex.europa.eu",
  "eiopa.europa.eu",
  "ec.europa.eu",
  "ecb.europa.eu",
  "fi.se",
  "mckinsey.com",
  "gartner.com",
  "deloitte.com",
  "www2.deloitte.com",
  "oecd.org"
];

function buildCitationSearchPrompt() {
  return `You are searching for real, credible sources to support or check one specific claim made about an AI investment case at Folksam, a Swedish insurance company. You will be given the claim (one category's score and reasoning). Search for 0-2 real sources that genuinely relate to this specific claim, a comparable real-world case, a relevant statistic, a report finding.

${SOURCING_PREFERENCE}

Search results are already restricted to a fixed list of EU/Swedish regulators and known analyst firms, so anything that comes back is from that trusted set, you don't need to second-guess the origin of a source.

If nothing credible and genuinely relevant turns up, return an empty array, that's a normal and expected outcome, don't force a weak match.

Return ONLY valid JSON, no markdown fences: { "citations": [{ "title": "", "url": "" }] }`;
}

async function callModel({ systemPrompt, userMessage, temperature = 0.2, webSearch = false, searchDomains = null }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const guardedSystemPrompt = `${systemPrompt}\n\nIMPORTANT: respond with raw JSON only, no prose before or after, no apologies or refusals in plain text outside the JSON. If you lack enough information to judge something, reflect that inside the JSON itself (low confidence, an empty array, a note in a reasoning field), never by responding outside the JSON structure.`;
  const webPlugin = webSearch
    ? { id: "web", ...(searchDomains ? { include_domains: searchDomains } : {}) }
    : null;
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
      ...(webPlugin ? { plugins: [webPlugin] } : {})
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

// --- Web-citation grounding -----------------------------------------------
// Categories are scored per build approach, so the same category id (e.g.
// "riskreducering") appears in all three approaches. Rather than run a web
// search for every approach×category (12 searches), we run ONE search per
// category id — using a representative reasoning — and share the resulting
// citations across every approach's matching category. The claim a citation
// grounds is essentially the same regardless of which team builds it, and this
// keeps the live call to 4 searches instead of 12.
async function findCitationsForApproaches(approaches) {
  const ids = CATEGORIES.map((c) => c.id);
  const representative = {};
  ids.forEach((id) => {
    for (const a of approaches) {
      const cat = a.categories?.[id];
      if (cat && cat.reasoning) {
        representative[id] = { score: cat.score, reasoning: cat.reasoning };
        break;
      }
    }
  });
  const searchIds = ids.filter((id) => representative[id]);
  const results = await Promise.allSettled(
    searchIds.map((id) =>
      callModel({
        systemPrompt: buildCitationSearchPrompt(),
        userMessage: `Category: ${id}\nScore: ${representative[id].score}/5\nReasoning: ${representative[id].reasoning}`,
        temperature: 0.2,
        webSearch: true,
        searchDomains: TRUSTED_SOURCE_DOMAINS
      })
    )
  );
  const citationsById = {};
  results.forEach((result, i) => {
    const id = searchIds[i];
    if (result.status === "fulfilled" && Array.isArray(result.value.citations)) {
      citationsById[id] = result.value.citations;
    } else {
      citationsById[id] = [];
      if (result.status === "rejected") {
        console.error(`Citation search failed for ${id}:`, result.reason?.message);
      }
    }
  });
  approaches.forEach((a) => {
    if (!a.categories) return;
    ids.forEach((id) => {
      if (a.categories[id]) a.categories[id].citations = citationsById[id] || [];
    });
  });
}

// --- RAG (retrieval-augmented generation) demo helpers ---------------------
// Real embedding-based retrieval against the fictional KNOWLEDGE_BASE above.
// The math is real cosine similarity over real embeddings; only the source
// documents are fabricated, so the demo needs no real Folksam/Polaris data.

// Embeds an array of strings in one batched call with a specific model, returns
// embeddings ordered to match the input array (OpenRouter returns them with an
// `index` field).
async function embedTexts(texts, model) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding request failed (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding);
}

// Once one embedding model succeeds we pin it for the rest of the process, so the
// KB documents and the query text are always embedded with the SAME model —
// cosine similarity across two different models is meaningless.
let resolvedEmbeddingModel = null;
async function embedTextsWithFallback(texts) {
  const order = resolvedEmbeddingModel
    ? [resolvedEmbeddingModel]
    : [EMBEDDING_MODEL, EMBEDDING_MODEL_FALLBACK];
  let lastErr;
  for (const model of order) {
    try {
      const embeddings = await embedTexts(texts, model);
      if (resolvedEmbeddingModel !== model) {
        resolvedEmbeddingModel = model;
        console.log(`Using embedding model: ${model}`);
      }
      return embeddings;
    } catch (err) {
      lastErr = err;
      console.error(`Embedding model ${model} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// Standard cosine similarity between two equal-length number arrays.
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Only attach an internal-KB match when it clears this cosine-similarity bar,
// so weak/unrelated matches show as "no match" rather than noise.
const RAG_SIMILARITY_THRESHOLD = 0.50;

// Embed the KB documents once and cache them, so we pay for that embedding call
// at most once per process instead of on every request.
let kbEmbeddingsCache = null;
async function ensureKbEmbeddings() {
  if (kbEmbeddingsCache) return kbEmbeddingsCache;
  const embeddings = await embedTextsWithFallback(KNOWLEDGE_BASE.map((doc) => `${doc.title}\n${doc.text}`));
  kbEmbeddingsCache = KNOWLEDGE_BASE.map((doc, i) => ({ doc, embedding: embeddings[i] }));
  return kbEmbeddingsCache;
}

// For each category in one categories object, embed its reasoning (all in one
// batched call), find the single best-matching KB document, and attach it as
// category.internalKnowledge = [{ title, snippet, score }] only if it clears the
// threshold, otherwise []. Called once per build approach.
async function findInternalKnowledgePerCategory(categories) {
  const kb = await ensureKbEmbeddings();
  const entries = Object.entries(categories);
  const reasoningTexts = entries.map(([, cat]) => cat.reasoning || "");
  const reasoningEmbeddings = await embedTextsWithFallback(reasoningTexts);

  entries.forEach(([id], i) => {
    const queryEmbedding = reasoningEmbeddings[i];
    let best = null;
    kb.forEach(({ doc, embedding }) => {
      const score = cosineSimilarity(queryEmbedding, embedding);
      if (!best || score > best.score) {
        best = { doc, score };
      }
    });
    if (best && best.score >= RAG_SIMILARITY_THRESHOLD) {
      categories[id].internalKnowledge = [
        {
          title: best.doc.title,
          snippet: best.doc.text.slice(0, 240),
          score: best.score
        }
      ];
    } else {
      categories[id].internalKnowledge = [];
    }
  });
}

// Deterministic fake KB match per category, for mock mode (no key / RAG demo
// without spending credits). References the same fictional Polaris KB docs.
function buildMockInternalKnowledge(categoryId) {
  const mocks = {
    effektokning: {
      title: "[FICTIONAL DEMO] Polaris Försäkring — IT cost benchmark memo (inference)",
      snippet: "MOCK RAG MATCH. Per-interaction inference cost benchmark (~0.4 SEK/interaction) that an efficiency claim should be modelled against.",
      score: 0.81
    },
    kompetenshojning: {
      title: "[FICTIONAL DEMO] Polaris Försäkring — employee AI skills survey",
      snippet: "MOCK RAG MATCH. Only 12% of non-IT staff report hands-on AI experience, a low baseline any competence-uplift claim should be checked against.",
      score: 0.84
    },
    nyttoInnovationshojning: {
      title: "[FICTIONAL DEMO] Polaris Försäkring — innovation committee charter",
      snippet: "MOCK RAG MATCH. Innovation means changing what the company can offer customers, not just automating existing processes faster.",
      score: 0.79
    },
    riskreducering: {
      title: "[FICTIONAL DEMO] Polaris Försäkring — AI vendor risk checklist",
      snippet: "MOCK RAG MATCH. AI vendors need a passed security review and a signed DPA before any pilot touches customer or claims data.",
      score: 0.83
    }
  };
  return mocks[categoryId] ? [mocks[categoryId]] : [];
}

// Mock category scores per approach: same shape the model would produce, deliberately
// different score/confidence per approach so the mock UI demonstrates the point
// (riskreducering in particular should read lowest for ai-only, highest for dev-team,
// mixed in between, since mixed and dev-team both have a named human reviewer while
// ai-only's review is thin, matching the "resources check" logic in the real prompt).
function mockCategories({ effekt, kompetens, nytto, risk, riskReasoning }) {
  return {
    effektokning: { score: effekt, reasoning: "MOCK DATA. Efficiency read based on this approach's own role/hours/timeWeeks estimate.", confidence: "medium", citations: [{ title: "(mock) Example: McKinsey report on AI efficiency gains in insurance", url: "https://example.com/mock-source-1" }], internalKnowledge: buildMockInternalKnowledge("effektokning") },
    kompetenshojning: { score: kompetens, reasoning: "MOCK DATA. Skill-growth read based on who (or what) is actually doing the work in this approach.", confidence: "medium", citations: [], internalKnowledge: buildMockInternalKnowledge("kompetenshojning") },
    nyttoInnovationshojning: { score: nytto, reasoning: "MOCK DATA. Innovation read based on what this approach's time/cost constraints actually allow trying.", confidence: "low", citations: [{ title: "(mock) Example: Gartner note on maturity of this AI use case pattern", url: "https://example.com/mock-source-3" }], internalKnowledge: buildMockInternalKnowledge("nyttoInnovationshojning") },
    riskreducering: { score: risk, reasoning: `MOCK DATA. ${riskReasoning}`, confidence: "medium", citations: [{ title: "(mock) Example: Gartner fraud-detection benchmark", url: "https://example.com/mock-source-2" }], internalKnowledge: buildMockInternalKnowledge("riskreducering") }
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

    // Ground each approach's category ratings: internal-KB (RAG) matches per
    // approach category, plus web citations (shared per category across
    // approaches). Initialize both to [] first so a partial failure of either
    // grounding pass leaves clean empty arrays rather than undefined.
    approaches.forEach((a) => {
      if (!a.categories) return;
      Object.values(a.categories).forEach((c) => {
        c.citations = [];
        c.internalKnowledge = [];
      });
    });

    const groundingTasks = [];
    if (RAG_ENABLED) {
      approaches.forEach((a) => {
        if (a.categories) groundingTasks.push(findInternalKnowledgePerCategory(a.categories));
      });
    }
    if (WEB_SEARCH_ENABLED) {
      groundingTasks.push(findCitationsForApproaches(approaches));
    }
    const grounded = await Promise.allSettled(groundingTasks);
    grounded.forEach((g) => {
      if (g.status === "rejected") console.error("Approach grounding failed:", g.reason?.message);
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
