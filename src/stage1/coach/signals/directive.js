const formatOutcomeDirective = (signalKey, { goal, yourJob, avoid = [] }) => {
  const job = (Array.isArray(yourJob) ? yourJob : [yourJob]).filter(Boolean).join("; ");
  const avoidStr = avoid.length ? ` | AVOID: ${avoid.join("; ")}` : "";
  return `SIGNAL:${signalKey} | GOAL: ${goal} | JOB: ${job}${avoidStr}`;
};

module.exports = { formatOutcomeDirective };
