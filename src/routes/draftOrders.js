import { Router } from "express";
import { waitUntil } from "@vercel/functions";
import { shopifyGraphql, SHOP_DOMAIN } from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

const FORM_NOTIFY_URL =
  "https://neonsign.us.com/api/2fa960e3-3d82-4b69-a3af-44eec1747bb4/forms/for-category";

function sendFormNotification(body, draftOrder = {}) {
  const { customer, line_items = [], notes, schedule_call } = body;

  // Build a property lookup from the first line item's properties array
  const props = {};
  (line_items[0]?.properties ?? []).forEach((p) => {
    props[p.name] = p.value;
  });
  console.log("[Form Notify] Extracted props:", JSON.stringify(props, null, 2));

  // Build size string from Width/Height properties
  const width  = props["Width (in)"]  ?? props["width"]  ?? "";
  const height = props["Height (in)"] ?? props["height"] ?? "";
  const size   = width && height ? `${width}x${height}` : (props.size ?? body.size ?? "");

  // Build uploadedFiles from Design File properties
  const fileUrl      = props["Design File URL"]      ?? props["Design Resource URL"] ?? "";
  const fileName     = props["Design File Name"]     ?? "";
  const fileType     = props["Design File Type"]     ?? "";
  const fileSize     = parseInt(props["Design File Size"] ?? "0", 10);
  const category     = new Date().getFullYear().toString();
  let filePath = "";
  if (fileUrl) {
    try { filePath = new URL(fileUrl).pathname; } catch { filePath = fileUrl; }
  }

  const uploadedFiles = fileUrl
    ? [{ originalName: fileName, fileName, filePath, fileUrl, fileSize, fileType, category }]
    : (body.uploadedFiles ?? []);

  const payload = {
    status:       "NEW",
    isFine:       true,
    email:        customer?.email  ?? "",
    phoneNumber:  customer?.phone  ?? "",
    thread:       "N/A",
    colors:       "N/A",
    backing:      "N/A",
    border:       "N/A",
    unitPrice:    0,
    subTotal:     0,
    storeId:      "default-store-id",
    queryFrom:    props.queryFrom  ?? body.queryFrom ?? "",
    signType:     props.signType   ?? body.signType  ?? "",
    placement:    props["Placement"] ?? props.placement ?? body.placement ?? "",
    patchType:    props.signType   ?? body.signType  ?? "Acrylic LED Signs",
    shape:        props["Placement"] ?? props.placement ?? body.placement ?? "INDOOR",
    size,
    quantity:     line_items[0]?.quantity ?? body.quantity ?? 1,
    notes:        notes ?? "",
    uploadedFiles,
    schedule:     schedule_call ?? "",
    invoiceUrl:   draftOrder.invoiceUrl  ?? "",
    draftOrderId: draftOrder.id         ?? "",
    shopType:     "shopify",
  };

  console.log("[Form Notify] Sending payload:", JSON.stringify(payload, null, 2));

  return fetch(FORM_NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(async (r) => {
      const text = await r.text();
      if (!r.ok) {
        console.error(`[Form Notify] Failed — status ${r.status}, body:`, text);
      } else {
        console.log(`[Form Notify] Success — status ${r.status}, body:`, text);
      }
    })
    .catch((err) => console.error("[Form Notify] Error:", err.message));
}

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

    res.status(201).json({ success: true, draft_order: draftOrderCreate.draftOrder });
    waitUntil(sendFormNotification(req.body, draftOrderCreate.draftOrder));
    return;
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

// POST /draft-orders/:id/invoice — send invoice email for a draft order
// Optional body fields: { customMessage }
router.post("/:id/invoice", validateSession, async (req, res) => {
  const { customMessage } = req.body ?? {};

  const mutation = `
    mutation draftOrderInvoiceSend($id: ID!, $customMessage: String) {
      draftOrderInvoiceSend(id: $id, email: { customMessage: $customMessage }) {
        draftOrder {
          id
          name
          invoiceUrl
        }
        userErrors { field message }
      }
    }
  `;

  try {
    const id = `gid://shopify/DraftOrder/${req.params.id}`;
    const data = await shopifyGraphql(mutation, {
      id,
      customMessage: customMessage ?? null,
    });
    const { draftOrderInvoiceSend } = data;

    if (draftOrderInvoiceSend.userErrors.length > 0) {
      return res.status(422).json({ error: "Failed to send invoice", detail: draftOrderInvoiceSend.userErrors });
    }

    return res.json({ success: true, draft_order: draftOrderInvoiceSend.draftOrder });
  } catch (err) {
    console.error("Draft order invoice error:", err.message);
    return res.status(500).json({ error: "Failed to send invoice", detail: err.message });
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

// POST /draft-orders/manual — create a DRAFT product then a draft order from manual fields
// Body: { quantity, shipping, backing, border, broder, productImage, price, email, customerName }
router.post("/manual", validateSession, async (req, res) => {
  const {
    quantity,
    shipping,
    backing,
    border,
    broder,
    productImage,
    price,
    email,
    customerName,
  } = req.body ?? {};

  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1) {
    return res.status(400).json({ error: "quantity must be a positive integer." });
  }

  try {
    // ── Step 1: build product title & description ─────────────────────────────
    const borderValue  = border || broder || "";
    const productTitle = [
      "Manual Order",
      `Qty: ${qty}`,
      backing     ? `Backing: ${backing}`    : null,
      borderValue ? `Border: ${borderValue}` : null,
    ].filter(Boolean).join(" | ");

    const descriptionHtml = [
      `Quantity: ${qty}`,
      backing     ? `Backing: ${backing}`    : null,
      borderValue ? `Border: ${borderValue}` : null,
      shipping    ? `Shipping: ${shipping}`  : null,
    ].filter(Boolean).join("<br>");

    // ── Step 2: resolve image URL ─────────────────────────────────────────────
    const resolvedImageUrl = productImage
      ? productImage.startsWith("http")
        ? productImage
        : `https://${SHOP_DOMAIN}${productImage.startsWith("/") ? "" : "/"}${productImage}`
      : null;

    const mediaInput = resolvedImageUrl
      ? [{ originalSource: resolvedImageUrl, alt: productTitle, mediaContentType: "IMAGE" }]
      : [];

    // ── Step 3: create DRAFT product ─────────────────────────────────────────
    const productData = await shopifyGraphql(`
      mutation CreateManualProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            variants(first: 1) { nodes { id } }
          }
          userErrors { field message }
        }
      }
    `, {
      product: {
        title:           productTitle,
        descriptionHtml,
        status:          "DRAFT",
        tags:            ["manual-order", `qty-${qty}`],
      },
      media: mediaInput,
    });

    const productErrors = productData?.productCreate?.userErrors ?? [];
    if (productErrors.length) {
      return res.status(422).json({ error: "Product creation failed", detail: productErrors });
    }

    const createdProduct = productData?.productCreate?.product;
    const createdVariant = createdProduct?.variants?.nodes?.[0];
    if (!createdVariant?.id) {
      return res.status(502).json({ error: "Product created but variant ID not returned." });
    }

    // ── Step 4: set variant price ─────────────────────────────────────────────
    const unitPrice  = parseFloat(price) || 0;
    const variantData = await shopifyGraphql(`
      mutation SetVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }
    `, {
      productId: createdProduct.id,
      variants:  [{ id: createdVariant.id, price: unitPrice.toFixed(2) }],
    });

    const variantErrors = variantData?.productVariantsBulkUpdate?.userErrors ?? [];
    if (variantErrors.length) {
      return res.status(422).json({ error: "Variant price update failed", detail: variantErrors });
    }

    // ── Step 5: create draft order ────────────────────────────────────────────
    const draftData = await shopifyGraphql(`
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            status
            totalPrice
            invoiceUrl
          }
          userErrors { field message }
        }
      }
    `, {
      input: {
        lineItems: [{
          variantId: createdVariant.id,
          quantity:  qty,
          customAttributes: [
            { key: "Quantity", value: String(qty) },
            ...(backing     ? [{ key: "Backing", value: backing }]       : []),
            ...(borderValue ? [{ key: "Border",  value: borderValue }]   : []),
          ],
        }],
        shippingLine: {
          title: "Shipping",
          price: shipping != null ? String(shipping) : "0.00",
        },
        note: productTitle,
        ...(email        && { email }),
        ...(customerName && {
          shippingAddress: { firstName: customerName },
          billingAddress:  { firstName: customerName },
        }),
      },
    });

    const draftErrors = draftData?.draftOrderCreate?.userErrors ?? [];
    if (draftErrors.length) {
      return res.status(422).json({ error: "Draft order creation failed", detail: draftErrors });
    }

    const draftOrder = draftData?.draftOrderCreate?.draftOrder;
    return res.status(201).json({
      success:    true,
      productId:  createdProduct.id,
      draftOrder: {
        id:         draftOrder?.id,
        name:       draftOrder?.name,
        status:     draftOrder?.status,
        totalPrice: draftOrder?.totalPrice,
        invoiceUrl: draftOrder?.invoiceUrl,
      },
    });

  } catch (err) {
    console.error("[MANUAL_DRAFT_ORDER]", err.message);
    return res.status(500).json({ error: "Failed to create manual draft order", detail: err.message });
  }
});

export default router;
