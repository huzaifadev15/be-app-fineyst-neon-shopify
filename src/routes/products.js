import { Router } from "express";
import { shopifyGraphql } from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

// POST /products — create a product with optional variants
router.post("/", validateSession, async (req, res) => {
  const {
    title,
    templateSuffix = "testing-template",
    vendor,
    productType,
    tags,
    options,
    variants,
  } = req.body;

  const status = "ACTIVE";

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  // Step 1: Create the product
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
          createdAt
        }
        userErrors { field message }
      }
    }
  `;

  const productInput = {
    title,
    status,
    ...(templateSuffix && { templateSuffix }),
    ...(vendor         && { vendor }),
    ...(productType    && { productType }),
    ...(tags           && { tags }),
    ...(options        && { productOptions: options }),
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

  // Step 2: Create variants if provided
  if (variants && Array.isArray(variants) && variants.length > 0) {
    const variantsMutation = `
      mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
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

    const variantsInput = variants.map((v) => ({
      price:                        String(v.price ?? "0.00"),
      ...(v.compareAtPrice        && { compareAtPrice: String(v.compareAtPrice) }),
      ...(v.sku                   && { sku: v.sku }),
      ...(v.optionValues          && { optionValues: v.optionValues }),
      inventoryItem: {
        tracked: true,
        ...(v.cost                && { cost: String(v.cost) }),
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
      const { productVariantsBulkCreate } = data;

      if (productVariantsBulkCreate.userErrors.length > 0) {
        return res.status(422).json({
          error: "Variant creation failed",
          detail: productVariantsBulkCreate.userErrors,
          product: createdProduct,
        });
      }

      return res.status(201).json({
        success: true,
        product: createdProduct,
        variants: productVariantsBulkCreate.productVariants,
      });
    } catch (err) {
      console.error("Variant creation error:", err.message);
      return res.status(500).json({
        error: "Product created but variants failed",
        detail: err.message,
        product: createdProduct,
      });
    }
  }

  return res.status(201).json({ success: true, product: createdProduct });
});

export default router;
