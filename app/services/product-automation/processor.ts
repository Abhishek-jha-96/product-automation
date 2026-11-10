import fs from "fs";
import path from "path";

import type {
  AdminGraphqlClient,
} from "./shopify-client.ts";
import {
  getShopCollections,
  getShopVendors,
  getPrimaryLocation,
  findExistingProduct,
  createShopifyProduct,
  updateShopifyProduct,
  updateShopifyVariant,
  setInventoryQuantity,
  addProductToCollection,
} from "./shopify-client.ts";
import { attachProductMedia } from "./media-uploader.ts";
import { parseDelimitedText, parseJsonData, parseLocalSheetFile } from "./parser.ts";
import { validateBatch, normalizeCollectionName } from "./validator.ts";
import type {
  BatchProcessReport,
  ProductSyncResult,
  RawSheetRow,
  ShopifyCollection,
  ShopifyLocation,
  ValidatedProductItem,
} from "./types.ts";

export interface ProcessOptions {
  filePath?: string;
  rawText?: string;
  rawRows?: RawSheetRow[];
  stopOnFirstError?: boolean;
}

/**
 * Process a single validated item through the Shopify catalog pipeline
 */
async function processSingleProduct(
  admin: AdminGraphqlClient,
  item: ValidatedProductItem,
  collectionsMap: Map<string, ShopifyCollection>,
  primaryLocation: ShopifyLocation,
): Promise<ProductSyncResult> {
  const result: ProductSyncResult = {
    row: item.rowNumber,
    productNumber: item.productNumber,
    title: item.title,
    action: "FAILED",
    inventoryQuantity: item.inventoryQuantity,
    collectionName: item.collectionName,
  };

  try {
    // 1. Check if product already exists (by SKU or Title)
    const existing = await findExistingProduct(admin, item);

    let productId: string;
    let variantId: string;
    let inventoryItemId: string;

    if (existing) {
      // UPDATE existing product
      productId = existing.id;
      variantId = existing.variantId;
      inventoryItemId = existing.inventoryItemId;

      await updateShopifyProduct(admin, productId, item);
      await updateShopifyVariant(admin, productId, variantId, item);
      result.action = "UPDATED";
    } else {
      // CREATE new product
      const created = await createShopifyProduct(admin, item);
      productId = created.productId;
      variantId = created.variantId;
      inventoryItemId = created.inventoryItemId;

      // Update variant details (price, SKU, inventory policy)
      await updateShopifyVariant(admin, productId, variantId, item);
      result.action = "CREATED";
    }

    result.productId = productId;
    result.variantId = variantId;

    // 2. Set inventory quantity: 0 for "SO", 1 for "IS"
    try {
      await setInventoryQuantity(
        admin,
        inventoryItemId,
        primaryLocation.id,
        item.inventoryQuantity,
      );
    } catch (invErr) {
      console.warn(`Inventory update warning for "${item.title}":`, invErr);
      result.errors = result.errors || [];
      result.errors.push(`Inventory warning: ${(invErr as Error).message}`);
    }

    // 3. Attach to collection ("Drape Saree", "Indo western", "Suits")
    const normalizedTarget = normalizeCollectionName(item.collectionName).toLowerCase();
    const targetCollection = collectionsMap.get(normalizedTarget);

    if (targetCollection) {
      result.collectionId = targetCollection.id;
      try {
        await addProductToCollection(
          admin,
          targetCollection.id,
          productId,
          targetCollection.isSmart,
        );
      } catch (collErr) {
        console.warn(`Collection assignment warning for "${item.title}":`, collErr);
        result.errors = result.errors || [];
        result.errors.push(`Collection warning: ${(collErr as Error).message}`);
      }
    } else {
      result.errors = result.errors || [];
      result.errors.push(
        `Collection "${item.collectionName}" not found in Shopify store collections.`,
      );
    }

    // 4. Attach Media if image exists
    const folderPath = path.join(
      process.cwd(),
      "public",
      String(item.productNumber)
    );

    try {
      if (fs.existsSync(folderPath)) {
        // Get all image files from the product folder
        const imageFiles = fs
          .readdirSync(folderPath)
          .filter((file) => /\.(jpg|jpeg|png|webp|gif)$/i.test(file));

        if (imageFiles.length > 0) {
          const imageUrls = imageFiles.map(
            (file) => `/${item.productNumber}/${file}`
          );

          for (const imageUrl of imageUrls) {
            const mediaAttached = await attachProductMedia(
              admin,
              productId,
              imageUrl,
              item.title
            );

            if (!mediaAttached) {
              throw new Error(`Failed to attach image: ${imageUrl}`);
            }
          }

          result.mediaStatus = "ATTACHED";
        } else {
          result.mediaStatus = "SKIPPED";
        }
      } else {
        result.mediaStatus = "SKIPPED";
      }
    } catch (medErr) {
      console.warn(
        `Media attachment warning for "${item.title}":`,
        medErr
      );

      result.mediaStatus = "FAILED";
      result.errors = result.errors || [];
      result.errors.push(
        `Media error: ${(medErr as Error).message}`
      );
    }

    return result;
  } catch (err) {
    result.action = "FAILED";
    result.errors = [(err as Error).message || "Unknown error occurred"];
    return result;
  }
}

/**
 * Main Product Processing Pipeline
 */
export async function processProductCatalog(
  admin: AdminGraphqlClient,
  options: ProcessOptions,
): Promise<BatchProcessReport> {
  // Step 1: Ingest raw spreadsheet data
  let rawRows: RawSheetRow[] = [];

  if (options.rawRows && options.rawRows.length > 0) {
    rawRows = options.rawRows;
  } else if (options.filePath) {
    rawRows = parseLocalSheetFile(options.filePath);
  } else if (options.rawText) {
    const trimmed = options.rawText.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      rawRows = parseJsonData(trimmed);
    } else {
      rawRows = parseDelimitedText(trimmed);
    }
  } else {
    throw new Error(
      "No input data provided. Specify filePath, rawText, or rawRows.",
    );
  }

  // Step 2: Validate batch
  const validation = validateBatch(rawRows);

  const report: BatchProcessReport = {
    totalProcessed: rawRows.length,
    createdCount: 0,
    updatedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    results: [],
    validationErrors: validation.errors,
    timestamp: new Date().toISOString(),
  };

  // If there are no valid rows to process
  if (validation.validRows.length === 0) {
    report.failedCount = rawRows.length;
    return report;
  }

  // Step 3: Fetch store prerequisites (collections, vendors, locations)
  const [shopCollections, shopVendors, primaryLocation] = await Promise.all([
    getShopCollections(admin),
    getShopVendors(admin),
    getPrimaryLocation(admin),
  ]);

  console.log(`Verified shop vendors: ${shopVendors.join(", ") || "none found"}`);
  console.log(
    `Found store collections: ${shopCollections.map((c) => c.title).join(", ")}`,
  );
  console.log(`Using primary inventory location: ${primaryLocation.name} (${primaryLocation.id})`);

  // Build collection lookup map (normalized lowercase name -> collection)
  const collectionsMap = new Map<string, ShopifyCollection>();
  for (const c of shopCollections) {
    collectionsMap.set(normalizeCollectionName(c.title).toLowerCase(), c);
    collectionsMap.set(c.title.toLowerCase(), c);
  }

  // Step 4: Process valid products
  for (const item of validation.validRows) {
    const syncResult = await processSingleProduct(
      admin,
      item,
      collectionsMap,
      primaryLocation,
    );

    report.results.push(syncResult);

    if (syncResult.action === "CREATED") {
      report.createdCount++;
    } else if (syncResult.action === "UPDATED") {
      report.updatedCount++;
    } else if (syncResult.action === "FAILED") {
      report.failedCount++;
      if (options.stopOnFirstError) {
        break;
      }
    } else {
      report.skippedCount++;
    }
  }

  // Invalid rows count as failed
  const invalidRowsCount = rawRows.length - validation.validRows.length;
  report.failedCount += invalidRowsCount;

  return report;
}
