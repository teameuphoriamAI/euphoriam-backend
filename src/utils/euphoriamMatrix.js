/**
 * Euphoriam Formula Matrix Generator
 *
 * Core Formula: Signal Output = (QGC × CL) - Gravity
 * Where Gravity acts as a penalty/distortion force that reduces signal
 * 
 * Note: The theoretical formula (QGC × CL) × Gravity represents the full field interaction,
 * but for Signal Output calculation, we use: (QGC × CL) - Gravity (subtractive model)
 *
 * This module generates:
 * 1. The 48 Vortex Signature Matrix (Failure Cards)
 * 2. The 48 QGC Opposite Matrix (Success Cards)
 * 3. Signal calculation utilities
 */

// ============================================================================
// FOUNDATION DEFINITIONS
// ============================================================================

/**
 * Egoic Orientations (EO) - 8 options
 * Formed through separation and unmet childhood needs
 */
const EGOIC_ORIENTATIONS = {
  NE: {
    code: "NE",
    name: "I'm Not Enough",
    description: "The core belief that one is fundamentally insufficient",
  },
  NC: {
    code: "NC",
    name: "I'm Not Capable",
    description: "The core belief that one lacks the ability to handle life",
  },
  NS: {
    code: "NS",
    name: "I'm Not Safe",
    description: "The core belief that the world is fundamentally unsafe",
  },
  PL: {
    code: "PL",
    name: "I'm Powerless",
    description: "The core belief that one has no agency or control",
  },
  CD: {
    code: "CD",
    name: "I Can't Depend On Anyone",
    description: "The core belief that others are unreliable",
  },
  NON: {
    code: "NON",
    name: "It's Not OK To Have Needs",
    description: "The core belief that having needs is wrong or dangerous",
  },
  NOV: {
    code: "NOV",
    name: "It's Not OK To Be Vulnerable",
    description: "The core belief that vulnerability is weakness",
  },
  NOH: {
    code: "NOH",
    name: "It's Not OK To Be Happy / Comfortable",
    description:
      "The core belief that happiness/comfort is wrong or will be taken away",
  },
};

/**
 * Lack Channels - 3 options
 * The felt missingness driving survival
 */
const LACK_CHANNELS = {
  C: {
    code: "C",
    name: "Lack of Connection",
    description: "Feeling disconnected, unseen, or separate from others",
  },
  S: {
    code: "S",
    name: "Lack of Safety/Security",
    description: "Feeling unsafe, unstable, or threatened",
  },
  P: {
    code: "P",
    name: "Lack of Purpose",
    description:
      "Feeling directionless, without meaning, or unclear on calling",
  },
};

/**
 * Avoidance Protectors - 2 options
 * What must not happen again (memory imprints)
 */
const AVOIDANCE_PROTECTORS = {
  F: {
    code: "F",
    name: "Avoid Failure",
    description:
      "Protection against failing, being exposed as failing, shame of failure",
    behaviors: [
      "procrastination",
      "perfectionism",
      "over-planning",
      "under-shipping",
      "quitting early",
      "staying in preparation mode",
      "choosing low-stakes goals",
    ],
  },
  R: {
    code: "R",
    name: "Avoid Rejection",
    description:
      "Protection against being judged, not being chosen, disconnection, humiliation, abandonment",
    behaviors: [
      "people-pleasing",
      "self-silencing",
      "hiding desires",
      "avoiding direct asks",
      "avoiding intimacy",
      "avoiding leadership/visibility",
      "avoiding conflict",
      "staying agreeable",
      "withdrawing first",
    ],
  },
};

// ============================================================================
// VORTEX SIGNATURE DEFINITIONS (48 Combinations)
// ============================================================================

/**
 * Generates all 48 Vortex Signature combinations
 * Format: EO + Lack + Avoid → Failure pattern + Orbit structure
 */
const generateVortexSignatures = () => {
  const signatures = [];
  const eoKeys = Object.keys(EGOIC_ORIENTATIONS);
  const lackKeys = Object.keys(LACK_CHANNELS);
  const avoidKeys = Object.keys(AVOIDANCE_PROTECTORS);

  // Generate all combinations: 8 × 3 × 2 = 48
  eoKeys.forEach((eo) => {
    lackKeys.forEach((lack) => {
      avoidKeys.forEach((avoid) => {
        const signature = {
          id: `${eo}+${lack}+${avoid}`,
          eo: EGOIC_ORIENTATIONS[eo],
          lack: LACK_CHANNELS[lack],
          avoid: AVOIDANCE_PROTECTORS[avoid],
          // These patterns are defined in the Euphoriam documentation
          failurePattern: getFailurePattern(eo, lack, avoid),
          orbitStructure: getOrbitStructure(eo, lack, avoid),
          oppositeBehavior: getOppositeBehavior(eo, lack, avoid),
        };
        signatures.push(signature);
      });
    });
  });

  return signatures;
};

/**
 * Returns the failure pattern for a specific signature
 * Based on the comprehensive documentation provided
 */
const getFailurePattern = (eo, lack, avoid) => {
  const patterns = {
    // NE (Not Enough) patterns
    "NE+C+F": "perform, manage image, overthink first moves",
    "NE+C+R": "people-pleasing, approval seeking, self-silence",
    "NE+S+F": "perfectionism, hiding work, not shipping",
    "NE+S+R": "hypervigilant to judgement, social masking",
    "NE+P+F": 'procrastination on calling, "I\'m not ready"',
    "NE+P+R": 'abandon uniqueness, choose "safe" purpose',

    // NC (Not Capable) patterns
    "NC+C+F": 'withdraw, avoid commitment, avoid "proof moments"',
    "NC+C+R": "overcompensate to be valued, prove worth socially",
    "NC+S+F": "analysis paralysis, endless learning",
    "NC+S+R": "over-rely on experts, permission seeking",
    "NC+P+F": "busywork, false progress",
    "NC+P+R": 'shrink ambition, "realistic goals"',

    // NS (Not Safe) patterns
    "NS+C+F": "guarded intimacy, avoid emotional risk",
    "NS+C+R": "attach/monitor, fear abandonment",
    "NS+S+F": "avoid risk, stay in comfort cage",
    "NS+S+R": "hide visibility, avoid being targeted/judged",
    "NS+P+F": "avoid leadership, under-ship dreams",
    "NS+P+R": "choose obligation over calling",

    // PL (Powerless) patterns
    "PL+C+F": "don't initiate, wait for rescue",
    "PL+C+R": "bargaining, emotional manipulation",
    "PL+S+F": "freeze, shutdown, numbness",
    "PL+S+R": "control battles, dominance/submission swings",
    "PL+P+F": '"I don\'t know what I want," endless indecision',
    "PL+P+R": "comply with life path, abandon desire",

    // CD (Can't Depend) patterns
    "CD+C+F": "lone-wolf, avoid relying/partnering",
    "CD+C+R": "keep emotional distance, withdraw first",
    "CD+S+F": 'distrust, scepticism, "I\'ll figure it out myself"',
    "CD+S+R": "refuse help, reject support",
    "CD+P+F": "isolate genius, avoid collaboration",
    "CD+P+R": "provider identity, duty-led destiny",

    // NON (Needs Not OK) patterns
    "NON+C+F": "suppress desire, never ask directly",
    "NON+C+R": "caretaking, being easy/low-maintenance",
    "NON+S+F": "avoid receiving, avoid wanting more",
    "NON+S+R": 'self-denial, suppression, "I\'m fine"',
    "NON+P+F": "purpose muted, under-aiming",
    "NON+P+R": "duty/service at cost of self",

    // NOV (Vulnerable Not OK) patterns
    "NOV+C+F": "deflection, humour, never go deep",
    "NOV+C+R": "competence mask, perform strength",
    "NOV+S+F": "avoid hard talks, avoid feedback",
    "NOV+S+R": "control narrative, manage perceptions",
    "NOV+P+F": "hide gifts, avoid being evaluated",
    "NOV+P+R": "achieve without heart, avoid openness",

    // NOH (Happy Not OK) patterns
    "NOH+C+F": "sabotage closeness when it stabilises",
    "NOH+C+R": "create drama/tests",
    "NOH+S+F": "overwork, never rest, never arrive",
    "NOH+S+R": "self-create problems to justify tension",
    "NOH+P+F": '"almost there" forever',
    "NOH+P+R": "can't receive success/joy",
  };

  return patterns[`${eo}+${lack}+${avoid}`] || "pattern not defined";
};

/**
 * Returns the orbit structure for a specific signature
 */
const getOrbitStructure = (eo, lack, avoid) => {
  const avoidName = avoid === "F" ? "failure" : "rejection";
  return `avoid ${avoidName} by ${getOrbitStrategy(eo, lack, avoid)}`;
};

const getOrbitStrategy = (eo, lack, avoid) => {
  // Simplified orbit strategies based on the documentation
  if (lack === "C" && avoid === "F") return 'staying "acceptable"';
  if (lack === "C" && avoid === "R") return "becoming what they want";
  if (lack === "S" && avoid === "F") return "never being fully tested";
  if (lack === "S" && avoid === "R") return "staying invisible";
  if (lack === "P" && avoid === "F") return "delaying purpose";
  if (lack === "P" && avoid === "R") return "not standing out";
  return "maintaining protection";
};

/**
 * Returns the opposite behavior for a specific signature
 * This is the "Success Card" behavior (gated until CR/Mastery access)
 */
const getOppositeBehavior = (eo, lack, avoid) => {
  const opposites = {
    // Universal opposite behaviors for protectors
    F: [
      "Ship before ready",
      "Choose exposure over perfection",
      "Take the proof moment",
      "Act first, refine second",
    ],
    R: [
      "Reveal truth (no hinting)",
      "Ask directly",
      "Hold a boundary without apology",
      "Stay present (don't withdraw first)",
    ],

    // Universal opposite behaviors for lack channels
    C: [
      "Create connection through truth + presence (not performance)",
      "Initiate / repair / invite / appreciate",
      "Speak cleanly instead of managing image",
    ],
    S: [
      "Regulate first, then act",
      "Choose steadiness over threat meaning",
      "Take calibrated risks",
    ],
    P: [
      "Commit to one channel and move it",
      'Choose mission reps, not "almost"',
      "Build rhythm of output (daily/weekly)",
    ],

    // EO-specific opposite behavior styles
    NE: [
      "Stop image management; be seen as you are",
      "Choose authenticity over approval",
      "Publish imperfectly; ask without shrinking",
    ],
    NC: [
      "Stop preparing; do proof reps",
      "Learn by shipping; finish small things daily",
      "Build competence through repetition",
    ],
    NS: [
      "Be visible with regulation",
      "Act from groundedness, not threat",
      'Do "seen while safe" reps',
    ],
    PL: ["Initiate", "Decide and act", "Claim agency with one move today"],
    CD: [
      "Allow support",
      "Delegate / ask / co-create",
      "Receive without controlling",
    ],
    NON: [
      "State needs clearly",
      "Ask without apology",
      "Receive without earning",
    ],
    NOV: [
      "Tell the truth",
      "Share the real feeling",
      "Be seen without image management",
    ],
    NOH: [
      "Choose peace/ease instead of tension",
      "Allow receiving",
      'Let "good" be safe',
    ],
  };

  return {
    protectorOpposites: opposites[avoid] || [],
    lackOpposites: opposites[lack] || [],
    eoOpposites: opposites[eo] || [],
  };
};

// ============================================================================
// SUCCESS CARD (QGC OPPOSITE MATRIX) GENERATION
// ============================================================================

/**
 * Generates the Success Card (QGC Coordinate) for each Failure Card
 * Success Card = IAM + Fulfilled Need + Courage Vector + Received
 *
 * This is the "limitless coordinate" - the opposite frequency of the vortex
 */
const generateSuccessCards = () => {
  const failureCards = generateVortexSignatures();

  return failureCards.map((failureCard) => {
    const { eo, lack, avoid } = failureCard;

    return {
      failureCardId: failureCard.id,
      successCard: {
        iam: getIAMIdentity(eo),
        fulfilledNeed: getFulfilledNeed(lack),
        courageVector: getCourageVector(avoid),
        receivedLanguage: getReceivedLanguage(eo, lack, avoid),
      },
      masteryGap: {
        primaryBlocker: {
          protector: avoid,
          depth: "2", // Typically vortex-level (can be 1, 2, or 3)
          eo: eo.code,
          lack: lack.code,
        },
      },
    };
  });
};

/**
 * Returns the IAM (New Identity) for the opposite of each EO
 */
const getIAMIdentity = (eo) => {
  const iamMap = {
    NE: "I am enough, exactly as I am",
    NC: "I am capable and learning through doing",
    NS: "I am safe and can create safety",
    PL: "I have agency and can create change",
    CD: "I can depend on myself and allow others to support me",
    NON: "My needs are valid and important",
    NOV: "Vulnerability is strength and connection",
    NOH: "I am allowed to be happy and receive ease",
  };

  return iamMap[eo.code] || "I am complete and capable";
};

/**
 * Returns the fulfilled need opposite of each Lack channel
 */
const getFulfilledNeed = (lack) => {
  const fulfilledMap = {
    C: "Connection through truth and presence",
    S: "Safety through regulation and grounded action",
    P: "Purpose through committed mission and output",
  };

  return fulfilledMap[lack.code] || "Fulfillment through alignment";
};

/**
 * Returns the courage vector opposite of each Avoid protector
 */
const getCourageVector = (avoid) => {
  const courageMap = {
    F: "Courage to ship imperfectly and be seen",
    R: "Courage to be honest and hold boundaries",
  };

  return courageMap[avoid.code] || "Courage to move forward";
};

/**
 * Returns the "received/have" language for the Success Card
 */
const getReceivedLanguage = (eo, lack, avoid) => {
  return `I have received ${getFulfilledNeed(
    lack
  ).toLowerCase()}. I am ${getIAMIdentity(
    eo
  ).toLowerCase()}. I am moving with ${getCourageVector(avoid).toLowerCase()}.`;
};

// ============================================================================
// SIGNAL CALCULATION (Core Formula Implementation)
// ============================================================================

/**
 * Calculates Signal Output using the Euphoriam Formula:
 * Signal Output = (QGC × CL) - Gravity
 * 
 * Where:
 * - QGC = Quantum Genius Codes (activation 0-100)
 * - CL = Consciousness Level (1-5, converted to holding capacity 0-100)
 * - Gravity = Gravity Load × Depth Multiplier (distortion force that reduces signal)
 * 
 * Formula breakdown:
 * 1. QGC × CL product = (QGC × CL Holding) / 100
 * 2. Gravity Penalty = Gravity Load × Depth Multiplier (1.0, 1.4, or 1.9)
 * 3. Signal Output = QGC×CL Product - Gravity Penalty
 * 
 * When Gravity > (QGC × CL), signal is negative (repulsion state)
 * When (QGC × CL) > Gravity, signal is positive (attraction/lock-in state)
 *
 * @param {Object} params
 * @param {number} params.qgcActivation - QGC Activation (0-100)
 * @param {number} params.cl - Conscious Level (1-5)
 * @param {number} params.gravityLoad - Gravity Load (0-100)
 * @param {number} params.gravityDepth - Gravity Depth (1, 2, or 3)
 * @returns {Object} Signal calculation results
 */
const calculateSignal = ({
  qgcActivation,
  cl,
  gravityLoad,
  gravityDepth = 2,
}) => {


  // Validate inputs
  qgcActivation = Math.max(0, Math.min(100, qgcActivation));
  cl = Math.max(1, Math.min(5, cl));
  gravityLoad = Math.max(0, Math.min(100, gravityLoad));
  gravityDepth = Math.max(1, Math.min(3, gravityDepth));



  // Depth scaling multipliers (from documentation)
  const depthMultipliers = {
    1: 1.0, // Surface gravity (fast to shift)
    2: 1.4, // Vortex rules (sticky, creates repetition)
    3: 1.9, // Template imprints (most influential, reprints system)
  };

  const depthMultiplier = depthMultipliers[gravityDepth];
  

  // Calculate QGC × CL component
  const qgcClComponent = (qgcActivation / 100) * (cl / 5) * 100;
  

  // Calculate Gravity Penalty with depth scaling
  const gravityPenalty = gravityLoad * depthMultiplier;
  
  // Calculate Signal Output
  // Signal = (QGC × Hold) - GravityPenalty
  // Where Hold = CL Holding Capacity (simplified as CL for now)
  const clHolding = (cl / 5) * 100;


  const qgcClProduct = (qgcActivation * clHolding) / 100;


  const signalRaw = qgcClProduct - gravityPenalty;
 

  // Normalize Signal Output to 0-100 scale
  // According to Euphoriam Formula: Signal Output = (QGC × CL) - Gravity
  // This can be negative when Gravity > (QGC × CL), representing repulsion state
  // For display purposes, we normalize:
  // - Negative values (repulsion) map to 0-50 range
  // - Positive values (attraction/lock-in) map to 50-100 range
  // This preserves the information that negative = repulsion while keeping 0-100 scale
  let signalOutput;
  if (signalRaw < 0) {
    // Negative signal (repulsion): map to 0-50 range
    // Example: -56 maps to ~22, -100 maps to 0, 0 maps to 50
    signalOutput = Math.max(0, 50 + (signalRaw / 2)); // Divide by 2 to compress negative range
  } else {
    // Positive signal (attraction/lock-in): map to 50-100 range
    // Example: 0 maps to 50, 50 maps to 75, 100 maps to 100
    signalOutput = Math.min(100, 50 + (signalRaw / 2)); // Divide by 2 to compress positive range
  }
  
  // Alternative: Simple clamp (loses negative information)
  // const signalOutput = Math.max(0, Math.min(100, signalRaw));
  


  // Calculate Integration Angle (geometry metric)
  const numerator = (qgcActivation * clHolding) / 100;
  const denominator = gravityPenalty || 0.01; // Avoid division by zero
  const integrationAngle = Math.atan(numerator / denominator) * (180 / Math.PI);

  // Determine signal zone
  let signalZone;
  if (signalOutput < 50) {
    signalZone = "repulsion"; // Signal is incoherent or abducted
  } else if (signalOutput < 70) {
    signalZone = "attraction"; // Starts mirroring with consistency
  } else if (signalOutput < 85) {
    signalZone = "lock-in"; // Reality mirrors faster + less volatility
  } else {
    signalZone = "self-correcting"; // CL4/5 characteristics
  }

  return {
    signalOutput: Math.round(signalOutput),
    qgcActivation: Math.round(qgcActivation),
    clHolding: Math.round(clHolding),
    gravityLoad: Math.round(gravityLoad),
    gravityPenalty: Math.round(gravityPenalty),
    gravityDepth,
    integrationAngle: Math.round(integrationAngle * 100) / 100,
    signalZone,
    formula: {
      qgcClComponent: Math.round(qgcClComponent),
      gravityPenalty: Math.round(gravityPenalty),
      rawSignal: Math.round(signalRaw),
      normalizedSignal: Math.round(signalOutput),
    },
  };
};

/**
 * Gets a vortex signature by ID
 */
const getVortexSignature = (signatureId) => {
  const signatures = generateVortexSignatures();
  return signatures.find((sig) => sig.id === signatureId);
};

/**
 * Gets the Success Card for a given Failure Card
 */
const getSuccessCard = (failureCardId) => {
  const successCards = generateSuccessCards();
  return successCards.find((card) => card.failureCardId === failureCardId);
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Foundation definitions
  EGOIC_ORIENTATIONS,
  LACK_CHANNELS,
  AVOIDANCE_PROTECTORS,

  // Matrix generators
  generateVortexSignatures,
  generateSuccessCards,

  // Signal calculation
  calculateSignal,

  // Lookup functions
  getVortexSignature,
  getSuccessCard,

  // Utility functions
  getFailurePattern,
  getOppositeBehavior,
  getIAMIdentity,
  getFulfilledNeed,
  getCourageVector,
};
