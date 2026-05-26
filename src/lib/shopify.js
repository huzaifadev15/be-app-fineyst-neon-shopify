import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION, Session } from "@shopify/shopify-api";

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION, // 2025-04
  isEmbeddedApp: false,
});

// In-memory session storage (replace with DB in production)
const sessionStorage = new Map();

export const saveSession = (session) => {
  sessionStorage.set(session.id, session);
};

export const loadSession = (id) => {
  return sessionStorage.get(id) || null;
};

export const deleteSession = (id) => {
  sessionStorage.delete(id);
};

export default shopify;
