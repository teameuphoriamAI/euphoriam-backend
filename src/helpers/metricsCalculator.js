/**
 * Metrics Calculator using Euphoriam Formula
 * 
 * Calculates metrics using: (QGC × CL) × Gravity = Signal to the Field
 * 
 * This module:
 * 1. Extracts vortex signature (EO + Lack + Avoid) from conversation/report
 * 2. Calculates signal output using the formula
 * 3. Determines gravity depth
 * 4. Provides calculated metrics for discovery reports
 */

const { calculateSignal, getVortexSignature, getSuccessCard } = require('../utils/euphoriamMatrix');

/**
 * Extracts vortex signature components from conversation or report text
 * Uses AI-like pattern matching to identify EO, Lack, and Avoid patterns
 * 
 * @param {string} text - Conversation transcript or report text
 * @param {Object} existingMetrics - Previous metrics to use as fallback
 * @returns {Object} Extracted signature components
 */
const extractVortexSignature = (text = '', existingMetrics = {}) => {
  if (!text) {
    return {
      eo: null,
      lack: null,
      avoid: null,
      signatureId: null,
      confidence: 'low'
    };
  }

  const lowerText = text.toLowerCase();
  
  // EO (Egoic Orientation) patterns
  const eoPatterns = {
    NE: ['not enough', 'im not enough', 'i\'m not enough', 'insufficient', 'inadequate', 'not worthy'],
    NC: ['not capable', 'im not capable', 'i\'m not capable', 'can\'t do it', 'not able', 'incompetent'],
    NS: ['not safe', 'im not safe', 'i\'m not safe', 'unsafe', 'dangerous', 'threatened', 'vulnerable to harm'],
    PL: ['powerless', 'no power', 'no control', 'can\'t change', 'helpless', 'no agency'],
    CD: ['can\'t depend', 'can\'t rely', 'no one to trust', 'alone', 'isolated', 'self-reliant', 'lone wolf'],
    NON: ['not ok to have needs', 'needs not ok', 'can\'t need', 'shouldn\'t need', 'no needs'],
    NOV: ['not ok to be vulnerable', 'vulnerability not ok', 'can\'t be vulnerable', 'must be strong', 'hide weakness'],
    NOH: ['not ok to be happy', 'happy not ok', 'can\'t be comfortable', 'must struggle', 'guilt about joy']
  };

  // Lack channel patterns
  const lackPatterns = {
    C: ['lack of connection', 'disconnected', 'lonely', 'unseen', 'not belonging', 'isolated', 'alone'],
    S: ['lack of safety', 'unsafe', 'insecure', 'threatened', 'anxious', 'worried', 'fearful'],
    P: ['lack of purpose', 'no direction', 'lost', 'unclear', 'no meaning', 'aimless', 'no calling']
  };

  // Avoidance protector patterns
  const avoidPatterns = {
    F: ['avoid failure', 'fear of failing', 'perfectionism', 'procrastination', 'not ready', 'hiding work', 'afraid to try'],
    R: ['avoid rejection', 'fear of rejection', 'people pleasing', 'self-silence', 'hiding desires', 'afraid to ask', 'avoid conflict']
  };

  // Score each pattern
  const scoreEO = {};
  const scoreLack = {};
  const scoreAvoid = {};

  Object.keys(eoPatterns).forEach(eo => {
    scoreEO[eo] = eoPatterns[eo].reduce((count, pattern) => {
      const matches = (lowerText.match(new RegExp(pattern, 'gi')) || []).length;
      return count + matches;
    }, 0);
  });

  Object.keys(lackPatterns).forEach(lack => {
    scoreLack[lack] = lackPatterns[lack].reduce((count, pattern) => {
      const matches = (lowerText.match(new RegExp(pattern, 'gi')) || []).length;
      return count + matches;
    }, 0);
  });

  Object.keys(avoidPatterns).forEach(avoid => {
    scoreAvoid[avoid] = avoidPatterns[avoid].reduce((count, pattern) => {
      const matches = (lowerText.match(new RegExp(pattern, 'gi')) || []).length;
      return count + matches;
    }, 0);
  });

  // Get highest scoring patterns
  const eo = Object.keys(scoreEO).reduce((a, b) => scoreEO[a] > scoreEO[b] ? a : b, 'NE');
  const lack = Object.keys(scoreLack).reduce((a, b) => scoreLack[a] > scoreLack[b] ? a : b, 'C');
  const avoid = Object.keys(scoreAvoid).reduce((a, b) => scoreAvoid[a] > scoreAvoid[b] ? a : b, 'F');

  // Calculate confidence
  const maxEOScore = Math.max(...Object.values(scoreEO));
  const maxLackScore = Math.max(...Object.values(scoreLack));
  const maxAvoidScore = Math.max(...Object.values(scoreAvoid));
  
  const totalScore = maxEOScore + maxLackScore + maxAvoidScore;
  let confidence = 'low';
  if (totalScore >= 5) confidence = 'high';
  else if (totalScore >= 2) confidence = 'medium';

  // If no clear pattern found, return null
  if (totalScore === 0) {
    return {
      eo: null,
      lack: null,
      avoid: null,
      signatureId: null,
      confidence: 'low'
    };
  }

  const signatureId = `${eo}+${lack}+${avoid}`;

  return {
    eo,
    lack,
    avoid,
    signatureId,
    confidence,
    scores: {
      eo: scoreEO,
      lack: scoreLack,
      avoid: scoreAvoid
    }
  };
};

/**
 * Determines gravity depth (1, 2, or 3) based on conversation patterns
 * 
 * @param {string} text - Conversation or report text
 * @param {Object} existingMetrics - Previous metrics
 * @returns {number} Gravity depth (1, 2, or 3)
 */
const determineGravityDepth = (text = '', existingMetrics = {}) => {
  if (!text) return existingMetrics.gravityDepth || 2;

  const lowerText = text.toLowerCase();

  // Depth 3 indicators (template/subatomic level)
  const depth3Indicators = [
    'i know what to do but can\'t',
    'disproportionate reaction',
    'instant reprint',
    'repeated pattern',
    'destiny feel',
    'ancestral',
    'inherited',
    'deep imprint',
    'subatomic',
    'template level'
  ];

  // Depth 2 indicators (vortex rules)
  const depth2Indicators = [
    'repeated pattern',
    'same thing keeps happening',
    'rules engine',
    'i must',
    'i can\'t unless',
    'orbit pattern',
    'toward away',
    'progress collapse'
  ];

  // Depth 1 indicators (surface)
  const depth1Indicators = [
    'reactive',
    'emotional charge',
    'scattered',
    'contradictory',
    'surface level',
    'language shift'
  ];

  const depth3Count = depth3Indicators.reduce((count, pattern) => {
    return count + (lowerText.match(new RegExp(pattern, 'gi')) || []).length;
  }, 0);

  const depth2Count = depth2Indicators.reduce((count, pattern) => {
    return count + (lowerText.match(new RegExp(pattern, 'gi')) || []).length;
  }, 0);

  const depth1Count = depth1Indicators.reduce((count, pattern) => {
    return count + (lowerText.match(new RegExp(pattern, 'gi')) || []).length;
  }, 0);

  // Return depth with highest count, default to 2
  if (depth3Count >= depth2Count && depth3Count >= depth1Count && depth3Count > 0) {
    return 3;
  } else if (depth2Count >= depth1Count && depth2Count > 0) {
    return 2;
  } else if (depth1Count > 0) {
    return 1;
  }

  return existingMetrics.gravityDepth || 2;
};

/**
 * Calculates all metrics using the Euphoriam Formula
 * 
 * @param {Object} params
 * @param {string} params.conversationText - Full conversation transcript
 * @param {Object} params.existingMetrics - Previous metrics
 * @param {Object} params.extractedMetrics - Metrics extracted from AI report (if available)
 * @returns {Object} Complete metrics with formula-based calculations
 */
const calculateDiscoveryMetrics = ({
  conversationText = '',
  existingMetrics = {},
  extractedMetrics = {}
}) => {
  console.log('[calculateDiscoveryMetrics] Starting calculation');
  console.log('[calculateDiscoveryMetrics] Input - extractedMetrics:', extractedMetrics);
  console.log('[calculateDiscoveryMetrics] Input - existingMetrics:', existingMetrics);
  
  // Extract vortex signature
  const signature = extractVortexSignature(conversationText, existingMetrics);
  console.log('[calculateDiscoveryMetrics] Extracted signature:', signature);
  
  // Determine gravity depth
  const gravityDepth = determineGravityDepth(conversationText, existingMetrics);
  console.log('[calculateDiscoveryMetrics] Determined gravityDepth:', gravityDepth);

  // Get base metrics (prefer extracted, then existing, then defaults)
  const qgcActivation = extractedMetrics.qgcActivation ?? existingMetrics.qgcActivation ?? 50;
  const cl = extractedMetrics.consciousnessLevel ?? existingMetrics.consciousnessLevel ?? 2.0;
  const gravityLoad = extractedMetrics.gravity ?? existingMetrics.gravity ?? 50;
  const signalCoherence = extractedMetrics.signalCoherence ?? existingMetrics.signalCoherence ?? 50;
  
  console.log('[calculateDiscoveryMetrics] Base metrics selected:', {
    qgcActivation,
    cl,
    gravityLoad,
    signalCoherence,
    gravityDepth,
    source: {
      qgc: extractedMetrics.qgcActivation !== undefined ? 'extracted' : (existingMetrics.qgcActivation !== undefined ? 'existing' : 'default'),
      cl: extractedMetrics.consciousnessLevel !== undefined ? 'extracted' : (existingMetrics.consciousnessLevel !== undefined ? 'existing' : 'default'),
      gravity: extractedMetrics.gravity !== undefined ? 'extracted' : (existingMetrics.gravity !== undefined ? 'existing' : 'default'),
      signalCoherence: extractedMetrics.signalCoherence !== undefined ? 'extracted' : (existingMetrics.signalCoherence !== undefined ? 'existing' : 'default'),
    }
  });

  // Calculate signal output using the formula
  console.log('[calculateDiscoveryMetrics] Calling calculateSignal with:', {
    qgcActivation,
    cl,
    gravityLoad,
    gravityDepth
  });
  
  const signalCalculation = calculateSignal({
    qgcActivation,
    cl,
    gravityLoad,
    gravityDepth
  });
  
  console.log('[calculateDiscoveryMetrics] Signal calculation result:', signalCalculation);

  // Get vortex signature details if available
  let vortexSignature = null;
  let successCard = null;
  if (signature.signatureId) {
    vortexSignature = getVortexSignature(signature.signatureId);
    successCard = getSuccessCard(signature.signatureId);
  }

  const finalMetrics = {
    // Core metrics
    qgcActivation: Math.round(qgcActivation),
    consciousnessLevel: Math.round(cl * 10) / 10, // Round to 1 decimal
    gravity: Math.round(gravityLoad),
    signalCoherence: Math.round(signalCoherence),
    signalOutput: signalCalculation.signalOutput,
    
    // Formula-based additions
    gravityDepth,
    integrationAngle: signalCalculation.integrationAngle,
    signalZone: signalCalculation.signalZone,
    
    // Vortex signature
    vortexSignature: signature.signatureId,
    eo: signature.eo,
    lack: signature.lack,
    avoid: signature.avoid,
    signatureConfidence: signature.confidence,
    
    // Formula breakdown
    formula: {
      qgcClComponent: signalCalculation.formula.qgcClComponent,
      gravityPenalty: signalCalculation.formula.gravityPenalty,
      rawSignal: signalCalculation.formula.rawSignal,
      normalizedSignal: signalCalculation.formula.normalizedSignal
    },
    
    // Additional data
    vortexSignatureDetails: vortexSignature,
    successCard: successCard ? {
      iam: successCard.successCard.iam,
      fulfilledNeed: successCard.successCard.fulfilledNeed,
      courageVector: successCard.successCard.courageVector,
      receivedLanguage: successCard.successCard.receivedLanguage
    } : null
  };
  
  console.log('[calculateDiscoveryMetrics] Final metrics calculated:', {
    qgcActivation: finalMetrics.qgcActivation,
    consciousnessLevel: finalMetrics.consciousnessLevel,
    gravity: finalMetrics.gravity,
    signalCoherence: finalMetrics.signalCoherence,
    signalOutput: finalMetrics.signalOutput,
    gravityDepth: finalMetrics.gravityDepth,
    signalZone: finalMetrics.signalZone,
    formula: finalMetrics.formula
  });
  
  return finalMetrics;
};

/**
 * Updates metrics based on new conversation, preserving what makes sense
 * 
 * @param {Object} params
 * @param {string} params.conversationText - New conversation transcript
 * @param {Object} params.existingMetrics - Previous metrics
 * @param {Object} params.extractedMetrics - Metrics extracted from AI report
 * @returns {Object} Updated metrics
 */
const updateMetricsFromDiscovery = ({
  conversationText = '',
  existingMetrics = {},
  extractedMetrics = {}
}) => {
  console.log('[updateMetricsFromDiscovery] Starting update');
  console.log('[updateMetricsFromDiscovery] Input - extractedMetrics:', extractedMetrics);
  console.log('[updateMetricsFromDiscovery] Input - existingMetrics:', existingMetrics);
  
  // Calculate new metrics using formula
  const calculatedMetrics = calculateDiscoveryMetrics({
    conversationText,
    existingMetrics,
    extractedMetrics
  });
  
  console.log('[updateMetricsFromDiscovery] Calculated metrics:', {
    signalOutput: calculatedMetrics.signalOutput,
    formula: calculatedMetrics.formula
  });

  // Merge: prefer extracted (from AI report), then calculated (from formula), then existing
  const merged = {
    ...existingMetrics,
    ...calculatedMetrics,
    // Prefer extracted metrics for QGC, CL, Gravity if available (AI may have better insight)
    qgcActivation: extractedMetrics.qgcActivation ?? calculatedMetrics.qgcActivation,
    consciousnessLevel: extractedMetrics.consciousnessLevel ?? calculatedMetrics.consciousnessLevel,
    gravity: extractedMetrics.gravity ?? calculatedMetrics.gravity,
    signalCoherence: extractedMetrics.signalCoherence ?? calculatedMetrics.signalCoherence,
    // Always use calculated signal output (formula-based)
    signalOutput: calculatedMetrics.signalOutput,
    // Always include formula-based additions
    gravityDepth: calculatedMetrics.gravityDepth,
    integrationAngle: calculatedMetrics.integrationAngle,
    signalZone: calculatedMetrics.signalZone,
    vortexSignature: calculatedMetrics.vortexSignature,
    eo: calculatedMetrics.eo,
    lack: calculatedMetrics.lack,
    avoid: calculatedMetrics.avoid
  };
  
  console.log('[updateMetricsFromDiscovery] Final merged metrics:', {
    qgcActivation: merged.qgcActivation,
    consciousnessLevel: merged.consciousnessLevel,
    gravity: merged.gravity,
    signalCoherence: merged.signalCoherence,
    signalOutput: merged.signalOutput,
    signalOutputSource: extractedMetrics.signalOutput !== undefined ? 'extracted (overridden by formula)' : 'calculated',
    formula: merged.formula
  });
  
  return merged;
};

module.exports = {
  extractVortexSignature,
  determineGravityDepth,
  calculateDiscoveryMetrics,
  updateMetricsFromDiscovery,
  calculateSignal // Re-export for direct use
};

