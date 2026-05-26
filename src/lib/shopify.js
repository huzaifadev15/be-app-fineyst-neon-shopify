const SHOP_DOMAIN = (process.env.SHOPIFY_SHOP_DOMAIN || "fineyst-signs.myshopify.com")
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-04";

// Mutable — updated at runtime when OAuth completes
export let accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";

export function setAccessToken(token) {
  accessToken = token;
}

export { SHOP_DOMAIN };

export async function shopifyGraphql(query, variables = {}) {
  if (!SHOP_DOMAIN || !accessToken) {
    throw new Error("Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN.");
  }

  const response = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Shopify GraphQL returned non-JSON response (status ${response.status}).`);
  }

  if (!response.ok) {
    const msg = data?.errors?.[0]?.message || data?.error || data?.message || `HTTP ${response.status}`;
    throw new Error(`Shopify GraphQL failed (${response.status}): ${String(msg).slice(0, 300)}`);
  }

  if (data.errors?.length) {
    throw new Error(data.errors[0].message || "Shopify GraphQL returned errors.");
  }

  return data.data;
}
