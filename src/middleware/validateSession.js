import { accessToken, SHOP_DOMAIN } from "../lib/shopify.js";

export const validateSession = (req, res, next) => {
  const token = accessToken;

  if (!token) {
    const shop = req.query.shop || SHOP_DOMAIN || "fineyst-signs.myshopify.com";
    return res.status(401).json({
      error: "No access token. Install the app first.",
      authUrl: `/auth?shop=${shop}`,
    });
  }

  req.shopifyAccessToken = token;
  next();
};
