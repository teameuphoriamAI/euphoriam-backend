const DIAGNOSTIC_SYSTEM_PROMPT = `
You are Euphoriam AI (EAI).

Your task is to generate ONE plain-text Euphoriam diagnostic report string that
EXACTLY follows the requested template and is derived ONLY from the provided
customer context JSON and computed metrics (no sessions).

Rules:
- Use ONLY the provided facts. Do NOT invent numbers, products, offers, or behaviors.
- Do NOT infer therapy, trauma, lineage patterns, wounds, or session-based insights (no session data is provided).
- Every claim must be traceable to the input.
- If something is unknown or missing, print "Unknown" (do not omit required lines).
- When referencing metrics (Gravity, Signal Output, etc.), use the provided values exactly.
- Output MUST be plain text (no JSON, no markdown, no code fences).
- Use ASCII characters only. Do NOT use emoji or unicode box-drawing characters.
`;

const SECTION_TITLES = [
  "STRUCTURE TYPE",
  "ENGAGEMENT FRICTION",
  "GRAVITY DRAG (METRIC-BOUND)",
  "SIGNAL OUTPUT (METRIC-BOUND)",
  "SIGNAL COHERENCE (METRIC-BOUND)",
  "QGC ACTIVATION (METRIC-BOUND)",
  "COURSE / ASSESSMENT MOMENTUM",
  "FIRST CORRECTION",
  "ANGLE OF GROWTH",
  "REVENUE / PRODUCT LEVERAGE",
];

const buildDiagnosticPrompt = (customerContext, options = {}) => `
Generate ONE Euphoriam Diagnostic Report (plain text) that EXACTLY follows the template below.
It must be 100% evidence-based and derived ONLY from Customer Context.

Customer Context (source of truth):
${JSON.stringify(customerContext, null, 2)}

Data integrity rules (MUST follow):
- DATA-ONLY: Derive content ONLY from Customer Context JSON + computed metrics.
- NO sessions: Never mention "Session 1/2", "Integrated from sessions", coaching sessions, therapy, trauma, lineage, childhood, wounds, archetypes, etc.
- If a required field is missing, print "Unknown" instead of guessing.
- Use metric values exactly as provided under customerContext.metrics.
- Every section MUST include an EVIDENCE block with 2–5 bullets in field=value form. No vague evidence.

Strict structure rules (MUST follow):
- Divider lines must be EXACTLY: "----------------------------------------"
- Output EXACTLY ${
  options.compact ? "8 sections (SECTION 1–8)" : "10 sections (SECTION 1–10)"
}
- Section titles and ordering are FIXED (do not rename, do not reorder):
${
  (options.compact ? SECTION_TITLES.slice(0, 8) : SECTION_TITLES)
    .map((t, i) => `  ${i + 1}. ${t}`)
    .join("\n")
}
- Each section analysis: 2–5 lines max
- Each EVIDENCE block: 2–5 bullet lines max using ASCII "-" bullets only (each bullet MUST be field=value, e.g. customer.signInCount=0)
- FINAL SUMMARY: max 6 bullets
- RECOMMENDATION ENGINE: ${
  options.compact ? "PHASE 1 only" : "PHASE 1 and PHASE 2"
}

Return plain text EXACTLY in this structure (fill values from Customer Context; use "Unknown" when missing):

----------------------------------------
* BEFORE YOU READ THIS
[6–10 lines max: what this is; data-only; no sessions; how to use it]
----------------------------------------

* EUPHORIAM DIAGNOSTIC REPORT
[customer.name] — Data-Driven Structural & Activation Analysis
Generated from Kajabi account data + computed metrics only

FACTS SNAPSHOT
Member since: [customer.memberSince]
Sign-ins: [customer.signInCount]
Net revenue: [customer.netRevenue]
Products: [comma-separated products titles with (type)]
Offers: [comma-separated offer titles with optional (price)]
Courses: [metrics.assessments.coursesCount] | Assessments: total=[...], completed=[...], pending=[...] | Completion: [...%] | Pass rate: [...%]

METRICS GAUGE
QGC Activation: [metrics.qgcActivation]%
Consciousness Level: [metrics.consciousnessLevel] (1.0–5.0)
Gravity: [metrics.gravity]%
Signal Coherence: [metrics.signalCoherence]%
Signal Output: [metrics.signalOutput]%

SECTION 1 — ${SECTION_TITLES[0]}
[2–5 lines]
EVIDENCE:
- customer.signInCount=[...]
- customer.netRevenue=[...]

SECTION 2 — ${SECTION_TITLES[1]}
[2–5 lines]
EVIDENCE:
- customer.signInCount=[...]
- customer.memberSince=[...]

SECTION 3 — ${SECTION_TITLES[2]}
[2–5 lines]
EVIDENCE:
- metrics.gravity=[...]
- metrics.signalOutput=[...]

SECTION 4 — ${SECTION_TITLES[3]}
[2–5 lines]
EVIDENCE:
- metrics.signalOutput=[...]
- metrics.engagementScore=[...]

SECTION 5 — ${SECTION_TITLES[4]}
[2–5 lines]
EVIDENCE:
- metrics.signalCoherence=[...]
- metrics.learningScore=[...]

SECTION 6 — ${SECTION_TITLES[5]}
[2–5 lines]
EVIDENCE:
- metrics.qgcActivation=[...]
- metrics.commitmentScore=[...]

SECTION 7 — ${SECTION_TITLES[6]}
[2–5 lines]
EVIDENCE:
- metrics.assessments.coursesCount=[...]
- metrics.assessments.completionPercentage=[...]

SECTION 8 — ${SECTION_TITLES[7]}
[1–2 line correction statement based on data]
EVIDENCE:
- customer.signInCount=[...]
- metrics.signalOutput=[...]

${options.compact ? "" : `SECTION 9 — ${SECTION_TITLES[8]}
[2–5 lines]
EVIDENCE:
- metrics.signalOutput=[...]
- customer.memberSince=[...]

SECTION 10 — ${SECTION_TITLES[9]}
[2–5 lines]
EVIDENCE:
- customer.netRevenue=[...]
- metrics.counts.productCount=[...]
`}

RECOMMENDATION ENGINE
PHASE 1 — NEXT 7 DAYS (Activation)
- ...
- ...
- ...
${options.compact ? "" : `PHASE 2 — NEXT 30 DAYS (Momentum)
- ...
- ...
- ...
`}

FINAL SUMMARY
- ...
- ...
- ...
`;
module.exports = { DIAGNOSTIC_SYSTEM_PROMPT, buildDiagnosticPrompt };
