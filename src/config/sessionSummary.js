const openai = require("./openai");

/**
 * Generate a comprehensive summary of a coaching session transcript
 * This summary will be used for discovery report generation and AI context
 * 
 * @param {Array} transcript - Array of message objects with role and content
 * @param {Object} options - Optional parameters
 * @param {Date} options.sessionDate - Date of the session
 * @returns {Promise<string>} Comprehensive summary of the session
 */
const generateSessionSummary = async (transcript, options = {}) => {
  try {
    if (!Array.isArray(transcript) || transcript.length === 0) {
      throw new Error("Transcript must be a non-empty array");
    }

    // Convert transcript to readable format
    const transcriptText = transcript
      .map((msg) => {
        const role = msg.role === "assistant" ? "Coach" : "Client";
        return `${role}: ${msg.content || ""}`;
      })
      .join("\n\n");

    const sessionDateStr = options.sessionDate
      ? new Date(options.sessionDate).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : "Not specified";

    const summaryPrompt = `You are analyzing a 1:1 coaching session transcript. Generate a comprehensive summary that captures ALL essential information that would be useful for future discovery reports and AI context.

CRITICAL REQUIREMENTS:
- Capture the client's current state, challenges, and what's happening in their life
- Identify key patterns, shifts, or new insights revealed during the session
- Note any changes in their structure, vortex status, or avoidance patterns
- Extract specific quotes, examples, or concrete details the client shared
- Highlight emotional states, breakthroughs, resistance, or significant moments
- Include any goals, commitments, or action items discussed
- Note the coach's observations, insights, or recommendations
- Capture relationship dynamics, communication patterns, or behavioral observations

The summary should be detailed enough that an AI can use it to:
1. Understand the client's current state without reading the full transcript
2. Identify patterns and shifts since their last diagnostic/discovery report
3. Update metrics and insights for discovery reports
4. Provide context-aware responses in future conversations

Session Date: ${sessionDateStr}

Transcript:
${transcriptText}

Generate a comprehensive summary (aim for 500-1000 words) that captures all essential information:`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an expert at analyzing coaching sessions and extracting essential information for report generation and AI context. Generate comprehensive, detailed summaries that capture all important details, patterns, and insights.",
        },
        {
          role: "user",
          content: summaryPrompt,
        },
      ],
      temperature: 0.3, // Lower temperature for more consistent, factual summaries
      max_completion_tokens: 2000, // Allow for detailed summaries
    });

    const summary =
      response?.choices?.[0]?.message?.content?.trim() || "";

    if (!summary) {
      throw new Error("Failed to generate summary - empty response from AI");
    }

    return summary;
  } catch (error) {
    console.error("[generateSessionSummary] Error:", error);
    throw error;
  }
};

module.exports = { generateSessionSummary };

