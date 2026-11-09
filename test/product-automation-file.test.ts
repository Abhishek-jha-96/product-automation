import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { parseLocalSheetFile } from "../app/services/product-automation/parser.ts";
import { validateBatch } from "../app/services/product-automation/validator.ts";

const tmpCsv = path.resolve("./test/sample-catalog.csv");
const csvData = `PRODUCT NUMER,PRODUCT NAME,PRICE,SOLD OUT / IN STOCK,DESCRIPTION,Collection,Updated At,Update Status,Status,Link
DR-101,Floral Georgette Drape Saree,3200.00,IS,"Handcrafted modern draped saree with pre-stitched pleats",Drape Saree,2026-11-09,Ready,ACTIVE,https://example.com/saree-101.jpg
IW-201,Embroidered Crop Top and Draped Skirt,4800.00,SO,"Contemporary indo-western silhouette with pearl embroidery",Indo western,2026-11-09,Ready,ACTIVE,https://example.com/indo-201.jpg
SU-301,Silk Chanderi Kurta Suit,2600.00,IS,"Traditional straight cut suit with banarasi dupatta",Suits,2026-11-09,Ready,ACTIVE,https://example.com/suit-301.jpg`;

fs.writeFileSync(tmpCsv, csvData, "utf-8");

try {
  const rows = parseLocalSheetFile(tmpCsv);
  assert.strictEqual(rows.length, 3);

  const validation = validateBatch(rows);
  assert.strictEqual(validation.isValid, true);
  assert.strictEqual(validation.validRows.length, 3);

  // Assert expected mappings
  assert.strictEqual(validation.validRows[0].title, "Floral Georgette Drape Saree");
  assert.strictEqual(validation.validRows[0].price, "3200.00");
  assert.strictEqual(validation.validRows[0].stockStatus, "IS");
  assert.strictEqual(validation.validRows[0].inventoryQuantity, 1);
  assert.strictEqual(validation.validRows[0].collectionName, "Drape Saree");
  assert.strictEqual(validation.validRows[0].vendor, "Meesa");

  assert.strictEqual(validation.validRows[1].title, "Embroidered Crop Top and Draped Skirt");
  assert.strictEqual(validation.validRows[1].price, "4800.00");
  assert.strictEqual(validation.validRows[1].stockStatus, "SO");
  assert.strictEqual(validation.validRows[1].inventoryQuantity, 0);
  assert.strictEqual(validation.validRows[1].collectionName, "Indo western");
  assert.strictEqual(validation.validRows[1].vendor, "Meesa");

  assert.strictEqual(validation.validRows[2].collectionName, "Suits");
  assert.strictEqual(validation.validRows[2].inventoryQuantity, 1);
  assert.strictEqual(validation.validRows[2].vendor, "Meesa");

  console.log("✓ File reading & full batch validation test passed successfully! 🎉");
} finally {
  fs.unlinkSync(tmpCsv);
}
