/**
 * Green Rep latching — detect rep in prose, HOLD replies, strip early/double assigns.
 */

const REP_IN_TEXT_PATTERN =
  /\b(?:today'?s\s+(?:rep|next\s+step)|your\s+rep\s+for\s+today|your\s+(?:next\s+)?(?:step|green\s+rep)|green\s+rep\s+is|next\s+step\s+is\s+to\s+do\s+the)\b/i;

const WIN_CONDITION_PATTERN = /\byou\s+win\s+if\b/i;

const QUOTED_REP_NAME_PATTERN = /"([^"]{3,80})"/;

const hasQuotedRepName = (text = "") => {
  const s = String(text || "");
  if (!QUOTED_REP_NAME_PATTERN.test(s)) return false;
  const names = parseRepNamesFromText(s);
  return names.length > 0;
};

/** True only when a structured rep was named (quoted name or explicit your-rep-for-today). */
const assistantAlreadyAssignedRep = (messages = []) =>
  (messages || []).some((m) => {
    if (m?.role !== "assistant") return false;
    const c = String(m.content || "");
    if (/your rep for today is/i.test(c) && hasQuotedRepName(c)) return true;
    if (/today'?s\s+(?:rep|next\s+step)/i.test(c) && hasQuotedRepName(c)) return true;
    if (/green\s+rep\s+is/i.test(c) && hasQuotedRepName(c)) return true;
    return false;
  });

const parseRepNamesFromText = (text = "") => {
  const names = [];
  const s = String(text || "");
  let match;
  const quoted = /"([^"]{3,80})"/g;
  while ((match = quoted.exec(s)) !== null) {
    const name = match[1].trim();
    if (
      /\b(conversation|touch|message|outreach|client|follow|call|visible|milestone|rep|action|block)\b/i.test(
        name,
      ) &&
      !/\b(fear|rejection|protector|enough|pushy|desperate)\b/i.test(name)
    ) {
      names.push(name);
    }
  }
  const explicit = [...s.matchAll(/today'?s\s+rep\s+is\s+"([^"]+)"/gi)].map((m) => m[1].trim());
  for (const n of explicit) {
    if (!names.includes(n)) names.push(n);
  }
  const nextStep = [...s.matchAll(/today'?s\s+next\s+step\s+is\s+to\s+do\s+the\s+"([^"]+)"/gi)].map(
    (m) => m[1].trim(),
  );
  for (const n of nextStep) {
    if (!names.includes(n)) names.unshift(n);
  }
  const yourRep = [...s.matchAll(/your rep for today is\s+"([^"]+)"/gi)].map((m) => m[1].trim());
  for (const n of yourRep) {
    if (!names.includes(n)) names.unshift(n);
  }
  return names;
};

const parseStepsFromText = (text = "") => {
  const lines = String(text || "")
    .split(/\n/)
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((l) => l.length > 8 && l.length < 220);
  return lines.slice(0, 4);
};

const buildRepFromParsedName = (name, sourceText = "") => {
  if (!name) return null;
  const steps = parseStepsFromText(sourceText);
  const winMatch = String(sourceText || "").match(/\byou\s+win\s+if\s+([^.!?]+[.!?]?)/i);
  return {
    name,
    steps: steps.length ? steps : ["Take one visible step today."],
    win_condition: winMatch ? winMatch[1].trim() : null,
  };
};

/** Extract the primary latched rep from session history (first valid assign wins). */
const extractSessionRepFromMessages = (messages = [], openSession = null) => {
  if (openSession?.green_rep_last?.name) {
    return { name: openSession.green_rep_last.name, rep: openSession.green_rep_last, source: "session" };
  }
  for (const m of messages || []) {
    if (m?.role !== "assistant") continue;
    const content = String(m.content || "");
    if (!assistantAlreadyAssignedRep([m])) continue;
    const names = parseRepNamesFromText(content);
    if (names.length) {
      return {
        name: names[0],
        rep: buildRepFromParsedName(names[0], content),
        source: "transcript",
      };
    }
  }
  return null;
};

const isSessionRepLocked = (openSession = null, messages = []) =>
  Boolean(
    openSession?.session_rep_locked ||
      openSession?.green_rep_last?.name ||
      assistantAlreadyAssignedRep(messages),
  );

const PRESCRIPTIVE_TAIL_START =
  /\b(?:you'?re noticing the pattern clearly|you'?ve clearly named the pattern|the cost of this pattern|keeps your income capped|today'?s\s*(?:rep|next\s+step)?\s*:|today'?s\s*(?:rep|next\s+step)\b|you win if|this rep helps|ready to try this today|financially visible and clear|interrupting the avoidance pattern|prove you can stay steady)\b/i;

/** Remove rep-assignment blocks when arbiter says DISCOVER only. */
const stripUnauthorizedRepFromReply = (text = "") => {
  let s = String(text || "").trim();
  if (!PRESCRIPTIVE_TAIL_START.test(s) && !WIN_CONDITION_PATTERN.test(s)) return s;

  const cutAt = s.search(PRESCRIPTIVE_TAIL_START);
  if (cutAt > 80) {
    s = s.slice(0, cutAt).trim();
  } else if (cutAt >= 0) {
    s = "";
  }

  s = s
    .replace(/\bToday'?s\s*$/gim, "")
    .replace(/\n+\s*You win if[\s\S]*/gi, "")
    .replace(/\n+\s*This rep helps[\s\S]*/gi, "")
    .replace(/\n+\s*Ready to try this today\??\s*/gi, "")
    .replace(/\n+\s*Watch for your body's signals[\s\S]*/gi, "")
    .replace(/^\s*[-*•]\s+.+$/gm, (line) =>
      /\b(check for a reply|follow-up|log what|book a call|linkedin|email|dm|win if)\b/i.test(line)
        ? ""
        : line,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!s || s.length < 20) {
    return "What are you experiencing in your body when you think about sending that follow-up?";
  }
  return s;
};

/** Strip premature diagnosis on early discovery turns (turns 1–3). */
const stripEarlyPrescriptiveDiagnosis = (text = "", userTurns = 99) => {
  if (userTurns > 3) return String(text || "").trim();
  let s = String(text || "").trim();
  s = s
    .replace(/\bYou'?ve clearly named the pattern[^.!?\n]*[.!?]?\s*/gi, "")
    .replace(/\bYou'?re noticing the pattern clearly[^.!?\n]*[.!?]?\s*/gi, "")
    .replace(/\b[^.!?\n]*keeps your income capped[^.!?\n]*[.!?]?\s*/gi, "")
    .replace(/\bThe cost of this pattern[^.!?\n]*[.!?]?\s*/gi, "")
    .replace(/\bthat keeps your income capped\b[^.!?\n]*[.!?]?\s*/gi, "")
    .trim();
  if (!s || s.length < 15) {
    return "What do you notice in your body when you think about sending that follow-up?";
  }
  return s;
};

const INCOME_CLOSENESS_PATTERN = /\b(closeness starts to feel real|moment closeness)\b/i;

/** Replace relationship-flavoured discovery on income/wealth domains. */
const fixDomainDiscoveryReply = (text = "", domain = null) => {
  const d = String(domain || "").toLowerCase();
  if (!["income", "wealth", "money"].includes(d)) return String(text || "").trim();
  if (!INCOME_CLOSENESS_PATTERN.test(text)) return String(text || "").trim();
  return "What happens inside you right before you close the tab or delay the follow-up?";
};

/** Keep only the first rep mention; drop second assign block. */
const stripDoubleRepFromReply = (text = "") => {
  const s = String(text || "");
  const names = parseRepNamesFromText(s);
  if (names.length <= 1) return s.trim();

  const repBlocks = s.split(/\bToday'?s\s+rep\s+is\b/i);
  if (repBlocks.length > 2) {
    return `${repBlocks[0].trim()} Today's rep is${repBlocks[1]}`.trim();
  }

  const first = names[0];
  const second = names[1];
  const firstIdx = s.indexOf(`"${first}"`);
  const secondIdx = s.indexOf(`"${second}"`, firstIdx + first.length + 1);
  if (secondIdx > firstIdx) {
    return s.slice(0, secondIdx).replace(/[\s.:;,-]+$/, "").trim();
  }
  return s.trim();
};

const buildHoldReplyForUserMessage = (userMessage = "", rep = null) => {
  const repName = rep?.name || "your rep";
  const step =
    (Array.isArray(rep?.steps) && rep.steps[0]) ||
    rep?.win_condition ||
    "send one clear follow-up with a specific question.";
  const msg = String(userMessage || "").trim().toLowerCase();

  if (/\b(what exactly|what should i do first|one message or one call|what do i do first)\b/i.test(msg)) {
    return `Start with one message, not a call — that's the smallest step for "${repName}". ${step}`;
  }
  if (/^\s*i\s+don'?t\s+know\.?\s*$/i.test(msg) || msg === "idk") {
    return `You don't need certainty — pick one warm lead and send the follow-up from "${repName}". One sentence is enough.`;
  }
  if (/\b(watch for|protector|what should i watch|body when)\b/i.test(msg)) {
    return `While doing "${repName}", watch for chest tightness, stomach knot, or urge to close the laptop — that's the protector. Stay with the send anyway; you don't need a perfect reply.`;
  }
  if (/\b(next step|want the next step)\b/i.test(msg)) {
    return `Your rep for today is "${repName}": ${step}`;
  }
  if (/\b(try the follow-up|i'll try)\b/i.test(msg)) {
    return `Good — when the protector shows up during "${repName}", notice the pull-back without obeying it. One message sent beats perfect timing.`;
  }
  return null;
};

module.exports = {
  REP_IN_TEXT_PATTERN,
  assistantAlreadyAssignedRep,
  parseRepNamesFromText,
  buildRepFromParsedName,
  extractSessionRepFromMessages,
  isSessionRepLocked,
  stripUnauthorizedRepFromReply,
  stripEarlyPrescriptiveDiagnosis,
  fixDomainDiscoveryReply,
  stripDoubleRepFromReply,
  buildHoldReplyForUserMessage,
};
