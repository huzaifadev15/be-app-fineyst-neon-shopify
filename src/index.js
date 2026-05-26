import "dotenv/config";
import express from "express";
import authRouter from "./routes/auth.js";
import draftOrdersRouter from "./routes/draftOrders.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth routes
app.use("/auth", authRouter);

// Draft orders REST API
app.use("/draft-orders", draftOrdersRouter);

// Health check
app.get("/", (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    return res.json({
      message: "Shopify app ready",
      shop,
      installed: req.query.installed === "true",
    });
  }
  res.json({ message: "Shopify Draft Orders App is running" });
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Start OAuth: http://localhost:${PORT}/auth?shop=your-store.myshopify.com`);
  });
}

export default app;
