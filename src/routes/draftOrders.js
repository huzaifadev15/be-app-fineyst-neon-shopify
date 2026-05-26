import { Router } from "express";
import shopify from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

// POST /draft-orders — create a draft order
router.post("/", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Rest({ session });

  const {
    line_items,
    customer,
    shipping_address,
    billing_address,
    note,
    tags,
    email,
    use_customer_default_address,
    shipping_line,
    applied_discount,
    tax_exempt,
  } = req.body;

  if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
    return res.status(400).json({ error: "line_items array is required and must not be empty" });
  }

  const draftOrderPayload = {
    draft_order: {
      line_items,
      ...(customer && { customer }),
      ...(email && { email }),
      ...(note && { note }),
      ...(tags && { tags }),
      ...(shipping_address && { shipping_address }),
      ...(billing_address && { billing_address }),
      ...(shipping_line && { shipping_line }),
      ...(applied_discount && { applied_discount }),
      ...(use_customer_default_address !== undefined && { use_customer_default_address }),
      ...(tax_exempt !== undefined && { tax_exempt }),
    },
  };

  try {
    const response = await client.post({
      path: "draft_orders",
      data: draftOrderPayload,
      type: "application/json",
    });

    return res.status(201).json({
      success: true,
      draft_order: response.body.draft_order,
    });
  } catch (err) {
    console.error("Draft order creation error:", err.message);
    return res.status(err.response?.code || 500).json({
      error: "Failed to create draft order",
      detail: err.response?.body?.errors || err.message,
    });
  }
});

// GET /draft-orders — list all draft orders
router.get("/", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Rest({ session });

  const { limit = 50, status = "open" } = req.query;

  try {
    const response = await client.get({
      path: "draft_orders",
      query: { limit, status },
    });

    return res.json({
      success: true,
      draft_orders: response.body.draft_orders,
    });
  } catch (err) {
    console.error("Draft order list error:", err.message);
    return res.status(err.response?.code || 500).json({
      error: "Failed to fetch draft orders",
      detail: err.response?.body?.errors || err.message,
    });
  }
});

// GET /draft-orders/:id — get a single draft order
router.get("/:id", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Rest({ session });

  try {
    const response = await client.get({
      path: `draft_orders/${req.params.id}`,
    });

    return res.json({
      success: true,
      draft_order: response.body.draft_order,
    });
  } catch (err) {
    console.error("Draft order fetch error:", err.message);
    return res.status(err.response?.code || 500).json({
      error: "Failed to fetch draft order",
      detail: err.response?.body?.errors || err.message,
    });
  }
});

// PUT /draft-orders/:id — update a draft order
router.put("/:id", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Rest({ session });

  try {
    const response = await client.put({
      path: `draft_orders/${req.params.id}`,
      data: { draft_order: req.body },
      type: "application/json",
    });

    return res.json({
      success: true,
      draft_order: response.body.draft_order,
    });
  } catch (err) {
    console.error("Draft order update error:", err.message);
    return res.status(err.response?.code || 500).json({
      error: "Failed to update draft order",
      detail: err.response?.body?.errors || err.message,
    });
  }
});

// POST /draft-orders/:id/complete — mark draft order as paid / convert to order
router.post("/:id/complete", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Rest({ session });

  const { payment_gateway_id, payment_pending = false } = req.body;

  try {
    const response = await client.post({
      path: `draft_orders/${req.params.id}/complete`,
      query: { payment_pending },
      data: payment_gateway_id ? { payment_gateway_id } : {},
      type: "application/json",
    });

    return res.json({
      success: true,
      draft_order: response.body.draft_order,
    });
  } catch (err) {
    console.error("Draft order complete error:", err.message);
    return res.status(err.response?.code || 500).json({
      error: "Failed to complete draft order",
      detail: err.response?.body?.errors || err.message,
    });
  }
});

// DELETE /draft-orders/:id — delete a draft order
router.delete("/:id", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Rest({ session });

  try {
    await client.delete({ path: `draft_orders/${req.params.id}` });
    return res.json({ success: true, message: "Draft order deleted" });
  } catch (err) {
    console.error("Draft order delete error:", err.message);
    return res.status(err.response?.code || 500).json({
      error: "Failed to delete draft order",
      detail: err.response?.body?.errors || err.message,
    });
  }
});

export default router;
