const { DEFAULT_PROGRESS_METRICS } = require("./stage1State");

/**
 * Fill recovery_speed and avoidance_caught_count from domain map structure when missing.
 */
const enrichProgressMetricsFromMap = (map, progressMetrics) => {
  const base = typeof DEFAULT_PROGRESS_METRICS === "function"
    ? DEFAULT_PROGRESS_METRICS()
    : DEFAULT_PROGRESS_METRICS;
  const metrics = {
    ...base,
    ...(progressMetrics && typeof progressMetrics === "object" ? progressMetrics : {}),
  };

  const avoidList = Array.isArray(map?.top_3_avoidance_behaviours)
    ? map.top_3_avoidance_behaviours.filter((x) => x != null && String(x).trim())
    : [];
  const failureBehaviours = Array.isArray(map?.failure_strategy?.behaviours)
    ? map.failure_strategy.behaviours.filter((x) => x != null && String(x).trim())
    : [];
  const mappedCount = avoidList.length || failureBehaviours.length;

  if (!metrics.avoidance_caught_count && mappedCount > 0) {
    metrics.avoidance_caught_count = mappedCount;
  }

  const recoveryRaw =
    metrics.recovery_speed ||
    map?.recovery_speed ||
    null;

  if (recoveryRaw != null && String(recoveryRaw).trim()) {
    metrics.recovery_speed = formatRecoverySpeed(recoveryRaw);
  } else if (map?.orbit_pattern?.trim()) {
    metrics.recovery_speed = formatRecoverySpeed(map.orbit_pattern.trim());
  } else if (map?.lack_channel?.trim()) {
    metrics.recovery_speed = `Lack: ${map.lack_channel.trim()}`;
  } else if (map?.map_resistance_complete) {
    metrics.recovery_speed = "Baseline (track in Coach)";
  }

  return metrics;
};

const formatRecoverySpeed = (value) => {
  const s = String(value).trim();
  const lower = s.toLowerCase();
  if (lower === "fast" || lower === "moderate" || lower === "slow") {
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  return s;
};

module.exports = { enrichProgressMetricsFromMap, formatRecoverySpeed };
