/**
 * Deterministic structure type from Map Resistance / diagnostic fields.
 *
 * Priority:
 *  1. Something's Wrong With Me — self-blame + high contradiction or CL < 1.5
 *  2. Towards & Away — oscillation (attach→withdraw, etc.)
 *  3. Progress with Snapback — movement then collapse
 *  4. Orbit — default (repeated circling)
 */
const inferStructureType = ({
  orbit_pattern = "",
  recovery_speed = "",
  contradiction_rate = "",
  current_loop = "",
  CL_estimate = null,
} = {}) => {
  const op = String(orbit_pattern || "").toLowerCase();
  const cl = String(current_loop || "").toLowerCase();
  const combined = `${op} ${cl}`;

  const selfBlameKeywords = [
    "wrong with me",
    "broken",
    "shame",
    "self-blame",
    "self blame",
    "worthless",
    "not enough",
    "never enough",
    "failure",
    "defective",
    "fault",
    "my fault",
    "blame myself",
  ];
  const hasSelfBlame = selfBlameKeywords.some((kw) => combined.includes(kw));
  const clNum = typeof CL_estimate === "number" ? CL_estimate : parseFloat(CL_estimate);
  const isVeryLowCL = !Number.isNaN(clNum) && clNum < 1.5;
  const isHighContradiction = String(contradiction_rate || "").toLowerCase() === "high";

  if (hasSelfBlame && (isHighContradiction || isVeryLowCL)) {
    return "Something's Wrong With Me";
  }

  const towardsAwayPatterns = [
    /attach.*withdraw/,
    /test.*withdraw/,
    /ask.*withdraw/,
    /announce.*withdraw/,
    /reach.*pull.?back/,
    /open.*close/,
    /connect.*retreat/,
    /approach.*retreat/,
    /move.*toward.*pull.?back/,
    /engage.*disengage/,
    /start.*stop.*start/,
    /commit.*bail/,
    /invest.*pull.?out/,
    /hide.*panic/,
    /ask.*panic/,
  ];
  if (towardsAwayPatterns.some((re) => re.test(op))) {
    return "Towards & Away";
  }

  const snapbackPatterns = [
    /progress.*collapse/,
    /prove.*crash/,
    /overwork.*crash/,
    /freeze.*scramble.*crash/,
    /build.*collapse/,
    /grow.*crash/,
    /advance.*crash/,
    /momentum.*crash/,
    /win.*lose.*win.*lose/,
    /succeed.*sabotage/,
    /almost.*then.*back/,
    /close.*then.*retreat/,
    /nearly.*then.*collapse/,
    /push.*then.*crash/,
    /move.*then.*snap.?back/,
    /rise.*fall/,
    /up.*down.*up.*down/,
  ];
  if (snapbackPatterns.some((re) => re.test(op))) {
    return "Progress with Snapback";
  }

  void recovery_speed;
  return "Orbit";
};

module.exports = { inferStructureType };
