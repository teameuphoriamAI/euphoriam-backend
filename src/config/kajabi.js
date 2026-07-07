// kajabiAuth.js
import dns from "node:dns";
import http from "http";
import https from "https";
import axios from "axios";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isKajabiNetworkError, KajabiUnavailableError } = require("../utils/kajabiNetwork.js");

export { isKajabiNetworkError, KajabiUnavailableError };

const KAJABI_API_KEY = process.env.KAJABI_API_KEY;
const KAJABI_API_SECRET = process.env.KAJABI_API_SECRET;
const KAJABI_TIMEOUT_MS = Number(process.env.KAJABI_TIMEOUT_MS || 20000);
const KAJABI_RETRY_COUNT = Math.max(0, Number(process.env.KAJABI_RETRY_COUNT || 2));
const KAJABI_RETRY_BASE_MS = Number(process.env.KAJABI_RETRY_BASE_MS || 1000);

let accessToken = null;
let tokenExpiresAt = 0;
let tokenFetchPromise = null;

const ipv4Lookup = (hostname, options, callback) => {
  const family = typeof options === "object" ? options.family : options;
  if (family === 6) {
    callback(null, [], 6);
    return;
  }
  dns.lookup(hostname, { family: 4 }, callback);
};

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  lookup: ipv4Lookup,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 4,
  lookup: ipv4Lookup,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assertKajabiCredentials = () => {
  if (!KAJABI_API_KEY?.trim() || !KAJABI_API_SECRET?.trim()) {
    throw new KajabiUnavailableError(
      new Error("KAJABI_API_KEY and KAJABI_API_SECRET are not configured"),
    );
  }
};

const kajabiAxiosConfig = () => ({
  timeout: KAJABI_TIMEOUT_MS,
  httpsAgent,
  httpAgent,
  family: 4,
});

async function fetchKajabiAccessTokenOnce() {
  assertKajabiCredentials();

  const params = new URLSearchParams();
  params.append("client_id", KAJABI_API_KEY);
  params.append("client_secret", KAJABI_API_SECRET);
  params.append("grant_type", "client_credentials");

  const res = await axios.post(
    "https://api.kajabi.com/v1/oauth/token",
    params.toString(),
    {
      ...kajabiAxiosConfig(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    },
  );

  const { access_token, expires_in } = res.data;
  accessToken = access_token;
  tokenExpiresAt = Math.floor(Date.now() / 1000) + expires_in - 300;
  return accessToken;
}

async function fetchKajabiAccessToken() {
  let lastErr;
  for (let attempt = 0; attempt <= KAJABI_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchKajabiAccessTokenOnce();
    } catch (err) {
      lastErr = err;
      if (isKajabiNetworkError(err) && attempt < KAJABI_RETRY_COUNT) {
        await sleep(KAJABI_RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      break;
    }
  }

  if (isKajabiNetworkError(lastErr)) {
    throw new KajabiUnavailableError(lastErr);
  }
  throw lastErr;
}

export async function getKajabiAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (accessToken && now < tokenExpiresAt) {
    return accessToken;
  }

  if (!tokenFetchPromise) {
    tokenFetchPromise = fetchKajabiAccessToken().finally(() => {
      tokenFetchPromise = null;
    });
  }

  return tokenFetchPromise;
}

export async function createKajabiClient() {
  const token = await getKajabiAccessToken();

  return axios.create({
    baseURL: "https://api.kajabi.com/v1",
    ...kajabiAxiosConfig(),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

export async function withKajabiRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= KAJABI_RETRY_COUNT; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof KajabiUnavailableError) throw err;
      if (isKajabiNetworkError(err) && attempt < KAJABI_RETRY_COUNT) {
        await sleep(KAJABI_RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      if (isKajabiNetworkError(err)) {
        throw new KajabiUnavailableError(err);
      }
      throw err;
    }
  }
  throw lastErr;
}
