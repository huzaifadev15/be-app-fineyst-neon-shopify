import { Session } from "@shopify/shopify-api";
import shopify, { loadSession } from "../lib/shopify.js";

export const validateSession = async (req, res, next) => {
  const shop = req.query.shop || req.body?.shop || process.env.DEFAULT_SHOP || "fineyst-signs.myshopify.com";

  const sessionId = shopify.session.getOfflineId(shop);
  let session = loadSession(sessionId);

  // Fallback to env var token for serverless environments
  if ((!session || !session.accessToken) && process.env.SHOPIFY_ACCESS_TOKEN) {
    session = new Session({
      id: sessionId,
      shop,
      state: "active",
      isOnline: false,
      accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
      scope: process.env.SHOPIFY_SCOPES || "write_draft_orders,read_draft_orders",
    });
  }

  if (!session || !session.accessToken) {
    return res.status(401).json({
      error: "No active session. Please install the app first.",
      authUrl: `/auth?shop=${shop}`,
    });
  }

  req.shopifySession = session;
  next();
};
