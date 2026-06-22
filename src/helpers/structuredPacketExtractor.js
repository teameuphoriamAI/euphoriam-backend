const openai = require("../config/openai");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");
const { PromptType } = require("../utils/types");

const FALLBACK_EXTRACTION_PROMPT = `You are a data extraction engine for Euphoriam AI.
Read the report and transcript, extract only what is already present, and return ONE JSON object with:
diagnostic_packet, constraint_packet, optional_inputs (see Stage 1 constraint extraction schema).
Use null for missing fields. Return ONLY valid JSON — no markdown.`;

const getExtractionPrompt = async () => {
  const row = await withDbSlot(() =>
    Prompt.findOne({
      where: { type: PromptType.STAGE1_CONSTRAINT_EXTRACTION, isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true,
    }),
  );
  return row?.content || FALLBACK_EXTRACTION_PROMPT;
};

const formatTranscript = (transcript) => {
  if (!transcript) return "";
  if (typeof transcript === "string") return transcript;
  if (Array.isArray(transcript)) {
    return transcript
      .map((m) => {
        const role = m.role || m.sender || "user";
        const content = m.content ?? m.message ?? m.text ?? "";
        return `${role}: ${content}`;
      })
      .join("\n");
  }
  return JSON.stringify(transcript, null, 2);
};

/**
 * Funnel / Map Resistance fallback: LLM structured packet from report + transcript.
 * @returns {{ diagnostic_packet: object, constraint_packet: object, optional_inputs: object }}
 */
const extractStructuredPacket = async ({ reportText = "", transcript = [] }) => {
  const systemContent = await getExtractionPrompt();
  const transcriptText = formatTranscript(transcript);

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      {
        role: "user",
        content: `REPORT:\n${reportText}\n\nTRANSCRIPT:\n${transcriptText}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_completion_tokens: 4000,
  });

  const raw = response?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  return {
    diagnostic_packet: parsed.diagnostic_packet || {},
    constraint_packet: parsed.constraint_packet || {},
    optional_inputs: parsed.optional_inputs || {},
  };
};

const { inferStructureType } = require("./stage1InferStructureType");

module.exports = {
  extractStructuredPacket,
  formatTranscript,
  inferStructureType,
};
