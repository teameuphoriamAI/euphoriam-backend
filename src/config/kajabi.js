// kajabiClient.js
import axios from "axios";

const KAJABI_API_KEY = process.env.KAJABI_API_KEY;
const KAJABI_API_SECRET = process.env.KAJABI_API_SECRET;

export const kajabi = axios.create({
  baseURL: "https://api.kajabi.com/v1/oauth/token",
  auth: {
    username: KAJABI_API_KEY,
    password: KAJABI_API_SECRET,
  },
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});
