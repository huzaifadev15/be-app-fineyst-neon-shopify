import shopify, { loadSession } from "../lib/shopify.js";

export const validateSession = async (req, res, next) => {
  const shop = req.query.shop || req.body?.shop || process.env.DEFAULT_SHOP || "fineyst-signs.myshopify.com";


  const sessionId = shopify.session.getOfflineId(shop);
  const session = loadSession(sessionId);

  if (!session || !session.accessToken) {
    return res.status(401).json({
      error: "No active session. Please install the app first.",
      authUrl: `/auth?shop=${shop}`,
    });
  }

  req.shopifySession = session;
  next();
};
