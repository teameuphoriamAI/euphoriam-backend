/** Green Rep names are short task labels — not proof sentences. */
const isPlausibleGreenRepName = (name) => {
  const n = String(name || "").trim();
  if (!n || n.length < 2 || n.length > 55) return false;
  if (n.split(/\s+/).length > 7) return false;
  if (/\d+\s*dollar|\$|\/hr|per hour|an hour|an hr\b/i.test(n)) return false;
  if (/\b(generated|earned|successfully|that i|i competed|i completed)\b/i.test(n)) {
    return false;
  }
  return true;
};

module.exports = { isPlausibleGreenRepName };
