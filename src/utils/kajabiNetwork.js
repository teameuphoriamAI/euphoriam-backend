class KajabiUnavailableError extends Error {
  constructor(cause) {
    super("Kajabi API is temporarily unreachable");
    this.name = "KajabiUnavailableError";
    this.code = "KAJABI_UNAVAILABLE";
    this.cause = cause;
  }
}

const isKajabiNetworkError = (err) => {
  const code = err?.code || err?.cause?.code;
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  if (err?.name === "AggregateError" && Array.isArray(err.errors)) {
    return err.errors.some((e) => isKajabiNetworkError(e));
  }
  return false;
};

module.exports = {
  isKajabiNetworkError,
  KajabiUnavailableError,
};
