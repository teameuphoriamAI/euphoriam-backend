/**
 * Normalize success_strategy from DB / extraction shapes (string, object, or loose fields).
 */
const normalizeSuccessStrategy = (source = {}) => {
  if (!source || typeof source !== "object") return null;

  let ss = source.success_strategy;

  if (typeof ss === "string" && ss.trim()) {
    return { title: "Success strategy", behaviour: ss.trim(), behaviours: [] };
  }

  if (ss && typeof ss === "object" && !Array.isArray(ss)) {
    const behaviour = ss.behaviour || ss.behavior || ss.belief || "";
    const behaviours = Array.isArray(ss.behaviours)
      ? ss.behaviours.filter(Boolean)
      : Array.isArray(ss.behaviors)
        ? ss.behaviors.filter(Boolean)
        : [];
    const belief = ss.belief || ss.opposite_belief || null;
    const successRule = ss.success_rule || ss.successRule || null;
    if (behaviour || behaviours.length || belief || successRule) {
      return {
        title: ss.title || "Success strategy",
        behaviour: behaviour ? String(behaviour) : "",
        belief: belief ? String(belief) : undefined,
        success_rule: successRule ? String(successRule) : undefined,
        behaviours,
      };
    }
  }

  const behaviour =
    source.opposite_behaviour ||
    source.opposite_behavior ||
    source.recommended_resource ||
    null;
  const belief = source.opposite_belief || null;
  const successRule = source.success_rule || null;

  if (behaviour || belief || successRule) {
    return {
      title: "Success strategy",
      behaviour: behaviour ? String(behaviour) : "",
      belief: belief ? String(belief) : undefined,
      success_rule: successRule ? String(successRule) : undefined,
      behaviours: [],
    };
  }

  return null;
};

module.exports = { normalizeSuccessStrategy };
