/**
 * Bottleneck progression — Proof → Bottleneck Removed → New Bottleneck → Next Action
 */

const { formatOutcomeDirective } = require("./directive");

const PROGRESSION_STAGES = Object.freeze({
  NO_PROSPECT: "no_prospect",
  PROSPECT_IDENTIFIED: "prospect_identified",
  NO_CONTACT: "no_contact",
  CONTACT_INITIATED: "contact_initiated",
  CONVERSATION_STARTED: "conversation_started",
  PROPOSAL_SENT: "proposal_sent",
  CLIENT_CLOSED: "client_closed",
});

const PROOF_TYPES = Object.freeze({
  PROSPECT_IDENTIFIED: "prospect_identified",
  PROSPECT_LIST_BUILT: "prospect_list_built",
  OUTREACH_SENT: "outreach_sent",
  CONVERSATION_STARTED: "conversation_started",
  PROPOSAL_SENT: "proposal_sent",
  PAYMENT_RECEIVED: "payment_received",
});

const detectProofMilestone = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 4) return null;

  if (
    /\b(identif|found|named|picked|chose|have)\w*\s+(?:\d+\s+)?(?:client|prospect|business|lead|customer)s?\b/i.test(
      t,
    ) ||
    /\b(?:client|prospect|business|lead)\s+(?:identif|found|named)\b/i.test(t)
  ) {
    const count = t.match(/\b(\d+)\s+(?:client|prospect|business)/i)?.[1];
    return {
      proof_type: PROOF_TYPES.PROSPECT_IDENTIFIED,
      stage: PROGRESSION_STAGES.PROSPECT_IDENTIFIED,
      detail: count ? `${count} prospect(s)` : "prospect identified",
    };
  }

  if (
    /\b(listed|identified|found)\s+(?:\d+\s+)?(?:business|prospect|client|lead)/i.test(t) ||
    /\b(\d+)\s+(?:business|prospect|client|lead)s?\s+(?:listed|identified|found)\b/i.test(t)
  ) {
    const count = t.match(/\b(\d+)\s+(?:business|prospect|client)/i)?.[1];
    return {
      proof_type: PROOF_TYPES.PROSPECT_LIST_BUILT,
      stage: PROGRESSION_STAGES.PROSPECT_IDENTIFIED,
      detail: count ? `${count} prospects listed` : "prospect list built",
    };
  }

  if (/\b(reach(?:ed|ing)?|reached\s+out|sent|messaged|dm|emailed|contacted)\b/i.test(t) &&
    !/\bdidn'?t\b/i.test(t)
  ) {
    return {
      proof_type: PROOF_TYPES.OUTREACH_SENT,
      stage: PROGRESSION_STAGES.CONTACT_INITIATED,
      detail: "outreach sent",
      source_text: t,
    };
  }

  if (/\b(replied|response|conversation|call|booked|meeting|they\s+said)\b/i.test(t)) {
    return {
      proof_type: PROOF_TYPES.CONVERSATION_STARTED,
      stage: PROGRESSION_STAGES.CONVERSATION_STARTED,
      detail: "conversation started",
    };
  }

  if (/\b(proposal|quote|priced|sent\s+(?:a\s+)?offer)\b/i.test(t)) {
    return {
      proof_type: PROOF_TYPES.PROPOSAL_SENT,
      stage: PROGRESSION_STAGES.PROPOSAL_SENT,
      detail: "proposal sent",
    };
  }

  if (/\b(paid|payment|invoice|closed|signed|first\s+client)\b/i.test(t) && /\b(got|received|landed)\b/i.test(t)) {
    return {
      proof_type: PROOF_TYPES.PAYMENT_RECEIVED,
      stage: PROGRESSION_STAGES.CLIENT_CLOSED,
      detail: "payment or client closed",
    };
  }

  return null;
};

const progressionFromProof = (proofMilestone, { goalContext = null, map = null } = {}) => {
  const milestone =
    goalContext?.current_milestone || goalContext?.milestones?.day_7 || map?.milestones?.day_7;
  const goal = goalContext?.goal_name || map?.goal_title || "your goal";

  switch (proofMilestone?.proof_type) {
    case PROOF_TYPES.PROSPECT_IDENTIFIED:
    case PROOF_TYPES.PROSPECT_LIST_BUILT:
      return {
        removed_bottleneck: "No prospect identified",
        progression_stage: PROGRESSION_STAGES.PROSPECT_IDENTIFIED,
        current_bottleneck: {
          stage: PROGRESSION_STAGES.NO_CONTACT,
          type: "outreach_gap",
          label: "No contact initiated",
        },
        next_green_rep: {
          name: "Send First Outreach Message",
          steps: [
            "Open the channel where your identified prospect is reachable (DM, email, LinkedIn).",
            "Send one message: who you are, what you offer, and one clear ask (call, reply, or rate check).",
            "Sent counts — reply doesn't.",
          ],
          win_condition: "One outreach message sent to your identified prospect",
        },
        next_visible_action: "Send message #1 to your identified prospect",
        milestone_context: milestone || goal,
      };

    case PROOF_TYPES.OUTREACH_SENT: {
      const outcomePending = /\b(no\s+(?:reply|response)|no\s+one\s+repl(?:ied|y)?|didn'?t\s+repl|waiting)\b/i.test(
        String(proofMilestone?.source_text || ""),
      );
      if (outcomePending) {
        return {
          removed_bottleneck: "Staying financially invisible",
          progression_stage: PROGRESSION_STAGES.CONTACT_INITIATED,
          current_bottleneck: {
            stage: PROGRESSION_STAGES.CONTACT_INITIATED,
            type: "follow_up_gap",
            label: "Follow-up or response-wait — outreach done, outcome unknown",
          },
          next_green_rep: {
            name: "One Follow-Up Without Changing Offer",
            steps: [
              "Pick the prospect you already contacted.",
              "Send one follow-up: check they saw your message OR ask one specific question.",
              "Do not lower your rate or rewrite the offer because fear appeared.",
            ],
            win_condition: "One follow-up sent unchanged — not a new outreach to a new list",
          },
          next_visible_action: "Send one follow-up to the prospect already contacted",
          milestone_context: milestone || goal,
        };
      }
      return {
        removed_bottleneck: "No contact initiated",
        progression_stage: PROGRESSION_STAGES.CONTACT_INITIATED,
        current_bottleneck: {
          stage: PROGRESSION_STAGES.CONVERSATION_STARTED,
          type: "conversation_gap",
          label: "No conversation started",
        },
        next_green_rep: {
          name: "Start Client Conversation",
          steps: [
            "Check for a reply — if none in 24h, send one follow-up with a specific question.",
            "If they replied, answer with one clear next step (15-min call or scope question).",
            "Log what they said and what you offered.",
          ],
          win_condition: "One back-and-forth exchange or booked call with the prospect",
        },
        next_visible_action: "Send follow-up or reply to move the conversation forward",
        milestone_context: milestone || goal,
      };
    }

    case PROOF_TYPES.CONVERSATION_STARTED:
      return {
        removed_bottleneck: "No conversation started",
        progression_stage: PROGRESSION_STAGES.CONVERSATION_STARTED,
        current_bottleneck: {
          stage: PROGRESSION_STAGES.PROPOSAL_SENT,
          type: "offer_gap",
          label: "No offer or rate named",
        },
        next_green_rep: {
          name: "Send One Clear Offer",
          steps: [
            "Name your service scope in 2–3 sentences.",
            "State your rate or project price in the message.",
            "Send it — don't wait for perfect wording.",
          ],
          win_condition: "One offer or rate sent in writing to the prospect",
        },
        next_visible_action: "Send your offer or rate in writing",
        milestone_context: milestone || goal,
      };

    case PROOF_TYPES.PROPOSAL_SENT:
      return {
        removed_bottleneck: "No offer named",
        progression_stage: PROGRESSION_STAGES.PROPOSAL_SENT,
        current_bottleneck: {
          stage: PROGRESSION_STAGES.CLIENT_CLOSED,
          type: "close_gap",
          label: "No payment or commitment",
        },
        next_green_rep: {
          name: "One Follow-Up Close Ask",
          steps: [
            "Send one follow-up: 'Ready to start?' or 'Any questions on the offer?'",
            "Include how to pay or book.",
            "One message — then wait.",
          ],
          win_condition: "One follow-up sent asking for decision or payment",
        },
        next_visible_action: "Send one follow-up asking for a yes or payment link",
        milestone_context: milestone || goal,
      };

    case PROOF_TYPES.PAYMENT_RECEIVED:
      return {
        removed_bottleneck: "No paying client",
        progression_stage: PROGRESSION_STAGES.CLIENT_CLOSED,
        current_bottleneck: {
          stage: "milestone_complete",
          type: "scale_gap",
          label: "Repeat and scale what worked",
        },
        next_green_rep: {
          name: "Document What Closed the Deal",
          steps: [
            "Write 3 bullets: what you did, what they said yes to, what you'd repeat.",
            "Identify one similar prospect to contact tomorrow.",
            "Send one outreach to prospect #2 using the same path.",
          ],
          win_condition: "Deal post-mortem written + one new outreach sent",
        },
        next_visible_action: "Contact one similar prospect using the same path",
        milestone_context: milestone || goal,
      };

    default:
      return null;
  }
};

const buildProgressionContext = ({ progression, proofMilestone, userMessage }) => ({
  proof_progression: true,
  proof_snippet: String(userMessage || proofMilestone?.detail || "proof").trim().slice(0, 120),
  removed_bottleneck: progression.removed_bottleneck,
  progression_stage: progression.progression_stage,
  new_bottleneck: progression.current_bottleneck,
  next_visible_action: progression.next_visible_action,
  milestone_context: progression.milestone_context,
  suggested_rep: progression.next_green_rep,
});

const buildProgressionWriteback = ({ progression, proofMilestone, map, journey = null }) => {
  const failureBase =
    journey?.evolved_failure?.rule ||
    map?.failure_strategy?.rule ||
    map?.protector_rule ||
    null;
  const successBase =
    journey?.evolved_success?.behaviour ||
    map?.success_strategy?.behaviour ||
    null;

  return {
    active_bottleneck: progression.current_bottleneck,
    progression_stage: progression.progression_stage,
    removed_bottleneck: progression.removed_bottleneck,
    coaching_insights: `Proof: ${proofMilestone?.detail}. Removed: ${progression.removed_bottleneck}. Next: ${progression.current_bottleneck.label}.`,
    progress_note: `Bottleneck progression — ${progression.removed_bottleneck} cleared`,
    current_resistance: `Shifted — was blocked at ${progression.removed_bottleneck}; now at ${progression.current_bottleneck.label}`,
    current_failure_strategy: failureBase
      ? { rule: `${failureBase} — less relevant; active block is ${progression.current_bottleneck.label}` }
      : null,
    current_success_strategy: successBase
      ? { behaviour: `${successBase} — evidenced by: ${proofMilestone?.detail}` }
      : null,
    milestone_focus: progression.milestone_context,
    progression_stage: progression.progression_stage,
    assign_new_green_rep: true,
  };
};

const resolveProofProgressionFlow = ({
  userMessage = "",
  proofSignals = null,
  map = null,
  goalContext = null,
  memoryCtx = null,
  openSession = null,
  proofCycleFlow = null,
} = {}) => {
  const base = {
    skip_llm: false,
    assistant_override: null,
    green_rep: null,
    coaching_directive: null,
    coaching_context: null,
    conversation_signals: null,
    writeback_hints: null,
    structural_coaching_flow: null,
  };

  if (!proofSignals?.hasProof || proofSignals?.isSetback) return base;
  if (proofCycleFlow?.proof_integration_mode) return base;

  const proofMilestone = detectProofMilestone(userMessage);
  if (!proofMilestone) return base;

  const progression = progressionFromProof(proofMilestone, { goalContext, map });
  if (!progression) return base;

  const { loadCoachingJourney } = require("../utils/evolution");
  const journey = loadCoachingJourney(memoryCtx, map, openSession);
  const writeback_hints = buildProgressionWriteback({
    progression,
    proofMilestone,
    map,
    journey,
  });

  return {
    skip_llm: false,
    assistant_override: null,
    green_rep: progression.next_green_rep,
    coaching_directive: formatOutcomeDirective("proof_progression", {
      goal: "Advance funnel after proof without repeating prior diagnosis or same rep.",
      yourJob: [
        "celebrate proof briefly",
        "name removed and new bottleneck",
        "assign next green_rep",
      ],
      avoid: ["prior diagnosis replay", "same rep as before", "outcome-only reps"],
    }),
    coaching_context: buildProgressionContext({ progression, proofMilestone, userMessage }),
    conversation_signals: {
      proof_progression: true,
      assign_green_rep: true,
    },
    writeback_hints,
    structural_coaching_flow: {
      ...(openSession?.structural_coaching_flow || {}),
      progression_stage: progression.progression_stage,
      removed_bottleneck: progression.removed_bottleneck,
      current_bottleneck: progression.current_bottleneck,
      disruption_complete: true,
      last_proof_type: proofMilestone.proof_type,
      last_proof_at: new Date().toISOString(),
    },
  };
};

module.exports = {
  PROGRESSION_STAGES,
  PROOF_TYPES,
  detectProofMilestone,
  progressionFromProof,
  buildProgressionContext,
  buildProgressionWriteback,
  resolveProofProgressionFlow,
};
