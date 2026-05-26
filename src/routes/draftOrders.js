import { Router } from "express";
import shopify from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

// POST /draft-orders — create a draft order via GraphQL
router.post("/", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Graphql({ session });

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

  const lineItemsInput = line_items.map((item) => ({
    variantId: item.variant_id ? `gid://shopify/ProductVariant/${item.variant_id}` : undefined,
    quantity: item.quantity,
    title: item.title,
    price: item.price,
    requiresShipping: item.requires_shipping,
    taxable: item.taxable,
    customAttributes: item.properties
      ? item.properties.map((p) => ({ key: p.name, value: String(p.value) }))
      : undefined,
  }));

  const input = {
    lineItems: lineItemsInput,
    ...(email && { email }),
    ...(note && { note }),
    ...(tags && { tags: Array.isArray(tags) ? tags : tags.split(",").map((t) => t.trim()) }),
    ...(tax_exempt !== undefined && { taxExempt: tax_exempt }),
    ...(use_customer_default_address !== undefined && { useCustomerDefaultAddress: use_customer_default_address }),
    ...(customer?.id && { customerId: `gid://shopify/Customer/${customer.id}` }),
    ...(shipping_address && {
      shippingAddress: {
        firstName: shipping_address.first_name,
        lastName: shipping_address.last_name,
        address1: shipping_address.address1,
        address2: shipping_address.address2,
        city: shipping_address.city,
        province: shipping_address.province,
        country: shipping_address.country,
        zip: shipping_address.zip,
        phone: shipping_address.phone,
      },
    }),
    ...(billing_address && {
      billingAddress: {
        firstName: billing_address.first_name,
        lastName: billing_address.last_name,
        address1: billing_address.address1,
        address2: billing_address.address2,
        city: billing_address.city,
        province: billing_address.province,
        country: billing_address.country,
        zip: billing_address.zip,
        phone: billing_address.phone,
      },
    }),
    ...(applied_discount && {
      appliedDiscount: {
        value: applied_discount.value,
        valueType: applied_discount.value_type?.toUpperCase() || "FIXED_AMOUNT",
        title: applied_discount.title,
        description: applied_discount.description,
      },
    }),
    ...(shipping_line && {
      shippingLine: {
        title: shipping_line.title,
        price: shipping_line.price,
        shippingRateHandle: shipping_line.handle,
      },
    }),
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
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variant {
                  id
                  title
                }
                customAttributes {
                  key
                  value
                }
              }
            }
          }
          shippingAddress {
            firstName
            lastName
            address1
            city
            country
            zip
          }
          invoiceUrl
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await client.request(mutation, { variables: { input } });
    const { draftOrderCreate } = response.data;

    if (draftOrderCreate.userErrors.length > 0) {
      return res.status(422).json({
        error: "Draft order validation failed",
        detail: draftOrderCreate.userErrors,
      });
    }

    return res.status(201).json({
      success: true,
      draft_order: draftOrderCreate.draftOrder,
    });
  } catch (err) {
    console.error("Draft order creation error:", err.message);
    return res.status(500).json({
      error: "Failed to create draft order",
      detail: err.message,
    });
  }
});

// GET /draft-orders — list all draft orders
router.get("/", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Graphql({ session });

  const { limit = 50 } = req.query;

  const query = `
    query getDraftOrders($first: Int!) {
      draftOrders(first: $first) {
        edges {
          node {
            id
            name
            status
            totalPrice
            email
            createdAt
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await client.request(query, { variables: { first: parseInt(limit) } });
    return res.json({
      success: true,
      draft_orders: response.data.draftOrders.edges.map((e) => e.node),
    });
  } catch (err) {
    console.error("Draft order list error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch draft orders",
      detail: err.message,
    });
  }
});

// GET /draft-orders/:id — get a single draft order
router.get("/:id", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Graphql({ session });

  const query = `
    query getDraftOrder($id: ID!) {
      draftOrder(id: $id) {
        id
        name
        status
        totalPrice
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
              customAttributes {
                key
                value
              }
            }
          }
        }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const response = await client.request(query, { variables: { id } });
    return res.json({ success: true, draft_order: response.data.draftOrder });
  } catch (err) {
    console.error("Draft order fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch draft order", detail: err.message });
  }
});

// PUT /draft-orders/:id — update a draft order
router.put("/:id", validateSession, async (req, res) => {
  const session = req.shopifySession;
  const client = new shopify.clients.Graphql({ session });

  const mutation = `
    mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) {
        draftOrder {
          id
          name
          status
          totalPrice
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const response = await client.request(mutation, { variables: { id, input: req.body } });
    const { draftOrderUpdate } = response.data;

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
  const session = req.shopifySession;
  const client = new shopify.clients.Graphql({ session });

  const mutation = `
    mutation draftOrderComplete($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder {
          id
          name
          status
          order {
            id
            name
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const response = await client.request(mutation, {
      variables: { id, paymentPending: req.body.payment_pending ?? false },
    });
    const { draftOrderComplete } = response.data;

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
  const session = req.shopifySession;
  const client = new shopify.clients.Graphql({ session });

  const mutation = `
    mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
      draftOrderDelete(input: $input) {
        deletedId
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const response = await client.request(mutation, { variables: { input: { id } } });
    const { draftOrderDelete } = response.data;

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
