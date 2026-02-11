import { Diagnostic } from "../models/diagnosticModel.js";
import { Discovery } from "../models/discoveryModel.js";
import { Prompt } from "../models/promptModel.js";
import { User } from "../models/userModel.js";
import validate from "../helpers/validate.js";
import openai from "../config/openai.js";

import {
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  sanitizeReportText,
} from "../helpers/euphoriamChatbot.js";
import { retrieveSimilarChunks } from "../helpers/rag.js";
import { successResponse, errorResponse } from "../utils/response.js";
import {
  getCustomerByEmail,
  getCustomerFullDetails,
  getSiteById,
  getContactById,
  getOfferById,
  getAssessmentProgressForCustomer,
  getCourseWithPosts,
  extractAssessmentsFromCourse,
  getProductWithCourse,
  extractCourseIdFromProduct,
} from "../controllers/kajabi.js";
import { generateDiagnosticPdf } from "../utils/diagnosticPdf.js";
import { uploadBufferToSupabase } from "../utils/storage.js";
import { sendEmail, sendEmailBasic } from "../utils/email.js";
import { diagnosticReportEmail } from "../utils/emailTemplate/initialDignosticReport.js";
import { discoveryReportEmail } from "../utils/emailTemplate/initialDiscoveryReport.js";
import { buildKajabiDiagnosticContext } from "../controllers/kajabi.js";

const isQuestion = (text = "") => text.trim().endsWith("?");
const isAnswerLike = (text = "") => {
  const t = (text || "").trim();
  if (!t) return false;
  if (isQuestion(t)) return false;
  const alpha = t.match(/[A-Za-z]/g);
  // Relaxed: Allow short answers like "yes", "A", or "d,d,d"
  return alpha && alpha.length >= 1 && t.length >= 1;
};

// Extracts "Q<number>" from an assistant message to track distinct intake topics.
const extractQuestionNumber = (text = "") => {
  const match = (text || "").match(/Q\s*(\d{1,2})/i);
  return match ? Number(match[1]) : null;
};

const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club")
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club")
  );
  return hasProduct || hasOffer;
};
const findOrCreateCreatorUser = async ({ email, name }) => {
  let user = await User.findOne({ where: { email } });

  if (!user) {
    user = await User.create({
      email,
      name,
    });
  }

  return user;
};

// Lightweight AI check to decide if a user reply is an answer to the last question.
const isAiLikelyAnswer = async ({ question, reply }) => {
  const t = (reply || "").trim().toLowerCase();
  if (!t) return false;
  if (isQuestion(t)) return false;
  // Hard fail on clarify/intents
  const clarifyPhrases = [
    "elaborate",
    "clarify",
    "explain",
    "repeat",
    "don't understand",
    "do not understand",
    "not sure",
    "what do you mean",
    "?", // ends with question mark
  ];
  if (clarifyPhrases.some((p) => t.includes(p))) return false;

  // Heuristic: Recognize common simple answers immediately
  const normalizedReply = t.trim();
  const simpleAnswers = ["yes", "no", "y", "n", "yeah", "yep", "nope", "nah"];
  if (simpleAnswers.includes(normalizedReply)) {
    // Only accept yes/no as valid answers if the question is actually a yes/no question
    const questionText = (question || "").toLowerCase();
    const isYesNoQuestion =
      /^(do|does|did|is|are|was|were|have|has|had|can|could|would|should|will)\s+/i.test(
        question
      ) || // Starts with auxiliary verb
      /\?$/.test(question.trim()) && // Ends with question mark AND
      /(do|does|did|is|are|was|were|have|has|had|can|could|would|should|will)\s+/.test(
        question
      ); // Contains auxiliary verb

    // Also check if question is open-ended (what/how/why/when/where/who/describe/explain)
    const isOpenEnded =
      /^(what|how|why|when|where|who|describe|explain|tell\s+me|share)/i.test(
        question
      ) ||
      /\b(what|how|why|when|where|who|describe|explain|tell|share)\b/i.test(
        question
      );

    if (isYesNoQuestion && !isOpenEnded) {
      console.log(`[isAiLikelyAnswer] Accepting yes/no for yes/no question: "${question}"`);
      return true; // Accept yes/no for yes/no questions
    }

    // STRICT HEURISTIC: If it's strictly open-ended (starts with what/how/etc and NOT a yes/no structure)
    // then a solitary "yes" or "no" is NEVER a valid answer.
    if (!isYesNoQuestion && isOpenEnded && simpleAnswers.includes(normalizedReply)) {
      console.log(`[isAiLikelyAnswer] STRICT REJECT: soliltary "${normalizedReply}" for open-ended question: "${question}"`);
      return false;
    }

    // For open-ended questions, "yes" or "no" alone is NOT a valid answer - pass to AI classifier
    console.log(`[isAiLikelyAnswer] Passing yes/no for complex check to AI classifier: "${question}" (isYesNoQuestion=${isYesNoQuestion}, isOpenEnded=${isOpenEnded})`);
  }

  // Single letter answers (A, B, C, etc.) - only accept if question has multiple choice options
  const singleLetterAnswers = ["a", "b", "c", "d", "e", "f"];
  if (singleLetterAnswers.includes(normalizedReply)) {
    // Check if the question contains multiple choice indicators
    const questionText = (question || "").toLowerCase();
    const hasMultipleChoice =
      /\([a-f]\)/i.test(question) || // (A), (B), (C)
      /^[a-f]\)/i.test(question) || // A), B), C) at start of line
      /\*\*[a-f]\)/i.test(question) || // **A), **B), **C)
      /\[a-f\]/i.test(question) || // [A], [B], [C]
      /pick\s+[a-f]/i.test(question) || // "pick A", "pick B"
      /choose\s+[a-f]/i.test(question) || // "choose A", "choose B"
      /reply\s+with\s+[a-f]/i.test(question) || // "reply with A"
      /option\s+[a-f]/i.test(question); // "option A"

    if (hasMultipleChoice) {
      return true; // Accept single letter only if question has multiple choice options
    }
    // If no multiple choice detected, don't accept single letter - let AI classifier decide
  }

  // Single number answers (1, 2, 3, etc.) - only accept if question has numbered options
  const singleNumberAnswers = ["1", "2", "3", "4", "5", "6"];
  if (singleNumberAnswers.includes(normalizedReply)) {
    const questionText = (question || "").toLowerCase();
    const hasNumberedOptions =
      /\([1-6]\)/i.test(question) || // (1), (2), (3)
      /^[1-6]\)/i.test(question) || // 1), 2), 3) at start of line
      /\*\*[1-6]\)/i.test(question) || // **1), **2), **3)
      /\[1-6\]/i.test(question) || // [1], [2], [3]
      /option\s+[1-6]/i.test(question); // "option 1"

    if (hasNumberedOptions) {
      return true; // Accept single number only if question has numbered options
    }
    // If no numbered options detected, don't accept single number - let AI classifier decide
  }

  // Check for "move on", "next", "skip" type responses that indicate user wants to proceed
  const moveOnPhrases = [
    "move on",
    "next question",
    "next",
    "skip",
    "move to next",
    "continue",
    "proceed",
    "go to next",
  ];
  if (moveOnPhrases.some((p) => normalizedReply.includes(p))) {
    return true; // Accept move-on requests as answers
  }

  // Heuristic: Recognize common single-word location/state answers
  const singleWordAnswers = [
    "alone",
    "together",
    "home",
    "work",
    "bed",
    "couch",
    "chair",
    "desk",
    "balcony",
    "outside",
    "library",
    "park",
    "car",
    "office",
    "calm",
    "relaxed",
    "interrupted",
    "available",
    "free",
    "busy",
    "watched",
    "on-call",
  ];
  if (singleWordAnswers.includes(normalizedReply)) {
    return true; // Accept single-word descriptive answers immediately
  }

  // Heuristic: Recognize common descriptive answers (2-4 words that are likely answers)
  // These are short, descriptive responses that answer location/state questions
  const descriptiveAnswerPatterns = [
    /^(completely|fully|totally|mostly|usually|always|never|sometimes)\s+(alone|interrupted|available|on-call|watched|free|busy|calm|relaxed)/i,
    /^(at|in|on|by|near)\s+(home|work|bed|couch|chair|desk|balcony|outside|library|park|car|office)/i,
    /^(alone|together|with\s+people|by\s+myself|with\s+family|with\s+friends)/i,
    /^(yes|no|maybe|sometimes|often|rarely|never|always)\s+(alone|interrupted|available)/i,
  ];
  if (descriptiveAnswerPatterns.some((pattern) => pattern.test(reply))) {
    return true; // Accept descriptive answers immediately
  }

  // Heuristic: Short answers (2-4 words) that don't contain question words are likely answers
  const words = normalizedReply.split(/\s+/).filter((w) => w.length > 0);
  if (words.length >= 2 && words.length <= 4) {
    const questionWords = [
      "what",
      "where",
      "when",
      "why",
      "how",
      "who",
      "which",
      "can",
      "could",
      "would",
      "should",
      "is",
      "are",
      "do",
      "does",
      "did",
    ];
    const hasQuestionWord = words.some((w) => questionWords.includes(w));
    if (!hasQuestionWord && !normalizedReply.includes("?")) {
      // Likely a descriptive answer - pass to AI classifier but be more lenient
      // This will be handled by the AI classifier below
    }
  }

  const alpha = t.match(/[A-Za-z]/g);
  // Relaxed: Allow short answers to pass to the AI classifier
  if (!alpha || alpha.length < 1) return false;

  const prompt = `
You are a binary classifier. Decide if the user's reply is a VALID, COMPLETE answer to the given question.

Question: "${question || "N/A"}"
Reply: "${reply}"

Rules:
- Reply only "yes" or "no".
- "yes" ONLY if the reply provides substantive information that answers the question.
- "no" if:
  * The reply is just a question back
  * The reply is "I don't know" or similar
  * The reply is unrelated to the question
  * The reply is a greeting, social comment, or off-topic remark
  * The question asks "what/how/describe/explain" and the reply is just "yes" or "no" (insufficient detail)
  * The question asks for a pattern/example/description and the reply is a single word that doesn't provide the requested information

Examples:
- Question: "What's the pattern that stops you?" Reply: "no" → Answer: no (insufficient - needs description)
- Question: "What's the pattern that stops you?" Reply: "procrastination" → Answer: yes (provides pattern)
- Question: "Do you feel anxious?" Reply: "yes" → Answer: yes (valid for yes/no question)
- Question: "How are you?" Reply: "good" → Answer: no (social greeting, not diagnostic answer)
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "").toLowerCase();
    return txt.includes("yes");
  } catch (err) {
    console.error("[isAiLikelyAnswer] fallback to heuristic", err);
    // Fallback: If AI fails, use heuristic for simple answers
    const normalizedReply = t.trim();
    const simpleAnswers = ["yes", "no", "y", "n", "yeah", "yep", "nope", "nah"];
    if (simpleAnswers.includes(normalizedReply)) {
      return true;
    }

    // Single letter answers - only accept if question has multiple choice
    const singleLetterAnswers = ["a", "b", "c", "d", "e", "f"];
    if (singleLetterAnswers.includes(normalizedReply)) {
      const questionText = (question || "").toLowerCase();
      const hasMultipleChoice =
        /\([a-f]\)/i.test(question) ||
        /^[a-f]\)/i.test(question) ||
        /\*\*[a-f]\)/i.test(question) ||
        /\[a-f\]/i.test(question) ||
        /pick\s+[a-f]/i.test(question) ||
        /choose\s+[a-f]/i.test(question) ||
        /reply\s+with\s+[a-f]/i.test(question) ||
        /option\s+[a-f]/i.test(question);
      if (hasMultipleChoice) {
        return true;
      }
    }

    // Single number answers - only accept if question has numbered options
    const singleNumberAnswers = ["1", "2", "3", "4", "5", "6"];
    if (singleNumberAnswers.includes(normalizedReply)) {
      const questionText = (question || "").toLowerCase();
      const hasNumberedOptions =
        /\([1-6]\)/i.test(question) ||
        /^[1-6]\)/i.test(question) ||
        /\*\*[1-6]\)/i.test(question) ||
        /\[1-6\]/i.test(question) ||
        /option\s+[1-6]/i.test(question);
      if (hasNumberedOptions) {
        return true;
      }
    }
    const moveOnPhrases = [
      "move on",
      "next question",
      "next",
      "skip",
      "move to next",
      "continue",
      "proceed",
      "go to next",
    ];
    if (moveOnPhrases.some((p) => normalizedReply.includes(p))) {
      return true;
    }
    // Fallback: Check for single-word location/state answers
    const singleWordAnswers = [
      "alone",
      "together",
      "home",
      "work",
      "bed",
      "couch",
      "chair",
      "desk",
      "balcony",
      "outside",
      "library",
      "park",
      "car",
      "office",
      "calm",
      "relaxed",
      "interrupted",
      "available",
      "free",
      "busy",
      "watched",
      "on-call",
    ];
    if (singleWordAnswers.includes(normalizedReply)) {
      return true;
    }
    // Fallback: Check for descriptive answers
    const descriptiveAnswerPatterns = [
      /^(completely|fully|totally|mostly|usually|always|never|sometimes)\s+(alone|interrupted|available|on-call|watched|free|busy|calm|relaxed)/i,
      /^(at|in|on|by|near)\s+(home|work|bed|couch|chair|desk|balcony|outside|library|park|car|office)/i,
      /^(alone|together|with\s+people|by\s+myself|with\s+family|with\s+friends)/i,
    ];
    if (descriptiveAnswerPatterns.some((pattern) => pattern.test(reply))) {
      return true;
    }
    // Fallback: Short answers (2-4 words) without question words are likely answers
    const words = normalizedReply.split(/\s+/).filter((w) => w.length > 0);
    if (words.length >= 2 && words.length <= 4) {
      const questionWords = [
        "what",
        "where",
        "when",
        "why",
        "how",
        "who",
        "which",
        "can",
        "could",
        "would",
        "should",
        "is",
        "are",
        "do",
        "does",
        "did",
      ];
      const hasQuestionWord = words.some((w) => questionWords.includes(w));
      if (!hasQuestionWord && !normalizedReply.includes("?")) {
        // Likely a descriptive answer - accept it
        return true;
      }
    }
    return false;
  }
};
export function validateChatbotRequest(body = {}) {
  const {
    email,
    name,
    messages = [],
    assessmentIds = [],
    finalize = false,
    introPageText,
    targetCount = 25, // 25 core questions in the Deep Intake Engine
    discoveryType,
  } = body;

  if (!email) throw new Error("Email is required");
  if (!name) throw new Error("Name is required");

  return {
    email,
    name,
    messages,
    assessmentIds,
    finalize,
    introPageText,
    targetCount,
    discoveryType,
  };
}
export async function loadDiagnosticContext({ email }) {
  const diagnostic = await Diagnostic.findOne({ where: { email } });

  const data = diagnostic?.data || {};
  const intakeState = data.intakeState || {};

  return {
    diagnostic,
    hasExistingReport: Boolean(data.aiReport),
    intakeState,
    priorReport: data.aiReport || null,
    metrics: data.metrics || {},
    previousReports: Array.isArray(data.previousReports)
      ? data.previousReports
      : [],
    reportDate: extractReportDate(diagnostic),
  };
}

export async function extractReportDate(diagnostic) {
  if (!diagnostic) return null;

  const date = diagnostic.data?.generatedAt || diagnostic.updatedAt;

  if (date) {
    const dateObj = new Date(date);
    // Format as "Jan 10, 2024 14:30 UTC"
    const month = dateObj.toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    const day = dateObj.getUTCDate();
    const year = dateObj.getUTCFullYear();
    const hours = String(dateObj.getUTCHours()).padStart(2, "0");
    const minutes = String(dateObj.getUTCMinutes()).padStart(2, "0");
    return `${month} ${day}, ${year} ${hours}:${minutes} UTC`;
  }

  return null;
}
export async function handleOngoingChat(req, res, input, context) {
  const transcript = resolveTranscript(input.messages, context);

  // const kajabi = await buildKajabiDiagnosticContext({
  //   email: input.email,
  //   assessmentIds: input.assessmentIds,
  // });

  const appUser = await findOrCreateCreatorUser({
    email: input.email,
    name: input.name,
  });

  const aiPayload = await buildAiTurn({
    input,
    context,
    transcript,
    // kajabi,
  });

  const aiResponse = await runChatCompletion(aiPayload);

  const nextMessage = normalizeAiResponse(aiResponse, context);

  const updatedState = await persistIntakeProgress({
    context,
    transcript,
    nextMessage,
    appUser,
    input,
  });

  if (shouldAutoFinalize(updatedState, input, context)) {
    return await autoFinalizeDiagnostic(req, res, {
      input,
      context,
      updatedState,
      // kajabi,
      appUser,
    });
  }

  return successResponse(res, "Next chatbot message", {
    nextMessage,
    transcript: updatedState.transcript,
    intakeState: updatedState.intakeState,
  });
}
export async function runChatCompletion({
  model,
  messages,
  temperature,
  maxTokens,
  retry = 0,
}) {
  try {
    const res = await openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_completion_tokens: maxTokens,
    });

    return res.choices?.[0]?.message || null;
  } catch (err) {
    if (retry > 0) {
      return runChatCompletion({
        model,
        messages,
        temperature,
        maxTokens,
        retry: retry - 1,
      });
    }
    throw err;
  }
}
// LLM-based detection: Check if user wants a new diagnostic
export async function detectUserWantsNewDiagnostic({
  userMessage,
  transcript = [],
}) {
  console.log(
    "[detectUserWantsNewDiagnostic] Checking user message:",
    userMessage?.substring(0, 100)
  );

  // Check if assistant just said they're ready to generate the current report
  const lastAssistantMessage =
    transcript.filter((m) => m?.role === "assistant").slice(-1)[0]?.content ||
    "";
  const assistantSaysReadyToGenerate =
    /(I have|have enough|enough to generate|generate.*diagnostic|ready to generate|can generate|will generate)/i.test(
      lastAssistantMessage
    );

  // If assistant just said they're ready to generate, and user says "generate it" or similar,
  // they want to generate the CURRENT report, not start a NEW diagnostic
  if (assistantSaysReadyToGenerate) {
    const userWantsToGenerateCurrent =
      /^(generate|generate it|generate my report|generate report|yes|go ahead|do it|please|ok)$/i.test(
        userMessage.trim()
      );
    if (userWantsToGenerateCurrent) {
      console.log(
        "[detectUserWantsNewDiagnostic] Assistant is ready to generate, user wants to generate CURRENT report (not new diagnostic)"
      );
      return false; // They want to generate current report, not start new diagnostic
    }
  }

  const prompt = `
You are a binary classifier. Analyze the user's message and determine if they EXPLICITLY want to CREATE A NEW DIAGNOSTIC REPORT (start a completely new diagnostic from scratch).

User's latest message: "${userMessage || ""}"

Recent conversation context (last 5 messages):
${JSON.stringify(transcript.slice(-5), null, 2)}

CRITICAL RULES - UNDERSTAND FULL CONTEXT:
- Reply ONLY "yes" or "no"
- Return "yes" ONLY if the user EXPLICITLY and CLEARLY requests to create, start, do, or generate a NEW diagnostic/report FROM SCRATCH
- CRITICAL DISTINCTION:
  * If the assistant just said "I have enough to generate your full diagnostic now" or similar, and user says "generate it" or "generate report" → NO (they want to generate the CURRENT report, not start a NEW one)
  * "generate it" when assistant is ready → NO (generate current report)
  * "generate my report" when assistant is ready → NO (generate current report)
  * "create new diagnostic" → YES (explicit request for NEW diagnostic)
  * "start new report" → YES (explicit request for NEW report)
  * "do my diagnostics again" → YES (explicit request to start over)
- UNDERSTAND CONTEXT: Words like "generate", "create", "report" can appear in normal conversation
  * "generate its report" → NO (describing a process, not requesting)
  * "write it down and then generate its report" → NO (describing steps, not requesting)
  * "my chest hurt ends and i start conversation im my head write it down and then generate its report" → NO (describing experience, not requesting)
  * "generate it" when assistant says they're ready → NO (generate current report, not new diagnostic)
- Return "no" if the message is:
  * Answering a question
  * Continuing conversation
  * Sharing insights, updates, or reflections
  * Describing experiences or processes
  * Requesting to generate the CURRENT report (not a new one)
  * Using words like "generate", "create", "report" in a different context
  * Any statement that doesn't clearly indicate intent to create a NEW diagnostic FROM SCRATCH
- When in doubt, return "no" - only return "yes" for very clear and explicit requests to START A NEW diagnostic

Examples:
- "create new diagnostic" → yes (explicit request for NEW)
- "start new report" → yes (explicit request for NEW)
- "do my diagnostics again" → yes (explicit request to start over)
- "generate it" (when assistant said "I have enough to generate") → no (generate CURRENT report)
- "generate my report" (when assistant said "I have enough") → no (generate CURRENT report)
- "generate its report" → no (describing a process, not requesting)
- "write it down and then generate its report" → no (describing steps, not requesting)
- Any question or statement → no (unless explicitly about creating a NEW diagnostic FROM SCRATCH)

Reply:`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "")
      .toLowerCase()
      .trim();

    const result = txt.includes("yes");
    console.log(
      "[detectUserWantsNewDiagnostic] LLM result:",
      result,
      "(response:",
      txt,
      ")"
    );

    return result;
  } catch (err) {
    console.error("[detectUserWantsNewDiagnostic] ❌ LLM error", err);
    return false;
  }
}

// LLM-based detection: Check if user wants to end chat or generate report
export async function detectUserWantsToEndOrGenerateReport({
  userMessage,
  transcript = [],
  wantsNewDiagnosticVal = null, // Optional pre-calculated value to save an LLM call
}) {
  console.log(
    "[detectUserWantsToEndOrGenerateReport] Checking user message:",
    userMessage?.substring(0, 100)
  );

  // FIRST: Check if user wants a new diagnostic - if so, they DON'T want to end/generate report
  const wantsNewDiagnostic =
    wantsNewDiagnosticVal !== null
      ? wantsNewDiagnosticVal
      : await detectUserWantsNewDiagnostic({
        userMessage,
        transcript,
      });

  console.log(
    "[detectUserWantsToEndOrGenerateReport] wantsNewDiagnostic:",
    wantsNewDiagnostic
  );

  if (wantsNewDiagnostic) {
    console.log(
      "[detectUserWantsToEndOrGenerateReport] ❌ User wants new diagnostic, NOT to end/generate report"
    );
    return false; // User wants new diagnostic, NOT to end/generate report
  }

  // Use LLM to understand FULL CONTEXT - no regex patterns
  // LLM will understand that "by the end", "today will end", "exit to my world" are NOT requests to end chat
  const prompt = `
You are a binary classifier. Analyze the user's message and determine if they EXPLICITLY want to:
1. End the chat/conversation
2. Generate a report
3. Get a report
4. Finish the conversation
5. Email the report
6. Send the report
7. Stop/pause the conversation

User's latest message: "${userMessage || ""}"

Recent conversation context (last 5 messages):
${JSON.stringify(transcript.slice(-5), null, 2)}

CRITICAL RULES - BE VERY STRICT:
- Reply ONLY "yes" or "no"
- Return "yes" ONLY if the user EXPLICITLY and CLEARLY uses ACTION WORDS like:
  * "end chat", "finish chat", "stop chat", "close chat"
  * "generate report", "generate my report", "get my report", "send report", "email report"
  * "I'm done", "I'm finished", "that's enough for me", "we're done here"
  * "I want to end", "let's end this", "end the conversation"
- Return "no" for ANY casual responses, status updates, or answers to questions, including:
  * "doing good" / "doing good for now" → NO (casual response to "how are you doing?")
  * "I'm good" / "I'm good for now" → NO (casual response, NOT a request to end)
  * "that's good" → NO (acknowledgment, not a request)
  * "ok" / "okay" → NO (acknowledgment)
  * "thanks" / "thank you" → NO (gratitude, not a request to end)
  * "sounds good" → NO (agreement, not a request)
  * Any answer to a question → NO
  * Any status update or reflection → NO
  * Any description of experience or process → NO
- UNDERSTAND CONTEXT: Words like "end", "exit", "finish", "stop", "chat", "conversation", "generate", "report" can appear in normal conversation
  * "by the end" → NO (talking about a time period, not ending chat)
  * "today will end" → NO (talking about the day ending, not ending chat)
  * "exit to my world" → NO (talking about going somewhere, not ending chat)
  * "work can be anything" → NO (talking about work, not ending chat)
  * "doing good for now" → NO (casual response to question, NOT requesting to end)
  * "I'm good for now" → NO (casual response, NOT requesting to end - only YES if context clearly shows they want to stop)
  * "my chest hurt ends and i start conversation im my head write it down and then generate its report" → NO (describing a process/experience, NOT requesting to generate report)
  * "generate its report" → NO (describing a process, NOT requesting)
  * "write it down and then generate its report" → NO (describing steps, NOT requesting)
  * "end chat" → YES (explicit request to end chat)
  * "finish conversation" → YES (explicit request to finish)
  * "email me the report" → YES (explicit request)
  * "generate my report now" → YES (explicit request with action word)
- Return "no" if the message is:
  * Answering a question (including "how are you doing?" → "doing good for now" = NO)
  * Continuing conversation
  * Sharing insights, updates, or reflections
  * Describing experiences, processes, or situations
  * Casual responses or acknowledgments
  * Using words like "end", "exit", "finish", "generate", "report" in a different context
  * Describing what they do or what happens
  * Any statement that doesn't clearly indicate ending/generating intent
- Return "no" if they want to start a NEW diagnostic (these are requests to START something new, not END)
- When in doubt, return "no" - only return "yes" for VERY CLEAR and EXPLICIT ending/generating requests with ACTION WORDS
- Understand the FULL MEANING of the message, not just individual words
- KEY DISTINCTION: Casual responses like "doing good", "I'm good", "that's good" = NO. Only explicit requests with action words = YES

Examples:
- "email me the report" → yes (explicit request with action word)
- "generate my report" → yes (explicit request with action word)
- "generate my report now" → yes (explicit request with action word)
- "end chat" → yes (explicit request with action word)
- "finish conversation" → yes (explicit request with action word)
- "I want to end the chat" → yes (explicit request with action word)
- "that's it for today" → yes (clear ending intent with "that's it")
- "I'm done" → yes (clear ending statement)
- "we're done here" → yes (clear ending statement)
- "doing good for now" → no (casual response to question, NOT a request)
- "I'm good" → no (casual response, NOT a request - only YES if clearly saying "I'm done/I'm finished")
- "I'm good for now" → no (casual response, NOT a request - only YES if context shows clear ending intent)
- "that's good" → no (acknowledgment, not a request)
- "ok" / "okay" → no (acknowledgment)
- "thanks" → no (gratitude, not a request)
- "sounds good" → no (agreement, not a request)
- "by the end of the day" → no (talking about time, not ending chat)
- "today will end" → no (talking about the day, not ending chat)
- "exit to my world" → no (talking about going somewhere, not ending chat)
- "work can be anything" → no (talking about work, not ending chat)
- "my chest hurt ends and i start conversation im my head write it down and then generate its report" → no (describing experience/process, NOT requesting)
- "generate its report" → no (describing a process, NOT requesting)
- "write it down and then generate its report" → no (describing steps, NOT requesting)
- "I think that's it" → no (ambiguous, could mean "that's my answer")
- Any question or statement → no (unless explicitly about ending/generating report with action words)

Reply:`;

  console.log(
    "[detectUserWantsToEndOrGenerateReport] Falling back to LLM classifier"
  );

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "")
      .toLowerCase()
      .trim();

    const result = txt.includes("yes");
    console.log(
      "[detectUserWantsToEndOrGenerateReport] LLM classifier result:",
      result,
      "(response:",
      txt,
      ")"
    );

    return result;
  } catch (err) {
    console.error("[detectUserWantsToEndOrGenerateReport] ❌ LLM error", err);
    return false;
  }
}

// Discovery-mode intent detection: separate "end/pause chat" from "generate report"
// so we can respect "I'm done for now" WITHOUT asking more questions, while still supporting explicit report requests.
export async function detectDiscoveryEndIntents({
  userMessage,
  transcript = [],
  lastAssistantMessage = "",
}) {
  if (!userMessage) {
    return { endChat: false, generateReport: false };
  }

  const prompt = `
You are an intent classifier for a discovery follow-up chat.

User's latest message: "${userMessage}"
Last assistant message: "${lastAssistantMessage || "N/A"}"

Recent conversation context (last 5 messages):
${JSON.stringify((Array.isArray(transcript) ? transcript : []).slice(-5), null, 2)}

Return ONLY valid JSON in this exact format:
{
  "endChat": boolean,
  "generateReport": boolean
}

Rules:
- "endChat" is true if the user clearly wants to stop/pause/end for now (e.g., "end chat", "stop", "pause", "I'm done for now", "I'm done", "I'm finished").
- "generateReport" is true ONLY if the user explicitly requests a report/email (e.g., "generate report", "email me the report", "send the report")
  OR if the last assistant message clearly said they are ready to generate the discovery report AND the user confirms (e.g., "go ahead", "yes", "do it").
- If the user says "I'm done for now" without mentioning report/email, set generateReport=false.
- Be strict. When unsure, set generateReport=false.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 80,
      response_format: { type: "json_object" },
    });
    const raw = resp?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return {
      endChat: parsed.endChat === true,
      generateReport: parsed.generateReport === true,
    };
  } catch (err) {
    console.error("[detectDiscoveryEndIntents] ❌ LLM error", err);
    // Fail safe: do not force report generation on error.
    return { endChat: false, generateReport: false };
  }
}

// LLM-based detection: Combined intent classifier to save calls
export async function detectCombinedIntents({
  userMessage,
  transcript = [],
  lastAssistantQuestion = "",
}) {
  if (!userMessage) {
    return {
      wantsNewDiagnostic: false,
      isAnswer: false,
      wantsToEndOrGenerate: false,
    };
  }

  // Check for assistant ready to generate state
  const assistantSaysReadyToGenerate =
    /(I have|have enough|enough to generate|generate.*diagnostic|ready to generate|can generate|will generate)/i.test(
      lastAssistantQuestion
    );

  const prompt = `
You are an intent classifier for a wellness chatbot. Analyize the user's latest message and the provided context.
User's latest message: "${userMessage}"
Last Assistant Question: "${lastAssistantQuestion || "N/A"}"

Recent conversation context (last 3 messages):
${JSON.stringify(transcript.slice(-3), null, 2)}

Return ONLY a valid JSON object with these exactly 3 boolean flags:
{
  "wantsNewDiagnostic": boolean,
  "isAnswer": boolean,
  "wantsToEndOrGenerate": boolean
}

RULES for "wantsNewDiagnostic":
- "yes" ONLY if user EXPLICITLY wants to start a BRAND NEW diagnostic from scratch (e.g., "start new diagnostic", "reset everything").
- If assistant is ready to generate and user says "yes" or "go ahead", this is NO (they want to generate CURRENT report).

RULES for "isAnswer":
- "yes" if the message attempts to answer the last assistant question.
- "no" if it is just a question back, a request for clarification, or completely unrelated.
- Short answers like "yes", "alone", "at home" are DEFINITELY answers.

RULES for "wantsToEndOrGenerate":
- "yes" if user EXPLICITLY wants to end, finish, stop, generate report, or email report.
- "no" for casual responses like "doing good", "I'm good", or "thanks".
- "no" if they just want a NEW diagnostic.
- If assistant just said they are ready and user says "generate it", this is YES.

REPLY ONLY WITH JSON.`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 60,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(resp?.choices?.[0]?.message?.content || "{}");
    console.log("[detectCombinedIntents] result:", result);

    return {
      wantsNewDiagnostic: result.wantsNewDiagnostic === true,
      isAnswer: result.isAnswer === true,
      wantsToEndOrGenerate: result.wantsToEndOrGenerate === true,
    };
  } catch (err) {
    console.error("[detectCombinedIntents] ❌ LLM error", err);
    return {
      wantsNewDiagnostic: false,
      isAnswer: true, // Default to answer to be safe
      wantsToEndOrGenerate: false,
    };
  }
}

// LLM-based detection: Check if bot's message signals the conversation should end
export async function detectBotSignaledEnd({
  lastAssistantMessage,
  transcript = [],
}) {
  if (!lastAssistantMessage?.content) return false;

  const msgContent = lastAssistantMessage.content;

  // CRITICAL: If the message contains a question mark (especially at the end) or asks for input,
  // it's very likely continuing the conversation, NOT ending it
  const hasQuestion =
    /\?[\s]*$/.test(msgContent) || /\?[\s]*\n/.test(msgContent);
  const asksPhrases =
    /(feel free to share|what do you|how do you|can you|tell me|share your|answer that|what happened|what was)/i.test(
      msgContent
    );

  if (hasQuestion || asksPhrases) {
    // Only proceed if there are also strong end signals - otherwise return false
    const strongEndSignals =
      /(we'll pause here|pause here and let this integrate|let this integrate|reached today's integration limit|we stop here|this is enough for today|let this settle|work is complete|going to generate|lock this into.*report)/i;
    if (!strongEndSignals.test(msgContent)) {
      return false;
    }
  }

  const prompt = `
You are a binary classifier. Determine if the assistant's message signals that the conversation should end.

Assistant's last message: "${msgContent}"

Recent conversation (last 3 messages):
${JSON.stringify(transcript.slice(-3), null, 2)}

IMPORTANT: The assistant is ENDING the conversation ONLY if it uses explicit closure phrases like:
- "We'll pause here and let this integrate"
- "pause here and let this integrate"
- "let this integrate"
- "You've reached today's integration limit"
- "reached today's integration limit"
- "Let this settle — we'll continue tomorrow"
- "we stop here"
- "This is enough for today"
- "No more work is required"
- "the work is complete"
- "I'm going to generate your report"
- "lock this into a clean Euphoriam diagnostic report"

CRITICAL: If the assistant is ASKING A QUESTION (e.g., "How does this feel?", "What happened?", "Can you share?", "Feel free to share your thoughts"), the answer is ALWAYS "no".
CRITICAL: If the message ends with a question mark (?), the answer is almost always "no".
CRITICAL: Phrases like "Thank you for your response" followed by more questions are NOT end signals.

Rules:
- Reply ONLY "yes" or "no"
- "yes" ONLY if the assistant clearly signals the conversation should end or pause with explicit closure language
- "no" if the assistant is asking another question, requesting input, or continuing the conversation

Reply:`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "")
      .toLowerCase()
      .trim();
    return txt.includes("yes");
  } catch (err) {
    console.error("[detectBotSignaledEnd] error", err);
    return false;
  }
}

// LLM-based detection: Check if user has "replied perfectly" (conversation is complete)
export async function detectConversationComplete({
  transcript = [],
  lastUserMessage,
  lastAssistantMessage,
}) {
  console.log("[detectConversationComplete] invoked");

  if (!transcript.length || !lastUserMessage) {
    console.log(
      "[detectConversationComplete] early exit → missing transcript or lastUserMessage"
    );
    return false;
  }

  console.log("[detectConversationComplete] lastUserMessage:", lastUserMessage);
  console.log(
    "[detectConversationComplete] lastAssistantMessage:",
    lastAssistantMessage
  );

  // 1. Check if bot explicitly signaled end
  const botSignaledEnd = await detectBotSignaledEnd({
    lastAssistantMessage,
    transcript,
  });

  console.log("[detectConversationComplete] botSignaledEnd:", botSignaledEnd);

  // 2. Bot signaled end → require explicit user confirmation
  if (botSignaledEnd && lastUserMessage) {
    const userText =
      typeof lastUserMessage === "string"
        ? lastUserMessage.trim()
        : lastUserMessage?.content?.trim?.() || "";

    const isExplicitConfirmation =
      /^(yes|yeah|yep|ok|okay|sure|go ahead|do it|generate|email|send)$/i.test(
        userText
      );

    console.log("[detectConversationComplete] userText:", userText);
    console.log(
      "[detectConversationComplete] isExplicitConfirmation:",
      isExplicitConfirmation
    );

    if (isExplicitConfirmation) {
      console.log(
        "[detectConversationComplete] ✅ COMPLETE → bot signaled end + user explicitly confirmed"
      );
      return true;
    }

    console.log(
      "[detectConversationComplete] ❌ bot signaled end but user did NOT explicitly confirm"
    );
    return false;
  }

  // 3. LLM-based conservative classifier
  console.log("[detectConversationComplete] falling back to LLM classifier");

  const prompt = `
You are a binary classifier. Determine if the user has EXPLICITLY indicated they want to END the conversation or GENERATE A REPORT.

Last assistant message: "${lastAssistantMessage?.content || "N/A"}"

Last user message: "${lastUserMessage?.content || ""}"

Recent conversation (last 5 messages):
${JSON.stringify(transcript.slice(-5), null, 2)}

CRITICAL RULES (be EXTREMELY conservative - default to "no"):
- Reply ONLY "yes" or "no"
- Return "yes" ONLY if the user EXPLICITLY says: "generate report", "email report", "end chat", "that's it for today", "I'm done", "finish up"
- If the assistant asked a question and user responded, return "no"
- When in doubt, ALWAYS return "no"

Reply:
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });

    const txt =
      resp?.choices?.[0]?.message?.content?.toLowerCase()?.trim() || "";

    console.log("[detectConversationComplete] LLM raw response:", txt);

    const result = txt.includes("yes");

    console.log(
      "[detectConversationComplete] LLM decision:",
      result ? "COMPLETE" : "NOT COMPLETE"
    );

    return result;
  } catch (err) {
    console.error("[detectConversationComplete] ❌ LLM error", err);
    return false;
  }
}

// LLM-based detection: Check if discovery transcript has enough information to generate a relevant report,
// and infer the user's current stage (short label) for downstream use.
export async function detectDiscoveryReportReadiness({ transcript = [] }) {
  try {
    const recent = Array.isArray(transcript) ? transcript.slice(-20) : [];
    const prompt = `
You are a strict readiness checker for a "discovery follow-up" conversation.

Goal:
- Decide if there is ENOUGH information in the transcript to generate a RELEVANT discovery report.
- Infer the user's CURRENT STAGE (a short label) from what they shared.

Transcript (latest messages last):
${JSON.stringify(recent, null, 2)}

Return ONLY valid JSON in this exact shape:
{
  "ready": boolean,
  "stageLabel": string,          // 3-7 words. If unclear, use "Unknown"
  "stageEvidence": string,       // 1 sentence citing what in the transcript supports the stage
  "missingInfo": string[],       // 0-5 short items
  "nextQuestions": string[]      // 0-2 concise questions to ask next (ONLY if ready=false)
}

Strict rules:
- "ready" is true ONLY if the transcript contains:
  1) a clear description of what's happening in their life NOW (not just generic "good/bad"),
  2) at least one concrete shift since their last diagnostic/discovery (what changed),
  3) at least one current friction/loop/avoidance pattern (what still blocks),
  4) at least one desired direction / what they want next.
- If any of these 4 are missing, set ready=false and list the missing items.
- If user answers are extremely short / non-substantive, treat as missing.
- If ready=false, provide up to 2 best nextQuestions that would unlock readiness fastest.
  * The questions MUST map directly to the missingInfo items.
  * Ask for CONTEXT and PATTERN, not coaching/action-plans.
  * Avoid: "what small step can you take", "what actionable step", "how will you do it".
  * Prefer questions like:
    - "Where is this showing up most right now (work/relationship/body)?"
    - "What happens right before you do the pattern (trigger → response)?"
    - "What do you want instead in the next 7–14 days?"
- stageLabel must be grounded in the transcript; do not invent.
`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 220,
      response_format: { type: "json_object" },
    });

    const raw = resp?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    return {
      ready: parsed.ready === true,
      stageLabel: typeof parsed.stageLabel === "string" ? parsed.stageLabel : "Unknown",
      stageEvidence:
        typeof parsed.stageEvidence === "string" ? parsed.stageEvidence : "",
      missingInfo: Array.isArray(parsed.missingInfo)
        ? parsed.missingInfo.filter((x) => typeof x === "string").slice(0, 5)
        : [],
      nextQuestions: Array.isArray(parsed.nextQuestions)
        ? parsed.nextQuestions.filter((x) => typeof x === "string").slice(0, 2)
        : [],
    };
  } catch (err) {
    console.error("[detectDiscoveryReportReadiness] ❌ LLM error", err);
    // Fail safe: do NOT block report generation if the readiness check fails unexpectedly.
    return {
      ready: true,
      stageLabel: "Unknown",
      stageEvidence: "",
      missingInfo: [],
      nextQuestions: [],
    };
  }
}

export async function handleFinalize(req, res, input, context) {
  if (context.hasExistingReport) {
    return finalizeDiscoveryFollowUp(req, res, input, context);
  }

  return finalizeNewDiagnostic(req, res, input, context);
}

