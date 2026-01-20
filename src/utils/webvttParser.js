/**
 * Parses WEBVTT (Web Video Text Tracks) format into transcript format
 * Converts WEBVTT cues into array of {role, content} objects
 * 
 * @param {string} webvttText - The WEBVTT formatted text
 * @param {Object} options - Optional configuration
 * @param {Array<string>} options.coachNames - Array of coach/speaker names to identify as "assistant" role
 * @returns {Array} Array of {role, content, speaker} objects
 */
const parseWebVTT = (webvttText, options = {}) => {
  if (!webvttText || typeof webvttText !== "string") {
    throw new Error("WEBVTT text is required");
  }

  const { coachNames = [] } = options;

  // Remove WEBVTT header if present
  let text = webvttText.trim();
  if (text.startsWith("WEBVTT")) {
    text = text.replace(/^WEBVTT\s*\n?/i, "");
  }

  // Split into cue blocks
  // WEBVTT format: number, timestamp, text (can span multiple lines)
  const cueBlocks = [];
  const lines = text.split("\n");
  let currentCue = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines at the start
    if (!line && !currentCue) continue;

    // Check if this is a cue number (just digits)
    if (/^\d+$/.test(line)) {
      // Save previous cue if exists
      if (currentCue) {
        cueBlocks.push(currentCue);
      }
      currentCue = { number: line, lines: [] };
      continue;
    }

    // Check if this is a timestamp line (contains -->)
    if (line.includes("-->")) {
      if (currentCue) {
        currentCue.timestamp = line;
      } else {
        // Timestamp without number, create new cue
        currentCue = { timestamp: line, lines: [] };
      }
      continue;
    }

    // This is content text
    if (currentCue) {
      if (line) {
        currentCue.lines.push(line);
      }
    } else {
      // Content without cue structure, create new cue
      currentCue = { lines: [line] };
    }

    // If next line is empty or a number, finalize this cue
    const nextLine = i < lines.length - 1 ? lines[i + 1].trim() : "";
    if (!nextLine || /^\d+$/.test(nextLine)) {
      if (currentCue && currentCue.lines.length > 0) {
        cueBlocks.push(currentCue);
        currentCue = null;
      }
    }
  }

  // Don't forget the last cue
  if (currentCue && currentCue.lines.length > 0) {
    cueBlocks.push(currentCue);
  }

  const transcript = [];
  let lastSpeaker = null;

  for (const cue of cueBlocks) {
    if (!cue.lines || cue.lines.length === 0) continue;

    const fullText = cue.lines.join(" ").trim();
    if (!fullText) continue;

    // Extract speaker name (format: "Speaker Name: text")
    const speakerMatch = fullText.match(/^([^:]+):\s*(.+)$/);

    if (speakerMatch) {
      const speakerName = speakerMatch[1].trim();
      const content = speakerMatch[2].trim();

      // Determine role based on speaker name
      // Check against provided coach names or common patterns
      const isCoach =
        coachNames.some((name) =>
          speakerName.toLowerCase().includes(name.toLowerCase())
        ) ||
        /nathan|coach|therapist|counselor|facilitator/i.test(speakerName);

      const role = isCoach ? "assistant" : "user";
      lastSpeaker = speakerName;

      transcript.push({
        role,
        content,
        speaker: speakerName, // Keep speaker name for reference
      });
    } else {
      // No speaker name in this line
      // Use last known speaker or default to user
      const role = lastSpeaker && coachNames.some((name) =>
        lastSpeaker.toLowerCase().includes(name.toLowerCase())
      ) ? "assistant" : "user";

      transcript.push({
        role,
        content: fullText,
        speaker: lastSpeaker || "Unknown",
      });
    }
  }

  return transcript;
};

module.exports = { parseWebVTT };

