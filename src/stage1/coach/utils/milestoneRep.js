/**
 * Milestone-first Green Rep selection — Goal → Milestone → Flip → Visible Action → Rep → Proof.
 */

const { resolveFailureStrategyForMap, resolveSuccessStrategyForMap } = require("../../../helpers/stage1MapStructure");

const GENERIC_EXERCISE_PATTERN =
  /\b(solo\s+truth|truth\s+send|honest\s+sentence|say\s+it\s+in\s+(?:the\s+)?mirror|safest\s+relevant\s+person|hold\s+(?:your\s+)?body\s+steady|mirror\s+(?:exercise|stay|work)|feeling\s+stay|one\s+line\s+out|notes?\s+app|voice\s+(?:note|memo)|read\s+(?:it\s+)?out\s+loud|say\s+(?:your\s+)?rate\s+out\s+loud|write\s+your\s+rate|write\s+(?:your\s+)?rate\s+in|rate\s+in\s+a\s+note|generic\s+truth|truth\s+expression|visibility\s+exercise|journal\s+about|affirm(?:ation)?\s+out\s+loud)\b/i;

const FLIP_MARKET_ANSWER_PATTERN =
  /\b(let\s+(?:the\s+)?(?:market|client|them)\s+answer|before\s+i\s+answer|wait\s+for\s+(?:the\s+)?(?:market|client|response)|market\s+answer)\b/i;

const REP_SEND_UNCHANGED_PATTERN =
  /\b(send|offer|proposal|quote|pitch).*(?:unchang|without\s+chang|same\s+rate|hold\s+(?:the\s+)?rate|not\s+chang|leave\s+(?:it|the\s+rate))|(?:unchang|without\s+edit|hold\s+(?:the\s+)?rate).*(?:send|offer|proposal)\b/i;

const UNSENT_ONLY_PATTERN =
  /\b(do\s+not\s+send|don't\s+send|unsent|without\s+sending|not\s+send)\b/i;

const MILESTONE_ADVANCE_PATTERN =
  /\b(send|outreach|message|contact|client|customer|offer|rate|charge|dm|linkedin|email|pitch|book|call|post|invoice|proposal|follow.?up|land|close|sell|list|prospect|business|portfolio|identify|sample)\b/i;

const repTextBlob = (rep) =>
  [rep?.name, ...(rep?.steps || []), rep?.win_condition].filter(Boolean).join(" ");

const pickFailureLabel = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs.trim();
  return (fs?.rule || fs?.title || map?.protector_rule || "").trim() || null;
};

const pickSuccessLabel = (map) => {
  const ss = resolveSuccessStrategyForMap(map);
  if (typeof ss === "string") return ss.trim();
  return (ss?.behaviour || ss?.behavior || ss?.title || map?.flip_rule || "").trim() || null;
};

const pickFlipBelief = (map) => (map?.flip_belief || "").trim() || null;

const pickFlipRule = (map) =>
  (map?.flip_rule || "").trim() || pickSuccessLabel(map) || null;

const flipTextBlob = (map) =>
  [pickFlipBelief(map), pickFlipRule(map), pickSuccessLabel(map)].filter(Boolean).join(" ");

const goalMilestoneBlob = (goalContext = null, map = null) =>
  [
    goalContext?.current_milestone,
    goalContext?.goal_name,
    goalContext?.measurable_outcome,
    map?.desired_outcome,
    map?.goal_title,
    goalContext?.milestones?.day_7,
    goalContext?.milestones?.day_30,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const isIncomeOrClientMilestone = (goalContext = null, map = null) => {
  const blob = goalMilestoneBlob(goalContext, map);
  return /\b(income|client|customer|\$|dollar|hour|hr|earn|revenue|sale|outreach|pricing|charge|upwork|fiverr|freelanc|proposal|profile\s+view|gig|job\s+(?:post|listing)|rank|prospect)\b/.test(
    blob,
  );
};

const isGenericExerciseRep = (rep) => {
  const blob = repTextBlob(rep);
  if (!blob.trim()) return true;
  if (GENERIC_EXERCISE_PATTERN.test(blob)) return true;
  if (UNSENT_ONLY_PATTERN.test(blob) && !MILESTONE_ADVANCE_PATTERN.test(blob)) return true;
  return false;
};

const isMilestoneAdvancingText = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 6) return false;
  if (GENERIC_EXERCISE_PATTERN.test(t) && !MILESTONE_ADVANCE_PATTERN.test(t)) return false;
  return MILESTONE_ADVANCE_PATTERN.test(t) || /\b(open\s+linkedin|first\s+client)\b/i.test(t);
};

const embodiesDiscoveredFlip = (rep, map = null) => {
  const flip = flipTextBlob(map);
  if (!flip.trim()) return true;

  const blob = repTextBlob(rep);
  if (!blob.trim() || isGenericExerciseRep(rep)) return false;

  if (FLIP_MARKET_ANSWER_PATTERN.test(flip)) {
    return (
      REP_SEND_UNCHANGED_PATTERN.test(blob) ||
      (/\bsend\b/i.test(blob) &&
        /\b(?:unchang|hold|same\s+rate|without\s+edit|not\s+chang|leave\s+(?:it|the\s+rate))\b/i.test(
          blob,
        ))
    );
  }

  if (/\b(visible|visibility|seen|expose|financially\s+visible)\b/i.test(flip)) {
    return MILESTONE_ADVANCE_PATTERN.test(blob) && !GENERIC_EXERCISE_PATTERN.test(blob);
  }

  if (isIncomeOrClientMilestone(null, map)) {
    return MILESTONE_ADVANCE_PATTERN.test(blob);
  }

  return !isGenericExerciseRep(rep);
};

const passesGreenRepTest = (rep, goalContext = null, map = null, opts = {}) => {
  if (!rep?.name?.trim()) return false;
  if (!isMilestoneAlignedRep(rep, goalContext, map, opts)) return false;
  if (!embodiesDiscoveredFlip(rep, map)) return false;
  return true;
};

const isMilestoneAlignedRep = (
  rep,
  goalContext = null,
  map = null,
  { allowSoloFallback = false } = {},
) => {
  if (!rep?.name?.trim()) return false;
  if (isGenericExerciseRep(rep)) {
    return allowSoloFallback && !isIncomeOrClientMilestone(goalContext, map);
  }
  if (isIncomeOrClientMilestone(goalContext, map)) {
    return MILESTONE_ADVANCE_PATTERN.test(repTextBlob(rep));
  }
  return !isGenericExerciseRep(rep);
};

const buildRepFromVisibleAction = (visibleAction, milestone, goal) => {
  const action = String(visibleAction || "").trim();
  const name =
    action.length <= 52
      ? action.charAt(0).toUpperCase() + action.slice(1)
      : "Milestone Visible Action";
  return {
    name,
    steps: [
      action,
      `Do it today — not prep. Moves toward: ${milestone || goal || "your milestone"}.`,
      "Log proof: what you sent, posted, or asked for (one sentence).",
    ],
    win_condition: `${action} — completed today, not planned`,
  };
};

const buildFlipEmbodiedIncomeRep = ({ milestone, goal, failure, flip, flipRule, bottleneck = null }) => {
  const flipText = flipRule || flip || "";
  const failureBit = failure ? ` Interrupts: ${failure.slice(0, 80)}.` : "";
  const flipBit = flipText ? ` Embodies flip: ${flipText.slice(0, 100)}.` : "";

  if (FLIP_MARKET_ANSWER_PATTERN.test(flipText)) {
    return {
      name: "Send One Offer Unchanged",
      steps: [
        "Pick one prospect you can contact today.",
        `Send one offer at your stated rate toward ${milestone || goal} — do not lower price when fear appears.`,
        "After sending, do not edit the offer. Let them respond or not.",
      ],
      win_condition: "One offer sent at stated rate — unchanged after fear",
      milestone_link: milestone || goal,
      flip_link: flipText,
      coaching_note: `Practices flip in the real world.${failureBit}${flipBit}`,
    };
  }

  if (/\b(decide|answer\s+for|predict|control\s+outcome)\b/i.test(failure || "") && flipText) {
    return {
      name: "Send One Offer Unchanged",
      steps: [
        "Draft one offer with your rate — do not negotiate with yourself before sending.",
        "Send it to one prospect before editing price or scope.",
        "Proof: offer sent unchanged; you did not answer for the market.",
      ],
      win_condition: "One offer sent unchanged — market can answer",
      milestone_link: milestone || goal,
      flip_link: flipText,
      coaching_note: `Practices flip in the real world.${failureBit}${flipBit}`,
    };
  }

  return null;
};

const buildIncomeClientRep = ({
  milestone,
  goal,
  failure,
  success,
  flip,
  flipRule,
  bottleneck = null,
  funnelStage = null,
  userMessage = "",
  outcomePending = false,
}) => {
  if (funnelStage) {
    const { buildFunnelAwareRep } = require("../signals/evidence");
    const funnelRep = buildFunnelAwareRep({
      funnelStage,
      goalContext: { current_milestone: milestone, goal_name: goal },
      map: null,
      userMessage,
      outcomePending,
    });
    if (funnelRep) {
      return {
        ...funnelRep,
        milestone_link: milestone || goal,
        coaching_note: "Funnel-aware rep — do not repeat completed outreach stages.",
      };
    }
  }

  const flipEmbodied = buildFlipEmbodiedIncomeRep({
    milestone,
    goal,
    failure,
    flip,
    flipRule,
    bottleneck,
  });
  if (flipEmbodied) return flipEmbodied;
  const wantsFirstClient = /\b(first\s+client|get\s+.*client|land\s+.*client|paying\s+client)\b/i.test(
    String(milestone || goal || ""),
  );
  const failureBit = failure ? ` Interrupts: ${failure.slice(0, 80)}.` : "";
  const successBit = success ? ` Aligns with: ${success.slice(0, 80)}.` : "";

  if (
    bottleneck?.type === "strategy_gap" ||
    bottleneck?.type === "knowledge_gap" ||
    bottleneck?.type === "resource_gap"
  ) {
    if (bottleneck?.type === "resource_gap") {
      return {
        name: "Build One Portfolio Piece",
        steps: [
          "Pick one service you can sell this week (e.g. website refresh, landing page).",
          "Create one sample or before/after — doesn't need to be perfect.",
          "Save it where you can link it in outreach.",
        ],
        win_condition: "One portfolio/sample asset saved and linkable",
        milestone_link: milestone || goal,
        next_visible_action: "Open your list and find prospect #1",
      };
    }
    return {
      name: "List 20 Prospect Businesses",
      steps: [
        "Pick one channel (Google Maps, LinkedIn, local businesses, etc.).",
        "List 20 businesses that could pay for your service — outdated site or clear need.",
        "Mark the top 3 lowest-friction prospects for outreach tomorrow.",
      ],
      win_condition: "20 potential client businesses identified with contact path",
      milestone_link: milestone || goal,
      next_visible_action: "Find business #1 on your list",
    };
  }

  if (wantsFirstClient) {
    return {
      name: "Send 3 Client Outreach Messages",
      steps: [
        "List 3 people who could realistically pay for your offer this week.",
        "Send message #1 with a clear offer and rate (or booking link) — sent counts, reply doesn't.",
        "Send messages #2 and #3 before end of day.",
      ],
      win_condition: "3 outreach messages sent to potential clients",
      milestone_link: milestone || goal,
      coaching_note: `Advances milestone: ${milestone || goal}.${failureBit}${successBit}`,
    };
  }

  return {
    name: "Outbound Client Touch",
    steps: [
      "Pick one channel where potential clients are (LinkedIn, email, DM).",
      "Send one message that names your service and your rate toward " +
        `${milestone || goal || "income"}.`,
      "Log who you contacted and what you offered.",
    ],
    win_condition: "One outbound message sent naming service and rate",
    milestone_link: milestone || goal,
    coaching_note: `Advances milestone: ${milestone || goal}.${failureBit}${successBit}`,
  };
};

const buildMilestoneAlignedRep = ({
  map = null,
  goalContext = null,
  memoryCtx = null,
  openSession = null,
  allowSoloFallback = false,
  bottleneck = null,
  journey = null,
  userMessage = "",
} = {}) => {
  const {
    inferFunnelStageFromContext,
    hasOutcomePending,
    diagnosisIsInvisibility,
  } = require("../signals/evidence");
  const funnelStage = inferFunnelStageFromContext({
    userMessage,
    openSession,
    memoryCtx,
  });
  const outcomePending = hasOutcomePending(userMessage);
  const pastOutreach = [
    "contact_initiated",
    "conversation_started",
    "proposal_sent",
    "client_closed",
  ].includes(funnelStage);

  const milestone =
    goalContext?.current_milestone ||
    goalContext?.milestones?.day_7 ||
    map?.milestones?.day_7 ||
    null;
  const goal = goalContext?.goal_name || map?.goal_title || "your goal";
  const visible = goalContext?.visible_next_action || map?.today_visible_action || null;
  const failure = pickFailureLabel(map);
  const success = pickSuccessLabel(map);
  const flip = pickFlipBelief(map);
  const flipRule = pickFlipRule(map);

  if (visible && isMilestoneAdvancingText(visible)) {
    return buildRepFromVisibleAction(visible, milestone, goal);
  }

  const daily = map?.daily_rep;
  if (
    daily?.name &&
    typeof daily === "object" &&
    isMilestoneAlignedRep(daily, goalContext, map, { allowSoloFallback })
  ) {
    return {
      name: daily.name,
      steps: Array.isArray(daily.steps) ? daily.steps : [],
      win_condition: daily.win_condition || null,
      milestone_link: milestone || goal,
    };
  }

  if (isIncomeOrClientMilestone(goalContext, map)) {
    if (pastOutreach && diagnosisIsInvisibility(map, journey)) {
      return buildIncomeClientRep({
        milestone,
        goal,
        failure,
        success,
        flip,
        flipRule,
        bottleneck,
        funnelStage,
        userMessage,
        outcomePending,
      });
    }
    return buildIncomeClientRep({
      milestone,
      goal,
      failure,
      success,
      flip,
      flipRule,
      bottleneck,
    });
  }

  if (allowSoloFallback) return null;

  if (visible) {
    return buildRepFromVisibleAction(visible, milestone, goal);
  }

  return {
    name: "One Milestone Move Today",
    steps: [
      `Name the smallest outward action that moves toward: ${milestone || goal}.`,
      "Do that action today — visible to the world or another person, not private prep.",
      "Log what you did in one sentence.",
    ],
    win_condition: `One visible action completed toward ${milestone || goal}`,
    milestone_link: milestone || goal,
  };
};

const alignGreenRepToMilestone = (
  greenRep,
  {
    map = null,
    goalContext = null,
    memoryCtx = null,
    allowSoloFallback = false,
    assignRequested = false,
  } = {},
) => {
  const fallback = buildMilestoneAlignedRep({
    map,
    goalContext,
    memoryCtx,
    allowSoloFallback,
  });

  if (!greenRep && assignRequested) return fallback;
  if (!greenRep) return null;

  if (passesGreenRepTest(greenRep, goalContext, map, { allowSoloFallback })) {
    return greenRep;
  }

  return fallback;
};

const buildMilestonePriorityDirective = ({ map, goalContext, milestoneRep = null } = {}) => {
  const goal = goalContext?.goal_name || map?.goal_title || "goal";
  const milestone =
    goalContext?.current_milestone ||
    goalContext?.milestones?.day_7 ||
    "current milestone";
  const visible =
    goalContext?.visible_next_action || map?.today_visible_action || null;
  const failure = pickFailureLabel(map);
  const success = pickSuccessLabel(map);
  const flip = pickFlipBelief(map);
  const flipRule = pickFlipRule(map);

  let directive =
    `FLIP-EMBODIMENT REPS — Map → Insight → Flip → Real-world behavior → Proof. ` +
    `ORDER: (1) Goal: "${goal}" (2) Milestone: "${milestone}" (3) Discovered flip (4) One outward action that physically practices the flip (5) Proof. ` +
    `GREEN REP TEST before assigning: "Does this rep directly strengthen the flip and advance the milestone?" If not, choose a different rep. ` +
    `FORBIDDEN: mirror exercise, voice note, solo truth, generic truth expression, write/say rate in private, or any visibility exercise that does not move the milestone. ` +
    `For income/business goals prefer prospecting, outreach, offers, follow-up, proposals, and conversations before internal exercises. ` +
    `Internal exercises only when stabilization is required, overwhelm is high, or no external action is possible.`;

  if (visible) {
    directive += ` Next visible action from map: "${visible}".`;
  }
  if (failure) directive += ` Active insight/failure strategy: ${failure}.`;
  if (flipRule) directive += ` Active flip rule: ${flipRule}.`;
  else if (flip) directive += ` Active flip belief: ${flip}.`;
  else if (success) directive += ` Active success strategy: ${success}.`;
  if (milestoneRep?.name) {
    directive += ` Use suggested_milestone_rep in green_rep JSON: "${milestoneRep.name}".`;
    if (milestoneRep.flip_link) directive += ` Flip embodied: ${milestoneRep.flip_link}.`;
  }
  return directive;
};

const deriveEvolutionWritebackFromTurn = ({
  userMessage = "",
  map = null,
  memoryCtx = null,
  signals = null,
  bottleneck = null,
} = {}) => {
  const { loadCoachingJourney, evolveStrategiesFromProof } = require("./evolution");
  const journey = loadCoachingJourney(memoryCtx, map);

  if (signals?.hasProof) {
    const { buildEvidenceContradictionWriteback, diagnosisContradictedByEvidence } =
      require("../signals/evidence");
    const contradiction = diagnosisContradictedByEvidence({
      userMessage,
      map,
      memoryCtx,
    });
    if (contradiction.contradicted) {
      return {
        ...evolveStrategiesFromProof({
          userMessage,
          map,
          journey,
          bottleneck,
        }),
        ...buildEvidenceContradictionWriteback({
          contradiction,
          map,
          journey,
          userMessage,
        }),
      };
    }
    return evolveStrategiesFromProof({
      userMessage,
      map,
      journey,
      bottleneck,
    });
  }

  const hints = {};
  const t = String(userMessage || "").trim();
  if (!t || t.length < 4) return hints;

  const { hasVisibilityAction } = require("../signals/evidence");
  if (hasVisibilityAction(t)) {
    const { diagnosisContradictedByEvidence, buildEvidenceContradictionWriteback } =
      require("../signals/evidence");
    const contradiction = diagnosisContradictedByEvidence({ userMessage: t, map, memoryCtx });
    if (contradiction.contradicted) {
      return buildEvidenceContradictionWriteback({
        contradiction,
        map,
        journey,
        userMessage: t,
      });
    }
  }

  const sessions = memoryCtx?.coaching_sessions || [];
  const lastSession = sessions[sessions.length - 1] || null;
  const failureBase =
    lastSession?.current_failure_strategy?.rule ||
    pickFailureLabel(map) ||
    map?.protector_rule ||
    null;
  const successBase =
    lastSession?.current_success_strategy?.behaviour ||
    pickSuccessLabel(map) ||
    null;

  if (signals?.isSetback) {
    hints.current_resistance = t.slice(0, 200);
    if (failureBase) hints.current_failure_strategy = { rule: failureBase };
  } else if (/\b(avoid|lazy|scared|reject|invisible|procrastinat|stuck|didn'?t\s+reach)\b/i.test(t)) {
    hints.current_resistance = t.slice(0, 200);
    if (failureBase) hints.current_failure_strategy = { rule: failureBase };
  }

  if (bottleneck?.type) hints.active_bottleneck = bottleneck;

  return hints;
};

module.exports = {
  GENERIC_EXERCISE_PATTERN,
  FLIP_MARKET_ANSWER_PATTERN,
  isGenericExerciseRep,
  embodiesDiscoveredFlip,
  passesGreenRepTest,
  isIncomeOrClientMilestone,
  isMilestoneAdvancingText,
  isMilestoneAlignedRep,
  buildMilestoneAlignedRep,
  buildFlipEmbodiedIncomeRep,
  alignGreenRepToMilestone,
  buildMilestonePriorityDirective,
  deriveEvolutionWritebackFromTurn,
  buildIncomeClientRep,
  pickFlipBelief,
  pickFlipRule,
};
