// kajabiAuth.js
import axios from "axios";

const KAJABI_API_KEY = process.env.KAJABI_API_KEY;
const KAJABI_API_SECRET = process.env.KAJABI_API_SECRET;
const params = new URLSearchParams();
params.append("client_id", KAJABI_API_KEY);
params.append("client_secret", KAJABI_API_SECRET);
params.append("grant_type", "client_credentials");

export async function getKajabiAccessToken() {
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

  return res.data.access_token;
}

export function createKajabiClient(accessToken) {
  console.log("token", accessToken);

  return axios.create({
    baseURL: "https://api.kajabi.com/v1",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}
