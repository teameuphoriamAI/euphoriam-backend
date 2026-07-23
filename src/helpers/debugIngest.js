/** Debug session ingest (agent). Remove after verification. */
const DEBUG_INGEST =
  process.env.DEBUG_INGEST_URL ||
  "http://host.docker.internal:7276/ingest/a6c3c50f-2380-49c9-8118-307947533aae";

const debugIngest = (location, message, data, hypothesisId) => {
  // #region agent log
  fetch(DEBUG_INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "cbefd4",
    },
    body: JSON.stringify({
      sessionId: "cbefd4",
      location,
      message,
      data,
      hypothesisId,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
};

module.exports = { debugIngest };
