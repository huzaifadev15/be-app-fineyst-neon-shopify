import { Router } from "express";
import crypto from "crypto";
import { setAccessToken, accessToken } from "../lib/shopify.js";

const router = Router();

const SHOPIFY_API_KEY = (process.env.SHOPIFY_API_KEY || "").trim();
const SHOPIFY_API_SECRET = (process.env.SHOPIFY_API_SECRET || "").trim();
const SHOPIFY_SCOPES = (process.env.SHOPIFY_SCOPES || "write_draft_orders,read_draft_orders,write_products,read_products,write_inventory,read_inventory").trim();
const APP_URL = (process.env.HOST || "").trim().replace(/\/$/, "");

// In-memory nonce store for CSRF protection
const oauthNonces = new Set();

function normalizeShop(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

// Step 1: redirect merchant to Shopify consent screen
router.get("/", (req, res) => {
  const shop = normalizeShop(
    req.query.shop || process.env.SHOPIFY_SHOP_DOMAIN || "fineyst-signs.myshopify.com"
  );

  if (!SHOPIFY_API_KEY) return res.status(500).send("SHOPIFY_API_KEY is not configured.");

  const nonce = crypto.randomBytes(16).toString("hex");
  oauthNonces.add(nonce);

  const redirectUri = `${APP_URL}/auth/callback`;
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  res.redirect(authUrl);
});

// Step 2: Shopify redirects back here with the auth code
router.get("/callback", async (req, res) => {
  const { shop, code, state, hmac, ...rest } = req.query;

  if (!shop || !code) return res.status(400).send("Missing shop or code.");

  // Validate nonce to prevent CSRF
  if (!oauthNonces.has(state)) {
    return res.status(403).send("Invalid state parameter. Possible CSRF attack.");
  }
  oauthNonces.delete(state);

  // Verify HMAC signature from Shopify
  if (hmac && SHOPIFY_API_SECRET) {
    const message = Object.entries({ shop, code, state, ...rest })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const digest = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");
    if (digest !== hmac) return res.status(403).send("HMAC validation failed.");
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res
        .status(400)
        .send("Failed to get access token: " + JSON.stringify(tokenData));
    }

    setAccessToken(tokenData.access_token);
    console.log(`[OAUTH] Token obtained for shop: ${shop} — save SHOPIFY_ACCESS_TOKEN in env to persist.`);

    res.type("html").send(`
      <!doctype html><html><head><meta charset="UTF-8"/>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 60px auto; padding: 24px; }
        code { background: #f4f4f4; padding: 4px 8px; border-radius: 4px; word-break: break-all; display: block; margin: 8px 0; }
        .btn { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #111; color: #fff; border-radius: 8px; text-decoration: none; }
      </style>
      </head><body>
      <h2>&#10003; App installed successfully</h2>
      <p>Access token obtained for <strong>${shop}</strong>.</p>
      <p>Copy this token and save it as <strong>SHOPIFY_ACCESS_TOKEN</strong> in your Vercel environment variables to persist it across deployments:</p>
      <code>${tokenData.access_token}</code>
      <p>Granted scopes: <code>${tokenData.scope}</code></p>
      <a class="btn" href="/">Back to app</a>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("OAuth error: " + (err?.message || String(err)));
  }
});

// GET /auth/token — reveal stored access token
router.get("/token", (req, res) => {
  const shop =
    req.query.shop ||
    process.env.SHOPIFY_SHOP_DOMAIN ||
    "fineyst-signs.myshopify.com";

  const token = accessToken;
  if (!token) {
    return res.status(404).json({
      error: "No token found. Complete OAuth first.",
      authUrl: `/auth?shop=${shop}`,
    });
  }

  return res.json({ shop, accessToken: token });
});

export default router;
