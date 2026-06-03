import { Router } from "express";
import { shopifyGraphql } from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

// POST /products — create a product with optional variants and images
// Payload example:
// {
//   "title": "Cool Neon Sign",
//   "templateSuffix": "testing-template",
//   "variants": [{ "price": "49.99" }],
//   "images": [{ "url": "https://cdn.shopify.com/...", "altText": "Cool Neon Sign" }]
// }
router.post("/", validateSession, async (req, res) => {
  const {
    title,
    templateSuffix = "testing-template",
    vendor,
    productType,
    tags,
    options,
    variants,
    images,
  } = req.body;

  const status = "ACTIVE";

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  // Step 1: Create the product — also fetch the auto-created default variant id
  const productMutation = `
    mutation productCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          title
          handle
          status
          templateSuffix
          vendor
          productType
          tags
          onlineStoreUrl
          options {
            id
            name
            position
            optionValues {
              id
              name
              hasVariants
            }
          }
          variants(first: 1) {
            edges {
              node {
                id
              }
            }
          }
          createdAt
        }
        userErrors { field message }
      }
    }
  `;

  // Map images: { url, altText } → Shopify ImageInput: { src, altText }
  const shopifyImages = Array.isArray(images) && images.length > 0
    ? images.map((img) => ({ src: img.url, ...(img.altText && { altText: img.altText }) }))
    : undefined;

  const productInput = {
    title,
    status,
    ...(templateSuffix  && { templateSuffix }),
    ...(vendor          && { vendor }),
    ...(productType     && { productType }),
    ...(tags            && { tags }),
    ...(options         && { productOptions: options }),
    ...(shopifyImages   && { images: shopifyImages }),
  };

  let createdProduct;
  try {
    const data = await shopifyGraphql(productMutation, { product: productInput });
    const { productCreate } = data;

    if (productCreate.userErrors.length > 0) {
      return res.status(422).json({
        error: "Product creation failed",
        detail: productCreate.userErrors,
      });
    }

    createdProduct = productCreate.product;
  } catch (err) {
    console.error("Product creation error:", err.message);
    return res.status(500).json({ error: "Failed to create product", detail: err.message });
  }

  // Step 2: Update variants if provided
  // Shopify auto-creates a "Default Title" variant on product creation.
  // We UPDATE that existing variant instead of creating a new one to avoid conflicts.
  if (variants && Array.isArray(variants) && variants.length > 0) {
    const defaultVariantId = createdProduct.variants?.edges?.[0]?.node?.id;

    const variantsMutation = `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
            title
            price
            compareAtPrice
            sku
            inventoryQuantity
            selectedOptions { name value }
          }
          userErrors { field message }
        }
      }
    `;

    const variantsInput = variants.map((v, i) => ({
      // Attach the existing default variant id for the first variant, rest are new
      ...(i === 0 && defaultVariantId ? { id: defaultVariantId } : {}),
      price: String(v.price ?? "0.00"),
      ...(v.compareAtPrice  && { compareAtPrice: String(v.compareAtPrice) }),
      ...(v.sku             && { sku: v.sku }),
      ...(v.optionValues    && { optionValues: v.optionValues }),
      inventoryItem: {
        tracked: true,
        ...(v.cost          && { cost: String(v.cost) }),
      },
      inventoryQuantities: v.quantity != null
        ? [{ availableQuantity: parseInt(v.quantity, 10), locationId: v.locationId ?? "gid://shopify/Location/98908438835" }]
        : [],
    }));

    try {
      const data = await shopifyGraphql(variantsMutation, {
        productId: createdProduct.id,
        variants: variantsInput,
      });
      const { productVariantsBulkUpdate } = data;

      if (productVariantsBulkUpdate.userErrors.length > 0) {
        return res.status(422).json({
          error: "Variant update failed",
          detail: productVariantsBulkUpdate.userErrors,
          product: createdProduct,
        });
      }

      // Strip internal variants field before returning
      const { variants: _v, ...productData } = createdProduct;
      return res.status(201).json({
        success: true,
        product: productData,
        variants: productVariantsBulkUpdate.productVariants,
      });
    } catch (err) {
      console.error("Variant update error:", err.message);
      return res.status(500).json({
        error: "Product created but variant update failed",
        detail: err.message,
        product: createdProduct,
      });
    }
  }

  // No variants provided — strip internal variants field before returning
  const { variants: _v, ...productData } = createdProduct;
  return res.status(201).json({ success: true, product: productData });
});

export default router;
