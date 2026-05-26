import { Router } from "express";
import shopify, { saveSession } from "../lib/shopify.js";

const router = Router();

// Step 1: Begin OAuth — redirect merchant to Shopify consent screen
router.get("/", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).send("Missing shop parameter");
  }

  await shopify.auth.begin({
    shop: shopify.utils.sanitizeShop(shop, true),
    callbackPath: "/auth/callback",
    isOnline: false, // offline token — persists after merchant closes browser
    rawRequest: req,
    rawResponse: res,
  });
});

// Step 2: Shopify redirects back here with the auth code
router.get("/callback", async (req, res) => {
  try {
    const callbackResponse = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const session = callbackResponse.session;
    saveSession(session);

    console.log(`App installed for shop: ${session.shop}`);
    res.redirect(`/?shop=${session.shop}&installed=true`);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).json({ error: "OAuth failed", detail: err.message });
  }
});

// GET /auth/token?shop=your-store.myshopify.com — reveal stored access token
router.get("/token", (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).json({ error: "Missing shop parameter" });
  }

  const sessionId = shopify.session.getOfflineId(shop);
  const session = loadSession(sessionId);

  if (!session || !session.accessToken) {
    return res.status(404).json({
      error: "No session found for this shop. Complete OAuth first.",
      authUrl: `/auth?shop=${shop}`,
    });
  }

  return res.json({
    shop: session.shop,
    accessToken: session.accessToken,
    scope: session.scope,
  });
});

export default router;
