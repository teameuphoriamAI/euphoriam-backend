/**
 * Curated Creator Club / Silver training catalog for Stage 1 suggested training.
 * Replace `url` placeholders with real Kajabi links when Nathan provides them.
 *
 * Tags align with EUPHORIAM-STAGE1-STAGE2-README § Suggested training & content tagging.
 */

const CONTENT_TYPES = Object.freeze({
  MASTERCLASS: "masterclass",
  MEDITATION: "meditation",
  RECORDING: "recording",
  TRAINING: "training",
});

/** min_tier: bronze | silver | accelerate */
const STAGE1_TRAINING_CATALOG = [
  {
    id: "uc-visible-before-perfect",
    type: CONTENT_TYPES.MASTERCLASS,
    title: "Visible Before Perfect",
    program: "Unlimited Creator",
    week: 4,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["income", "wealth", "alignment"],
      resistance: ["delay", "perfection", "refinement", "hide", "avoid", "invisible"],
      use_cases: ["visibility", "action"],
      vortex_eo: ["NE", "F"],
      outcomes: ["visible_action", "reduce_gravity"],
    },
    why_template:
      "Your map shows delay or hiding disguised as preparation — this trains visible action before the story feels ready.",
  },
  {
    id: "uc-clarity-through-action",
    type: CONTENT_TYPES.MASTERCLASS,
    title: "Clarity Through Action",
    program: "Unlimited Creator",
    week: 2,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["income", "wealth", "alignment", "health"],
      resistance: ["overthink", "stall", "confusion", "avoid", "freeze"],
      use_cases: ["clarity", "action"],
      vortex_eo: ["NE", "C"],
      outcomes: ["complete_green_rep", "visible_action"],
    },
    why_template:
      "When the structure doesn't know what to do, it waits — this class installs clarity through one physical move, not more thinking.",
  },
  {
    id: "silver-pattern-interruption-live",
    type: CONTENT_TYPES.MASTERCLASS,
    title: "Pattern Interruption Live",
    program: "Silver Creator Club",
    week: null,
    min_tier: "silver",
    url: null,
    tags: {
      domains: ["income", "wealth", "relationships", "alignment", "health"],
      resistance: ["stuck", "loop", "repeat", "gravity", "collapse", "withdraw"],
      use_cases: ["recovery", "action"],
      vortex_eo: ["F", "R", "S"],
      outcomes: ["reduce_gravity", "recover_faster"],
    },
    why_template:
      "High gravity and repeated stuckness need a live interrupt — this session breaks the vortex loop before it runs the day.",
  },
  {
    id: "silver-recovery-speed-reset",
    type: CONTENT_TYPES.TRAINING,
    title: "Recovery Speed Reset",
    program: "Silver Creator Club",
    week: null,
    min_tier: "silver",
    url: null,
    tags: {
      domains: ["income", "wealth", "relationships", "health", "alignment"],
      resistance: ["collapse", "shame", "devalue", "quit", "not enough"],
      use_cases: ["recovery"],
      vortex_eo: ["F", "NE"],
      outcomes: ["recover_faster", "increase_cl"],
    },
    why_template:
      "After you take action, the structure tries to judge it as 'not enough' — this reset speeds recovery so proof still counts.",
  },
  {
    id: "med-safety-to-be-seen",
    type: CONTENT_TYPES.MEDITATION,
    title: "Safety to Be Seen",
    program: "Creator Club Meditations",
    week: null,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["relationships", "alignment", "income"],
      resistance: ["hide", "withdraw", "rejection", "invisible", "avoid"],
      use_cases: ["visibility", "relationship"],
      vortex_eo: ["R", "NE"],
      outcomes: ["reduce_gravity", "visible_action"],
    },
    why_template:
      "Your flip requires visibility — this meditation lowers the protector's alarm before you take the outward move.",
  },
  {
    id: "med-nervous-system-before-outreach",
    type: CONTENT_TYPES.MEDITATION,
    title: "Nervous System Before Outreach",
    program: "Creator Club Meditations",
    week: null,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["income", "wealth", "relationships"],
      resistance: ["avoid", "fear", "outreach", "conversation", "rejection"],
      use_cases: ["action", "relationship"],
      vortex_eo: ["R", "F"],
      outcomes: ["complete_green_rep", "reduce_gravity"],
    },
    why_template:
      "Before the green rep that involves another person, reset the body so rejection isn't running the show.",
  },
  {
    id: "med-ground-before-commitment",
    type: CONTENT_TYPES.MEDITATION,
    title: "Ground Before Commitment",
    program: "Creator Club Meditations",
    week: null,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["health", "alignment", "wealth"],
      resistance: ["overwhelm", "collapse", "freeze", "control"],
      use_cases: ["clarity", "recovery"],
      vortex_eo: ["C", "F"],
      outcomes: ["reduce_gravity", "increase_cl"],
    },
    why_template:
      "When commitment feels dangerous, grounding installs enough safety to take one bounded action toward the flip.",
  },
  {
    id: "rec-protector-awareness",
    type: CONTENT_TYPES.RECORDING,
    title: "Naming the Protector (Audio)",
    program: "Creator Club Library",
    week: null,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["income", "wealth", "relationships", "alignment", "health"],
      resistance: ["protect", "avoid", "sabotage", "rule"],
      use_cases: ["clarity"],
      vortex_eo: ["F", "R", "NE", "S", "C"],
      outcomes: ["reduce_gravity"],
    },
    why_template:
      "Short audio to separate you from the protector rule — use before coach disrupts today's pattern.",
  },
  {
    id: "rec-flip-install-visualization",
    type: CONTENT_TYPES.RECORDING,
    title: "Flip Install Visualization",
    program: "Creator Club Library",
    week: null,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["income", "wealth", "relationships", "alignment", "health"],
      resistance: ["belief", "identity", "old code"],
      use_cases: ["action", "visibility"],
      vortex_eo: ["NE", "F", "R"],
      outcomes: ["increase_cl", "complete_green_rep"],
    },
    why_template:
      "Rehearse the new structure (your flip belief) in the body before logging proof on today's green rep.",
  },
  {
    id: "uc-money-visibility",
    type: CONTENT_TYPES.MASTERCLASS,
    title: "Money Visibility Structure",
    program: "Unlimited Creator",
    week: 6,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["income", "wealth"],
      resistance: ["hide", "pricing", "money", "invisible", "avoid"],
      use_cases: ["visibility", "money"],
      vortex_eo: ["NE", "S"],
      outcomes: ["visible_action"],
    },
    why_template:
      "Income goals stall when money stays invisible — this class targets the financial visibility flip directly.",
  },
  {
    id: "uc-relationship-truth",
    type: CONTENT_TYPES.MASTERCLASS,
    title: "Truth Without Collapse",
    program: "Unlimited Creator",
    week: 8,
    min_tier: "bronze",
    url: null,
    tags: {
      domains: ["relationships", "alignment"],
      resistance: ["withdraw", "people", "conflict", "silence", "avoid"],
      use_cases: ["relationship", "action"],
      vortex_eo: ["R", "NE"],
      outcomes: ["visible_action", "complete_green_rep"],
    },
    why_template:
      "Relationship resistance often hides truth to stay safe — this supports honest moves without blowing up the connection.",
  },
];

const TIER_RANK = Object.freeze({
  standard: 0,
  bronze: 1,
  silver: 2,
  accelerate: 3,
});

module.exports = {
  CONTENT_TYPES,
  STAGE1_TRAINING_CATALOG,
  TIER_RANK,
};
