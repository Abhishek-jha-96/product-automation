import type {
  ShopifyCollection,
  ShopifyLocation,
  ValidatedProductItem,
} from "./types.ts";

/**
 * GraphQL Admin API Client interface provided by authenticate.admin(request).admin
 */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/**
 * Helper to execute GraphQL and extract response or throw actionable errors
 */
export async function executeGraphQL<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${errorBody}`);
  }

  const json = await response.json();
  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e: { message: string }) => e.message).join("; ");
    throw new Error(`Shopify GraphQL API Errors: ${messages}`);
  }

  return json.data as T;
}

/**
 * Query shop vendors to explore and verify existing vendors (including "Meesa")
 */
export async function getShopVendors(admin: AdminGraphqlClient): Promise<string[]> {
  const query = `#graphql
    query getShopVendors {
      shop {
        productVendors(first: 250) {
          edges {
            node
          }
        }
      }
    }
  `;

  interface ShopVendorsData {
    shop?: {
      productVendors?: {
        edges?: Array<{ node: string }>;
      };
    };
  }

  try {
    const data = await executeGraphQL<ShopVendorsData>(admin, query);
    return data?.shop?.productVendors?.edges?.map((e) => e.node) || [];
  } catch (err) {
    console.warn("Could not query shop productVendors:", err);
    return [];
  }
}

/**
 * Query collections in the store (e.g. "Drape Saree", "Indo western", "Suits")
 */
export async function getShopCollections(
  admin: AdminGraphqlClient,
): Promise<ShopifyCollection[]> {
  const query = `#graphql
    query getCollections {
      collections(first: 100) {
        edges {
          node {
            id
            title
            handle
            ruleSet {
              rules {
                column
                relation
                condition
              }
            }
          }
        }
      }
    }
  `;

  interface CollectionsData {
    collections?: {
      edges?: Array<{
        node: {
          id: string;
          title: string;
          handle: string;
          ruleSet: unknown | null;
        };
      }>;
    };
  }

  const data = await executeGraphQL<CollectionsData>(admin, query);
  const edges = data?.collections?.edges || [];

  return edges.map(({ node }) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    isSmart: node.ruleSet !== null && node.ruleSet !== undefined,
  }));
}

/**
 * Query active inventory locations in the store and select primary
 */
export async function getPrimaryLocation(
  admin: AdminGraphqlClient,
): Promise<ShopifyLocation> {
  const query = `#graphql
    query getLocations {
      locations(first: 20) {
        edges {
          node {
            id
            name
            isPrimary
            isActive
          }
        }
      }
    }
  `;

  interface LocationsData {
    locations?: {
      edges?: Array<{
        node: {
          id: string;
          name: string;
          isPrimary: boolean;
          isActive: boolean;
        };
      }>;
    };
  }

  const data = await executeGraphQL<LocationsData>(admin, query);
  const edges = data?.locations?.edges || [];
  const activeLocations = edges.map((e) => e.node).filter((n) => n.isActive);

  if (activeLocations.length === 0) {
    throw new Error("No active inventory locations found in Shopify store.");
  }

  const primary = activeLocations.find((l) => l.isPrimary) || activeLocations[0];
  return {
    id: primary.id,
    name: primary.name,
    isPrimary: primary.isPrimary,
  };
}

/**
 * Find existing product by SKU or Title to prevent duplicate creation
 */
export async function findExistingProduct(
  admin: AdminGraphqlClient,
  item: ValidatedProductItem,
): Promise<{
  id: string;
  title: string;
  vendor: string;
  variantId: string;
  inventoryItemId: string;
} | null> {
  const queriesToTry: string[] = [];

  if (item.productNumber) {
    queriesToTry.push(`sku:${item.productNumber}`);
  }
  // Sanitize title for Shopify search query
  const escapedTitle = item.title.replace(/["\\]/g, "");
  queriesToTry.push(`title:"${escapedTitle}"`);

  const query = `#graphql
    query findProduct($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            title
            vendor
            status
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  sku
                  inventoryItem {
                    id
                    tracked
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  interface FindProductData {
    products?: {
      edges?: Array<{
        node: {
          id: string;
          title: string;
          vendor: string;
          variants: {
            edges: Array<{
              node: {
                id: string;
                price: string;
                sku?: string;
                inventoryItem?: {
                  id: string;
                  tracked: boolean;
                };
              };
            }>;
          };
        };
      }>;
    };
  }

  for (const q of queriesToTry) {
    try {
      const data = await executeGraphQL<FindProductData>(admin, query, { query: q });
      const edge = data?.products?.edges?.[0];
      if (edge && edge.node) {
        const variant = edge.node.variants?.edges?.[0]?.node;
        if (variant && variant.inventoryItem) {
          return {
            id: edge.node.id,
            title: edge.node.title,
            vendor: edge.node.vendor,
            variantId: variant.id,
            inventoryItemId: variant.inventoryItem.id,
          };
        }
      }
    } catch (err) {
      console.warn(`Query for existing product failed with "${q}":`, err);
    }
  }

  return null;
}

/**
 * Create a new product in Shopify with fixed vendor "Meesa"
 */
export async function createShopifyProduct(
  admin: AdminGraphqlClient,
  item: ValidatedProductItem,
): Promise<{
  productId: string;
  variantId: string;
  inventoryItemId: string;
}> {
  const mutation = `#graphql
    mutation createProductWithDetails($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          title
          vendor
          status
          variants(first: 1) {
            edges {
              node {
                id
                price
                inventoryItem {
                  id
                  tracked
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface CreateProductData {
    productCreate?: {
      product?: {
        id: string;
        title: string;
        vendor: string;
        variants: {
          edges: Array<{
            node: {
              id: string;
              price: string;
              inventoryItem: {
                id: string;
                tracked: boolean;
              };
            };
          }>;
        };
      };
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const variables = {
    product: {
      title: item.title,
      descriptionHtml: item.descriptionHtml,
      vendor: item.vendor, // "Meesa"
      productType: item.collectionName,
      status: item.productStatus,
      tags: [item.collectionName, item.vendor],
    },
  };

  const data = await executeGraphQL<CreateProductData>(admin, mutation, variables);
  const userErrors = data?.productCreate?.userErrors;

  if (userErrors && userErrors.length > 0) {
    const errorMsgs = userErrors.map((u) => `${u.field?.join(".")}: ${u.message}`).join("; ");
    throw new Error(`productCreate error: ${errorMsgs}`);
  }

  const product = data?.productCreate?.product;
  if (!product) {
    throw new Error("productCreate returned empty product response.");
  }

  const variant = product.variants.edges[0]?.node;
  if (!variant || !variant.inventoryItem) {
    throw new Error("Created product does not have a default variant or inventory item.");
  }

  return {
    productId: product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
  };
}

/**
 * Update an existing product in Shopify
 */
export async function updateShopifyProduct(
  admin: AdminGraphqlClient,
  productId: string,
  item: ValidatedProductItem,
): Promise<void> {
  const mutation = `#graphql
    mutation updateProductDetails($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          title
          vendor
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface UpdateProductData {
    productUpdate?: {
      product?: { id: string };
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const variables = {
    product: {
      id: productId,
      title: item.title,
      descriptionHtml: item.descriptionHtml,
      vendor: item.vendor, // "Meesa"
      productType: item.collectionName,
      status: item.productStatus,
      tags: [item.collectionName, item.vendor],
    },
  };

  const data = await executeGraphQL<UpdateProductData>(admin, mutation, variables);
  const userErrors = data?.productUpdate?.userErrors;

  if (userErrors && userErrors.length > 0) {
    const errorMsgs = userErrors.map((u) => `${u.field?.join(".")}: ${u.message}`).join("; ");
    throw new Error(`productUpdate error: ${errorMsgs}`);
  }
}

/**
 * Update variant pricing, SKU, and enable inventory tracking with DENY policy
 */
export async function updateShopifyVariant(
  admin: AdminGraphqlClient,
  productId: string,
  variantId: string,
  item: ValidatedProductItem,
): Promise<void> {
  const mutation = `#graphql
    mutation updateVariantDetails($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          inventoryItem {
            id
            tracked
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface BulkVariantUpdateData {
    productVariantsBulkUpdate?: {
      productVariants?: Array<{ id: string }>;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const variantInput: Record<string, unknown> = {
    id: variantId,
    price: item.price,
    inventoryPolicy: "DENY",
    inventoryItem: {
      tracked: true,
      ...(item.productNumber ? { sku: item.productNumber } : {}),
    },
    ...(item.productNumber ? { barcode: item.productNumber } : {}),
  };

  const variables = {
    productId,
    variants: [variantInput],
  };

  const data = await executeGraphQL<BulkVariantUpdateData>(admin, mutation, variables);
  const userErrors = data?.productVariantsBulkUpdate?.userErrors;

  if (userErrors && userErrors.length > 0) {
    const errorMsgs = userErrors.map((u) => `${u.field?.join(".")}: ${u.message}`).join("; ");
    throw new Error(`productVariantsBulkUpdate error: ${errorMsgs}`);
  }
}

/**
 * Set inventory quantity to 0 ("SO") or 1 ("IS") at primary location
 */
export async function setInventoryQuantity(
  admin: AdminGraphqlClient,
  inventoryItemId: string,
  locationId: string,
  quantity: 0 | 1,
): Promise<void> {
  const setQuantitiesMutation = `#graphql
    mutation setInventoryQuantity($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          reason
          changes {
            name
            delta
            quantityAfterChange
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface SetQuantitiesData {
    inventorySetQuantities?: {
      inventoryAdjustmentGroup?: unknown;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const variables = {
    input: {
      reason: "correction",
      name: "available",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity,
        },
      ],
    },
  };

  try {
    const data = await executeGraphQL<SetQuantitiesData>(
      admin,
      setQuantitiesMutation,
      variables,
    );
    const userErrors = data?.inventorySetQuantities?.userErrors;

    if (userErrors && userErrors.length > 0) {
      const errorMsg = userErrors.map((u) => u.message).join("; ");
      // If error indicates item is not stocked, activate it first
      if (
        errorMsg.toLowerCase().includes("not stocked") ||
        errorMsg.toLowerCase().includes("not active")
      ) {
        await activateInventoryAtLocation(admin, inventoryItemId, locationId, quantity);
        return;
      }
      throw new Error(`inventorySetQuantities error: ${errorMsg}`);
    }
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.toLowerCase().includes("not stocked") || msg.toLowerCase().includes("not active")) {
      await activateInventoryAtLocation(admin, inventoryItemId, locationId, quantity);
      return;
    }
    throw err;
  }
}

/**
 * Fallback to activate inventory item at location if not already stocked
 */
async function activateInventoryAtLocation(
  admin: AdminGraphqlClient,
  inventoryItemId: string,
  locationId: string,
  quantity: 0 | 1,
): Promise<void> {
  const activateMutation = `#graphql
    mutation activateInventory($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
        inventoryLevel {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface ActivateData {
    inventoryActivate?: {
      inventoryLevel?: { id: string };
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const data = await executeGraphQL<ActivateData>(admin, activateMutation, {
    inventoryItemId,
    locationId,
    available: quantity,
  });

  const userErrors = data?.inventoryActivate?.userErrors;
  if (userErrors && userErrors.length > 0) {
    const errorMsgs = userErrors.map((u) => `${u.field?.join(".")}: ${u.message}`).join("; ");
    throw new Error(`inventoryActivate error: ${errorMsgs}`);
  }
}

/**
 * Add product to designated collection (e.g. "Drape Saree", "Indo western", "Suits")
 */
export async function addProductToCollection(
  admin: AdminGraphqlClient,
  collectionId: string,
  productId: string,
  isSmart: boolean,
): Promise<void> {
  if (isSmart) {
    // Smart / automated collections cannot accept manual product additions.
    // Inclusion is automatically driven by product tags & productType.
    return;
  }

  const mutation = `#graphql
    mutation addProductToCollection($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface AddCollectionData {
    collectionAddProducts?: {
      collection?: { id: string; title: string };
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const data = await executeGraphQL<AddCollectionData>(admin, mutation, {
    id: collectionId,
    productIds: [productId],
  });

  const userErrors = data?.collectionAddProducts?.userErrors;
  if (userErrors && userErrors.length > 0) {
    const msg = userErrors.map((u) => u.message).join("; ");
    // If it's a smart collection, do not throw
    if (msg.toLowerCase().includes("smart collection")) {
      return;
    }
    throw new Error(`collectionAddProducts error: ${msg}`);
  }
}
