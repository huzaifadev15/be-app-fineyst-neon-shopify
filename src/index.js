import "dotenv/config";
import express from "express";
import cors from "cors";
import authRouter from "./routes/auth.js";
import draftOrdersRouter from "./routes/draftOrders.js";
import uploadsRouter from "./routes/uploads.js";
import productsRouter from "./routes/products.js";
import { accessToken, SHOP_DOMAIN } from "./lib/shopify.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    "https://fineyst-signs.myshopify.com",
    "https://cdn.shopify.com",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth routes
app.use("/auth", authRouter);

// Draft orders API
app.use("/draft-orders", draftOrdersRouter);

// File uploads → Shopify CDN
app.use("/uploads", uploadsRouter);

// Products
app.use("/products", productsRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, shop: SHOP_DOMAIN });
});

// App entry point — Shopify loads this URL when the merchant opens the app.
// Redirect to OAuth if no token is present.
app.get("/", (req, res) => {
  const shop = req.query.shop || SHOP_DOMAIN || "fineyst-signs.myshopify.com";

  if (!accessToken) {
    return res.redirect(`/auth?shop=${shop}`);
  }

  res.json({ message: "Shopify app ready", shop, installed: true });
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Start OAuth: http://localhost:${PORT}/auth?shop=your-store.myshopify.com`);
  });
}

export default app;
