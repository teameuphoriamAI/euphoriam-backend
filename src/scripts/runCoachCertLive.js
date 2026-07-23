#!/usr/bin/env node
/**
 * Live cert acceptance scorecard — flow guards (always) + optional LLM live checks.
 *
 * Usage:
 *   node src/scripts/runCoachCertLive.js
 *   OPENAI_API_KEY=... node src/scripts/runCoachCertLive.js --live
 *
 * Requires Docker stack for --live (backend :4000, ai-worker :8000).
 */

const {
  resolveSessionIntakeFlow,
  buildIntentionOpening,
  SESSION_PHASES,
} = require("../stage1/coach/flows/sessionIntake");
const { applyCertTurnDirectives } = require("../stage1/coach/flows/transition");
const {
  buildBrainPromptDocuments,
  extractSignatureIds,
} = require("../helpers/brainPromptChunking");
const { getResumableCoachMessages } = require("../stage1/coach/persistence/history");

const JARGON = /\b(vortex|signature|quantum|meta-model|EO\+|QGC)\b/i;
const liveMode = process.argv.includes("--live");

const scorecard = [];

const pass = (name, detail = "") => {
  scorecard.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
};

const fail = (name, detail = "") => {
  scorecard.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};

const runFlowGuards = () => {
  const opening = buildIntentionOpening({
    firstName: "Teresa",
    goalPhrase: "reduce pressure at work",
  });
  if (/what do you want from this session/i.test(opening) && !JARGON.test(opening)) {
    pass("opening intention question", "no jargon");
  } else {
    fail("opening intention question");
  }

  const pressureFlow = resolveSessionIntakeFlow({
    openSession: {
      session_intake: {
        session_intention: "Feel less stuck",
        emotional_checkin_complete: true,
        felt_sensation: "Tight chest and solar plexus",
      },
    },
    userMessage: "My head feels like it's in a vice. Work pressure is crushing me.",
    reqBody: {},
    messages: [],
    gravityRating: 7,
  });
  if (pressureFlow.session_phase === SESSION_PHASES.RESISTANCE_PROBE) {
    pass("scenario 1 routes to resistance_probe");
  } else {
    fail("scenario 1 routes to resistance_probe", pressureFlow.session_phase);
  }
  if (pressureFlow.body_echo_required) {
    pass("scenario 1 body_echo_required");
  } else {
    fail("scenario 1 body_echo_required");
  }

  const yesMan = resolveSessionIntakeFlow({
    openSession: {
      session_intake: {
        session_intention: "Help saying no",
        emotional_checkin_complete: true,
      },
    },
    userMessage: "I'm such a yes-man with my mother",
    reqBody: {},
    messages: [],
    gravityRating: 5,
  });
  if (yesMan.yes_man_pattern) pass("scenario 2 yes_man_pattern");
  else fail("scenario 2 yes_man_pattern");

  const recentStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const skipFlow = resolveSessionIntakeFlow({
    openSession: {
      started_at: recentStart,
      session_intake: {
        session_intention: "Finish proposal",
        emotional_checkin_complete: true,
      },
    },
    userMessage: "Continue",
    reqBody: { session_intention: "Finish proposal", force_new_session: true },
    messages: [],
    gravityRating: 4,
  });
  if (skipFlow.session_phase !== SESSION_PHASES.EXPLORE || !skipFlow.awaiting_session_intention) {
    pass("force_new_session bypasses same-day skipReIntention");
  } else {
    fail("force_new_session bypasses same-day skipReIntention");
  }

  const ended = getResumableCoachMessages(
    {
      coach_session_log: [
        {
          id: "ended",
          domain: "income",
          ended_at: new Date().toISOString(),
          messages: [{ role: "user", content: "old boat proof" }],
        },
      ],
    },
    "income",
  );
  if (ended.length === 0) pass("ended session not resumable");
  else fail("ended session not resumable");

  const insightFlow = resolveSessionIntakeFlow({
    openSession: {
      session_intake: {
        session_intention: "Move forward",
        emotional_checkin_complete: true,
        resistance_probe_active: true,
      },
    },
    userMessage: "I see it now — saying yes keeps me safe from conflict with my mother",
    reqBody: {},
    messages: [
      { role: "user", content: "Move forward" },
      { role: "assistant", content: "What feels heaviest?" },
      { role: "user", content: "Pressure in my chest" },
    ],
    gravityRating: 6,
  });
  if (insightFlow.session_phase === SESSION_PHASES.INSIGHT_INTEGRATION) {
    pass("insight_integration phase");
  } else {
    fail("insight_integration phase", insightFlow.session_phase);
  }

  const transition = applyCertTurnDirectives({
    transition: {
      coaching_phase: "explore",
      coaching_mode: "coaching",
      discovery_complete: true,
      stop_discovery: false,
      coaching_brief: {
        instruction: "Coach normally.",
        assign_green_rep: false,
        conversation_signals: {},
      },
      conversation_signals: {},
    },
    sessionIntakeFlow: insightFlow,
    proofCycleFlow: null,
    coachMemoryContext: {
      suggested_training: {
        primary_masterclass: { title: "Visibility Masterclass", why_chosen: "Matches masking pattern" },
      },
    },
    map: { map_resistance_complete: true, failure_strategy: { rule: "Hypervigilant masking" } },
    userMessage: insightFlow.session_intention,
    messages: [],
  });
  if (transition.coaching_brief?.assign_green_rep) pass("insight_integration assigns green rep");
  else fail("insight_integration assigns green rep");
  if (transition.conversation_signals?.map_reference_required) pass("map_reference_required on explore");
  else fail("map_reference_required on explore");

  const brainSnippet = [
    "NE+S+R: hypervigilant to judgement when visibility rises.",
    "NC+C+F: collapses after effort feels insufficient.",
    "PL+S+P: performs until exhaustion then shuts down.",
  ].join("\n");
  const docs = buildBrainPromptDocuments({
    content: brainSnippet,
    promptType: "Brain Prompt",
  });
  const sigChunks = docs.filter((d) => d.metadata.signature_id).length;
  if (sigChunks > 0) pass("brain chunking tags signatures", `${sigChunks} chunks`);
  else fail("brain chunking tags signatures");
  if (extractSignatureIds(brainSnippet).length >= 2) pass("extractSignatureIds multi-signature");
  else fail("extractSignatureIds multi-signature");
};

const runLiveLlmChecks = async () => {
  const base = process.env.AI_SERVICE_URL || "http://localhost:8000";
  const payload = {
    domain_map: {
      domain: "income",
      goal_title: "Increase income",
      map_resistance_complete: true,
      failure_strategy: { rule: "Hypervigilant masking under visibility pressure" },
      success_strategy: { behaviour: "Visible aligned outreach" },
      flip_belief: "My voice matters and safe visibility grows income",
      protector_rule: "Stay invisible to avoid judgement",
      signature_id: "NE+S+R",
    },
    active_goal_context: {
      goal_name: "Increase income",
      current_milestone: "Send 5 outreach messages",
    },
    user_coach_context: {
      COACH_MEMORY_CONTEXT: {
        failure_strategy: "Hypervigilant masking under visibility pressure",
        flip_belief: "My voice matters",
        milestone: "Send 5 outreach messages",
        diagnostic_report_excerpt: "Masking and hypervigilance block outbound action.",
      },
    },
    checkin: {
      current_state: "clear",
      gravity_rating: 6,
      message: "I keep procrastinating on my funnel video. I know I should record it.",
      session_phase: "explore",
      session_intention: "Record my funnel video today",
      map_reference_required: true,
      edge_inquiry_required: true,
      assign_green_rep: false,
      coaching_mode: "coaching",
      stop_discovery: true,
    },
    messages: [
      { role: "assistant", content: "What do you want from this session?" },
      { role: "user", content: "Record my funnel video today" },
    ],
    user_message: "I keep procrastinating on my funnel video. I know I should record it.",
    prompts: {},
  };

  try {
    const res = await fetch(`${base}/v1/coach/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      fail("live LLM /v1/coach/reply", `HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const text = String(data.assistant_message || "");
    if (text.length > 20) pass("live LLM returned assistant_message");
    else fail("live LLM returned assistant_message");
    if (!JARGON.test(text)) pass("live LLM no jargon");
    else fail("live LLM no jargon", text.slice(0, 120));
    if (/\?/.test(text)) pass("live LLM includes a question");
    else fail("live LLM includes a question");
  } catch (err) {
    fail("live LLM /v1/coach/reply", err.message);
  }
};

(async () => {
  console.log("Coach cert live acceptance\n");
  runFlowGuards();
  if (liveMode) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("Skipping live LLM checks — OPENAI_API_KEY not set");
    } else {
      await runLiveLlmChecks();
    }
  } else {
    console.log("\nFlow guards only. Run with --live (+ OPENAI_API_KEY) for LLM checks.");
  }

  const failed = scorecard.filter((s) => !s.ok);
  console.log(`\n${scorecard.length - failed.length}/${scorecard.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
