import { Diagnostic } from "../models/diagnosticModel.js";
import { Discovery } from "../models/discoveryModel.js";
import { Prompt } from "../models/promptModel.js";
import { User } from "../models/userModel.js";
import validate from "../helpers/validate.js";
import openai from "../config/openai.js";

import {
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
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
  const alpha = t.match(/[A-Za-z]/g);
  // Relaxed: Allow short answers to pass to the AI classifier
  if (!alpha || alpha.length < 1) return false;

  const prompt = `
You are a binary classifier. Decide if the user's reply is an *answer* to the given question.

Question: "${question || "N/A"}"
Reply: "${reply}"

Rules:
- Reply only "yes" or "no".
- "yes" if the reply attempts to answer; "no" if it is just a question, "I don't know", or unrelated.
`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 3,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "").toLowerCase();
    return txt.includes("yes");
  } catch (err) {
    console.error("[isAiLikelyAnswer] fallback to heuristic", err);
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
    targetCount = 12,
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

  return date
    ? new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;
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
// LLM-based detection: Check if user wants to end chat or generate report
export async function detectUserWantsToEndOrGenerateReport({
  userMessage,
  transcript = [],
}) {
  const lowerMessage = (userMessage || "").toLowerCase();
  
  // Quick check for explicit email/report requests (before AI check)
  const explicitEmailReportRequest = 
    /(email|send).*(me|the|my).*(report|it)/i.test(userMessage) ||
    /(generate|create|make|get).*(report|it).*(and|then).*(email|send)/i.test(userMessage) ||
    /(end|finish|stop).*(chat|conversation).*(and|then).*(email|send|generate)/i.test(userMessage);
  
  if (explicitEmailReportRequest) {
    return true; // Immediately return true for explicit requests
  }
  
  const prompt = `
You are a binary classifier. Analyze the user's message and determine if they want to:
1. End the chat/conversation
2. Generate a report
3. Get a report
4. Finish the conversation
5. Email the report
6. Send the report

User's latest message: "${userMessage || ""}"

Recent conversation context (last 3 messages):
${JSON.stringify(transcript.slice(-3), null, 2)}

Rules:
- Reply ONLY "yes" or "no"
- "yes" if the user is asking to end, finish, stop, generate report, get report, email report, send report, or wants their report
- "no" if they're just answering questions or continuing the conversation
- Be sensitive to variations like "give me my report", "I want the report", "can I get a report", "email me the report", "send the report", "end this", "finish up", etc.

Reply:`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 3,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "")
      .toLowerCase()
      .trim();
    return txt.includes("yes");
  } catch (err) {
    console.error("[detectUserWantsToEndOrGenerateReport] error", err);
    return false;
  }
}

// LLM-based detection: Check if bot's message signals the conversation should end
export async function detectBotSignaledEnd({
  lastAssistantMessage,
  transcript = [],
}) {
  if (!lastAssistantMessage?.content) return false;

  const prompt = `
You are a binary classifier. Determine if the assistant's message signals that the conversation should end.

Assistant's last message: "${lastAssistantMessage.content}"

Recent conversation (last 3 messages):
${JSON.stringify(transcript.slice(-3), null, 2)}

Look for phrases like:
- "This is enough for today"
- "No more work is required"
- "We stop here"
- "This is enough"
- "We stop here and let this land"
- "For now: you're not stuck"
- "I'm going to lock this into a clean Euphoriam diagnostic report"
- "lock this into a clean Euphoriam diagnostic report"
- "generate a report"
- "generate your updated diagnostic report"
- "We'll pause here. Let this settle."
- "I'm going to generate"
- Any indication that the session is concluding or a report should be generated

Rules:
- Reply ONLY "yes" or "no"
- "yes" if the assistant clearly signals the conversation should end or pause
- "no" if the assistant is asking another question or continuing the conversation
- Be sensitive to natural ending phrases

Reply:`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 3,
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
  if (!transcript.length || !lastUserMessage) return false;

  // First check if bot signaled end - if so, any user response should trigger completion
  const botSignaledEnd = await detectBotSignaledEnd({
    lastAssistantMessage,
    transcript,
  });

  if (botSignaledEnd && lastUserMessage) {
    // Bot signaled end, user responded - conversation is complete
    return true;
  }

  const prompt = `
You are a binary classifier. Determine if the user has "replied perfectly" - meaning they have:
1. Fully answered the assistant's question
2. Provided a complete response
3. The conversation feels naturally complete (not cut off or incomplete)
4. The user seems satisfied with their answer

Last assistant message: "${lastAssistantMessage?.content || "N/A"}"

Last user message: "${lastUserMessage?.content || ""}"

Recent conversation (last 5 messages):
${JSON.stringify(transcript.slice(-5), null, 2)}

Rules:
- Reply ONLY "yes" or "no"
- "yes" if the user's reply is complete, thorough, and the conversation feels naturally finished
- "no" if the reply is incomplete, partial, or the conversation should continue
- Consider context: short answers can be "perfect" if they fully address the question
- If the assistant just asked a question and user answered, usually "no" (conversation continues)
- If the assistant gave a final correction/ending and user responded, usually "yes" (conversation complete)

Reply:`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 3,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "")
      .toLowerCase()
      .trim();
    return txt.includes("yes");
  } catch (err) {
    console.error("[detectConversationComplete] error", err);
    return false;
  }
}

export async function handleFinalize(req, res, input, context) {
  if (context.hasExistingReport) {
    return finalizeDiscoveryFollowUp(req, res, input, context);
  }

  return finalizeNewDiagnostic(req, res, input, context);
}
