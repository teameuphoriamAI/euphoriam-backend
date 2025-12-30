// kajabiAuth.js
import axios from "axios";

const KAJABI_API_KEY = process.env.KAJABI_API_KEY;
const KAJABI_API_SECRET = process.env.KAJABI_API_SECRET;

let accessToken = null;
let tokenExpiresAt = 0;

async function fetchKajabiAccessToken() {
  const params = new URLSearchParams();
  params.append("client_id", KAJABI_API_KEY);
  params.append("client_secret", KAJABI_API_SECRET);
  params.append("grant_type", "client_credentials");

  const res = await axios.post(
    "https://api.kajabi.com/v1/oauth/token",
    params.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    }
  );

  const { access_token, expires_in } = res.data;
  // expires_in = 604800 (7 days)

  accessToken = access_token;

  // Convert duration → absolute expiry timestamp
  tokenExpiresAt = Math.floor(Date.now() / 1000) + expires_in - 300; // 5 min buffer

  return accessToken;
}

export async function getKajabiAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (!accessToken || now >= tokenExpiresAt) {
    return await fetchKajabiAccessToken();
  }

  return accessToken;
}

export async function createKajabiClient() {
  const token = await getKajabiAccessToken();

  return axios.create({
    baseURL: "https://api.kajabi.com/v1",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}
