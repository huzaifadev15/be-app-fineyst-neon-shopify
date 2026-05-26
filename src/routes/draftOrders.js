import { Router } from "express";
import { shopifyGraphql } from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

// POST /draft-orders — create a draft order
router.post("/", validateSession, async (req, res) => {
  const {
    shop,
    line_items,
    customer,
    notes,
    schedule_call,
  } = req.body;

  if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
    return res.status(400).json({ error: "line_items array is required and must not be empty" });
  }

  const lineItemsInput = line_items.map((item) => ({
    ...(item.variant_id && { variantId: `gid://shopify/ProductVariant/${item.variant_id}` }),
    quantity: parseInt(item.quantity, 10),
    ...(item.properties && {
      customAttributes: item.properties.map((p) => ({ key: p.name, value: String(p.value) })),
    }),
  }));

  const note = [
    notes                  ? notes                              : null,
    schedule_call          ? `Schedule Call: ${schedule_call}` : null,
    customer?.name         ? `Customer: ${customer.name}`      : null,
    customer?.phone        ? `Phone: ${customer.phone}`        : null,
  ].filter(Boolean).join("\n") || undefined;

  const input = {
    lineItems: lineItemsInput,
    ...(customer?.email && { email: String(customer.email) }),
    ...(note && { note }),
    customAttributes: [
      shop ? { key: "Shop", value: String(shop) } : null,
    ].filter(Boolean),
  };

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          status
          totalPrice
          subtotalPrice
          email
          note2
          tags
          invoiceUrl
          createdAt
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variant { id title }
                customAttributes { key value }
              }
            }
          }
          shippingAddress {
            firstName lastName address1 city country zip
          }
        }
        userErrors { field message }
      }
    }
  `;

  try {
    const data = await shopifyGraphql(mutation, { input });
    const { draftOrderCreate } = data;

    if (draftOrderCreate.userErrors.length > 0) {
      return res.status(422).json({
        error: "Draft order validation failed",
        detail: draftOrderCreate.userErrors,
      });
    }

    return res.status(201).json({ success: true, draft_order: draftOrderCreate.draftOrder });
  } catch (err) {
    console.error("Draft order creation error:", err.message);
    return res.status(500).json({ error: "Failed to create draft order", detail: err.message });
  }
});

// GET /draft-orders — list draft orders
router.get("/", validateSession, async (req, res) => {
  const { limit = 50 } = req.query;

  const query = `
    query getDraftOrders($first: Int!) {
      draftOrders(first: $first) {
        edges {
          node {
            id name status totalPrice email createdAt
            lineItems(first: 10) {
              edges { node { title quantity } }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await shopifyGraphql(query, { first: parseInt(limit) });
    return res.json({
      success: true,
      draft_orders: data.draftOrders.edges.map((e) => e.node),
    });
  } catch (err) {
    console.error("Draft order list error:", err.message);
    return res.status(500).json({ error: "Failed to fetch draft orders", detail: err.message });
  }
});

// GET /draft-orders/:id — get a single draft order
router.get("/:id", validateSession, async (req, res) => {
  const query = `
    query getDraftOrder($id: ID!) {
      draftOrder(id: $id) {
        id name status totalPrice email note2 tags invoiceUrl createdAt
        lineItems(first: 50) {
          edges {
            node { id title quantity customAttributes { key value } }
          }
        }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const data = await shopifyGraphql(query, { id });
    return res.json({ success: true, draft_order: data.draftOrder });
  } catch (err) {
    console.error("Draft order fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch draft order", detail: err.message });
  }
});

// PUT /draft-orders/:id — update a draft order
router.put("/:id", validateSession, async (req, res) => {
  const mutation = `
    mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) {
        draftOrder { id name status totalPrice }
        userErrors { field message }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const data = await shopifyGraphql(mutation, { id, input: req.body });
    const { draftOrderUpdate } = data;

    if (draftOrderUpdate.userErrors.length > 0) {
      return res.status(422).json({ error: "Validation failed", detail: draftOrderUpdate.userErrors });
    }

    return res.json({ success: true, draft_order: draftOrderUpdate.draftOrder });
  } catch (err) {
    console.error("Draft order update error:", err.message);
    return res.status(500).json({ error: "Failed to update draft order", detail: err.message });
  }
});

// POST /draft-orders/:id/complete — convert draft order to order
router.post("/:id/complete", validateSession, async (req, res) => {
  const mutation = `
    mutation draftOrderComplete($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder {
          id name status
          order { id name }
        }
        userErrors { field message }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const data = await shopifyGraphql(mutation, {
      id,
      paymentPending: req.body.payment_pending ?? false,
    });
    const { draftOrderComplete } = data;

    if (draftOrderComplete.userErrors.length > 0) {
      return res.status(422).json({ error: "Validation failed", detail: draftOrderComplete.userErrors });
    }

    return res.json({ success: true, draft_order: draftOrderComplete.draftOrder });
  } catch (err) {
    console.error("Draft order complete error:", err.message);
    return res.status(500).json({ error: "Failed to complete draft order", detail: err.message });
  }
});

// DELETE /draft-orders/:id — delete a draft order
router.delete("/:id", validateSession, async (req, res) => {
  const mutation = `
    mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
      draftOrderDelete(input: $input) {
        deletedId
        userErrors { field message }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const data = await shopifyGraphql(mutation, { input: { id } });
    const { draftOrderDelete } = data;

    if (draftOrderDelete.userErrors.length > 0) {
      return res.status(422).json({ error: "Validation failed", detail: draftOrderDelete.userErrors });
    }

    return res.json({ success: true, message: "Draft order deleted" });
  } catch (err) {
    console.error("Draft order delete error:", err.message);
    return res.status(500).json({ error: "Failed to delete draft order", detail: err.message });
  }
});

export default router;
