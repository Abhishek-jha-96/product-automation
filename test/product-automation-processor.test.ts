import assert from "node:assert";
import { processProductCatalog } from "../app/services/product-automation/processor.ts";
import type { AdminGraphqlClient } from "../app/services/product-automation/shopify-client.ts";

console.log("=== Testing Mock Shopify End-to-End Processing Pipeline ===");

// Create a realistic mock Shopify Admin GraphQL client
const mockAdmin: AdminGraphqlClient = {
  async graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response> {
    const vars = options?.variables || {};

    // 1. Collections query
    if (query.includes("query getCollections")) {
      return new Response(
        JSON.stringify({
          data: {
            collections: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Collection/101",
                    title: "Drape Saree",
                    handle: "drape-saree",
                    ruleSet: null,
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Collection/102",
                    title: "Indo western",
                    handle: "indo-western",
                    ruleSet: null,
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Collection/103",
                    title: "Suits",
                    handle: "suits",
                    ruleSet: null,
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 2. Vendors query
    if (query.includes("query getShopVendors")) {
      return new Response(
        JSON.stringify({
          data: {
            shop: {
              productVendors: {
                edges: [{ node: "Meesa" }],
              },
            },
          },
        }),
        { status: 200 },
      );
    }

    // 3. Locations query
    if (query.includes("query getLocations")) {
      return new Response(
        JSON.stringify({
          data: {
            locations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Location/9001",
                    name: "Main Boutique Store",
                    isPrimary: true,
                    isActive: true,
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 4. Product lookup query
    if (query.includes("query findProduct")) {
      // Simulate SKU-001 already existing, others not existing
      if (typeof vars.query === "string" && vars.query.includes("SKU-001")) {
        return new Response(
          JSON.stringify({
            data: {
              products: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/Product/1",
                      title: "Existing Drape Saree",
                      vendor: "Meesa",
                      status: "ACTIVE",
                      variants: {
                        edges: [
                          {
                            node: {
                              id: "gid://shopify/ProductVariant/11",
                              price: "2500.00",
                              sku: "SKU-001",
                              inventoryItem: {
                                id: "gid://shopify/InventoryItem/111",
                                tracked: true,
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            products: { edges: [] },
          },
        }),
        { status: 200 },
      );
    }

    // 5. Product update mutation
    if (query.includes("mutation updateProductDetails")) {
      return new Response(
        JSON.stringify({
          data: {
            productUpdate: {
              product: {
                id: (vars.product as Record<string, unknown>).id,
                title: (vars.product as Record<string, unknown>).title,
                vendor: (vars.product as Record<string, unknown>).vendor,
                status: (vars.product as Record<string, unknown>).status,
              },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 6. Product create mutation
    if (query.includes("mutation createProductWithDetails")) {
      return new Response(
        JSON.stringify({
          data: {
            productCreate: {
              product: {
                id: "gid://shopify/Product/2",
                title: (vars.product as Record<string, unknown>).title,
                vendor: (vars.product as Record<string, unknown>).vendor,
                status: (vars.product as Record<string, unknown>).status,
                variants: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/ProductVariant/22",
                        price: "100.00",
                        inventoryItem: {
                          id: "gid://shopify/InventoryItem/222",
                          tracked: false,
                        },
                      },
                    },
                  ],
                },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 7. Variant update mutation
    if (query.includes("mutation updateVariantDetails")) {
      return new Response(
        JSON.stringify({
          data: {
            productVariantsBulkUpdate: {
              productVariants: [{ id: "gid://shopify/ProductVariant/22" }],
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 8. Inventory set quantities mutation
    if (query.includes("mutation setInventoryQuantity")) {
      return new Response(
        JSON.stringify({
          data: {
            inventorySetQuantities: {
              inventoryAdjustmentGroup: { reason: "correction", changes: [] },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 9. Collection add products mutation
    if (query.includes("mutation addProductToCollection")) {
      return new Response(
        JSON.stringify({
          data: {
            collectionAddProducts: {
              collection: { id: vars.id, title: "Test Collection" },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }

    // 10. Media creation mutation
    if (query.includes("mutation productCreateMedia")) {
      return new Response(
        JSON.stringify({
          data: {
            productCreateMedia: {
              media: [{ id: "gid://shopify/MediaImage/555", status: "READY" }],
              mediaUserErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unhandled mock query: ${query.substring(0, 50)}...`);
  },
};

// Test Batch Processing
const rawCsv = `PRODUCT NUMER,PRODUCT NAME,PRICE,SOLD OUT / IN STOCK,DESCRIPTION,Collection,Updated At,Update Status,Status,Link
SKU-001,Updated Drape Saree,3999.00,IS,Updated description,Drape Saree,2026-11-09,Ready,ACTIVE,https://example.com/saree.jpg
SKU-002,New Indo Western Gown,5200.00,SO,New modern gown,Indo western,2026-11-09,Ready,ACTIVE,`;

async function run() {
  const report = await processProductCatalog(mockAdmin, { rawText: rawCsv });

  assert.strictEqual(report.totalProcessed, 2);
  assert.strictEqual(report.updatedCount, 1); // SKU-001 updated
  assert.strictEqual(report.createdCount, 1); // SKU-002 created
  assert.strictEqual(report.failedCount, 0);

  // Check item 1 (Updated item, IS -> 1)
  assert.strictEqual(report.results[0].action, "UPDATED");
  assert.strictEqual(report.results[0].productId, "gid://shopify/Product/1");
  assert.strictEqual(report.results[0].inventoryQuantity, 1);
  assert.strictEqual(report.results[0].collectionId, "gid://shopify/Collection/101");
  assert.strictEqual(report.results[0].mediaStatus, "ATTACHED");

  // Check item 2 (Created item, SO -> 0)
  assert.strictEqual(report.results[1].action, "CREATED");
  assert.strictEqual(report.results[1].productId, "gid://shopify/Product/2");
  assert.strictEqual(report.results[1].inventoryQuantity, 0);
  assert.strictEqual(report.results[1].collectionId, "gid://shopify/Collection/102");
  assert.strictEqual(report.results[1].mediaStatus, "SKIPPED");

  console.log("✓ Mock End-to-End Batch Catalog Processing Succeeded! 🎉");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
