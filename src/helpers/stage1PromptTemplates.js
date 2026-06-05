/**
 * Placeholder substitution for admin prompt templates — no product copy here.
 * Templates use {{key}} tokens (e.g. {{first_name}}, {{goal}}).
 */

const applyPromptTemplate = (template, vars = {}) => {
  if (!template || typeof template !== "string") return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val == null ? "" : String(val);
  });
};

const pickTemplateSection = (template, sectionName) => {
  if (!template || typeof template !== "string") return "";
  const marker = `===${sectionName}===`;
  const start = template.indexOf(marker);
  if (start < 0) return template.trim();
  const after = template.slice(start + marker.length);
  const next = after.search(/^===[A-Z_]+===/m);
  return (next >= 0 ? after.slice(0, next) : after).trim();
};

const parseAdvanceFallbacks = (raw) => {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map(([title, template]) => [String(title), String(template)]);
  } catch {
    return [];
  }
};

const PROMPT_NOT_CONFIGURED =
  "This flow is not configured yet. An admin must activate the required prompt in the Prompts tab.";

module.exports = {
  applyPromptTemplate,
  pickTemplateSection,
  parseAdvanceFallbacks,
  PROMPT_NOT_CONFIGURED,
};
