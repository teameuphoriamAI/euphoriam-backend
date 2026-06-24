/**
 * Milestone-first Green Rep selection — Goal → Milestone → Visible Action → Resistance → Rep.
 */

const { resolveFailureStrategyForMap, resolveSuccessStrategyForMap } = require("./stage1MapStructure");

const GENERIC_EXERCISE_PATTERN =
  /\b(solo\s+truth|mirror\s+stay|feeling\s+stay|one\s+line\s+out|notes?\s+app|voice\s+memo|read\s+(?:it\s+)?out\s+loud|say\s+(?:your\s+)?rate\s+out\s+loud|write\s+your\s+rate|write\s+(?:your\s+)?rate\s+in|rate\s+in\s+a\s+note)\b/i;

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
  return /\b(income|client|customer|\$|dollar|hour|hr|earn|revenue|sale|outreach|pricing|charge)\b/.test(
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

const buildIncomeClientRep = ({ milestone, goal, failure, success, bottleneck = null }) => {
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
  allowSoloFallback = false,
  bottleneck = null,
  journey = null,
} = {}) => {
  const milestone =
    goalContext?.current_milestone ||
    goalContext?.milestones?.day_7 ||
    map?.milestones?.day_7 ||
    null;
  const goal = goalContext?.goal_name || map?.goal_title || "your goal";
  const visible = goalContext?.visible_next_action || map?.today_visible_action || null;
  const failure = pickFailureLabel(map);
  const success = pickSuccessLabel(map);

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
    return buildIncomeClientRep({ milestone, goal, failure, success, bottleneck });
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

  if (isMilestoneAlignedRep(greenRep, goalContext, map, { allowSoloFallback })) {
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

  let directive =
    `MILESTONE-FIRST ORDER: (1) Goal: "${goal}" (2) Milestone: "${milestone}" ` +
    `(3) Fastest visible action toward milestone (4) Resistance blocking THAT action ` +
    `(5) Failure/success strategy as context only (6) Green Rep that interrupts resistance AND advances milestone (7) Proof. ` +
    `FORBIDDEN: write rate in notes, say rate out loud, solo truth/mirror, or any private exercise that does not move the milestone. ` +
    `Every rep must answer: "How does this increase the probability of achieving ${milestone}?"`;

  if (visible) {
    directive += ` Next visible action from map: "${visible}".`;
  }
  if (failure) directive += ` Active failure strategy: ${failure}.`;
  if (success) directive += ` Active success strategy: ${success}.`;
  if (milestoneRep?.name) {
    directive += ` Use suggested_milestone_rep in green_rep JSON: "${milestoneRep.name}".`;
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
  const { loadCoachingJourney, evolveStrategiesFromProof } = require("./stage1CoachEvolution");
  const journey = loadCoachingJourney(memoryCtx, map);

  if (signals?.hasProof) {
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
  isGenericExerciseRep,
  isIncomeOrClientMilestone,
  isMilestoneAdvancingText,
  isMilestoneAlignedRep,
  buildMilestoneAlignedRep,
  alignGreenRepToMilestone,
  buildMilestonePriorityDirective,
  deriveEvolutionWritebackFromTurn,
  buildIncomeClientRep,
};
