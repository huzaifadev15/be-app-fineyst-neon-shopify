import { Router } from "express";
import { shopifyGraphql } from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();

// Cache publication inputs so we only fetch once per process
let cachedPublicationInputs = null;

async function getAllPublicationInputs() {
  if (cachedPublicationInputs) return cachedPublicationInputs;

  const query = `
    query GetAllPublications {
      publications(first: 50) {
        nodes {
          id
          autoPublish
          supportsFuturePublishing
          catalog {
            id
            title
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(query);
  // Build one PublicationInput per publication: { publicationId }
  cachedPublicationInputs = data.publications.nodes.map((node) => ({
    publicationId: node.id,
  }));
  return cachedPublicationInputs;
}

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
              node { id }
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

  // Step 2: Attach images via productCreateMedia (images are not part of ProductCreateInput)
  let attachedMedia = [];
  if (Array.isArray(images) && images.length > 0) {
    const mediaMutation = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            ... on MediaImage {
              id
              image { url }
            }
          }
          mediaUserErrors { field message }
        }
      }
    `;

    const mediaInput = images.map((img) => ({
      originalSource: img.url,
      alt: img.altText ?? title,
      mediaContentType: "IMAGE",
    }));

    try {
      const data = await shopifyGraphql(mediaMutation, {
        productId: createdProduct.id,
        media: mediaInput,
      });
      const { media, mediaUserErrors } = data.productCreateMedia;

      if (mediaUserErrors?.length > 0) {
        console.warn("Media attach warnings:", mediaUserErrors);
      }

      attachedMedia = media ?? [];
    } catch (err) {
      console.error("productCreateMedia error:", err.message);
      // Non-fatal — product was created, just log
    }
  }

  // Step 3: Update variants if provided
  // Shopify auto-creates a "Default Title" variant on product creation.
  // We UPDATE that existing variant instead of creating a new one to avoid conflicts.
  let updatedVariants = [];
  if (Array.isArray(variants) && variants.length > 0) {
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
      ...(i === 0 && defaultVariantId ? { id: defaultVariantId } : {}),
      price: String(v.price ?? "0.00"),
      ...(v.compareAtPrice && { compareAtPrice: String(v.compareAtPrice) }),
      ...(v.sku            && { sku: v.sku }),
      ...(v.optionValues   && { optionValues: v.optionValues }),
      inventoryItem: {
        tracked: true,
        ...(v.cost && { cost: String(v.cost) }),
      },
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

      updatedVariants = productVariantsBulkUpdate.productVariants;
    } catch (err) {
      console.error("Variant update error:", err.message);
      return res.status(500).json({
        error: "Product created but variant update failed",
        detail: err.message,
        product: createdProduct,
      });
    }
  }

  // Step 4: Publish to all sales channels / publications
  let onlineStoreUrl = createdProduct.onlineStoreUrl ?? null;
  try {
    const publicationInputs = await getAllPublicationInputs();
    if (publicationInputs.length > 0) {
      const publishMutation = `
        mutation PublishProductToAllPublications($productId: ID!, $inputs: [PublicationInput!]!) {
          publishablePublish(id: $productId, input: $inputs) {
            publishable {
              ... on Product {
                id
                title
                status
                onlineStoreUrl
                resourcePublicationsV2(first: 20) {
                  nodes {
                    publication { id }
                    isPublished
                  }
                }
              }
            }
            userErrors { field message }
          }
        }
      `;

      const pubData = await shopifyGraphql(publishMutation, {
        productId: createdProduct.id,
        inputs: publicationInputs,
      });

      const published = pubData.publishablePublish;
      if (published.userErrors?.length > 0) {
        console.warn("Publish warnings:", published.userErrors);
      } else {
        onlineStoreUrl = published.publishable?.onlineStoreUrl ?? onlineStoreUrl;
      }
    }
  } catch (err) {
    console.error("Publish to all channels error:", err.message);
    // Non-fatal — product was created and priced correctly
  }

  const { variants: _v, ...productData } = createdProduct;
  return res.status(201).json({
    success: true,
    product: { ...productData, onlineStoreUrl },
    variants: updatedVariants,
    media: attachedMedia,
  });
});

export default router;
