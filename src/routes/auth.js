import { Router } from "express";
import shopify, { saveSession, loadSession } from "../lib/shopify.js";

const router = Router();

// Step 1: Begin OAuth — redirect merchant to Shopify consent screen
router.get("/", async (req, res) => {
  const shop = req.query.shop || process.env.DEFAULT_SHOP || "fineyst-signs.myshopify.com";


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
    console.log(`ACCESS TOKEN: ${session.accessToken}`);
    res.redirect(`/?shop=${session.shop}&installed=true&token=${session.accessToken}`);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).json({ error: "OAuth failed", detail: err.message });
  }
});

// GET /auth/token?shop=your-store.myshopify.com — reveal stored access token
router.get("/token", (req, res) => {
  const shop = req.query.shop || process.env.DEFAULT_SHOP || "fineyst-signs.myshopify.com";

  const sessionId = shopify.session.getOfflineId(shop);
  const session = loadSession(sessionId);
  const accessToken = session?.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(404).json({
      error: "No session found for this shop. Complete OAuth first.",
      authUrl: `/auth?shop=${shop}`,
    });
  }

  return res.json({
    shop: session?.shop || shop,
    accessToken,
    scope: session?.scope || process.env.SHOPIFY_SCOPES,
  });
});

export default router;
