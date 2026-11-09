import assert from "node:assert";
import {
  parseDelimitedText,
  parseJsonData,
} from "../app/services/product-automation/parser.ts";
import {
  validateBatch,
  validateRow,
  sanitizePrice,
  sanitizeStockStatus,
  normalizeCollectionName,
} from "../app/services/product-automation/validator.ts";

console.log("=== Running Product Automation Unit Tests ===");

// 1. Test Price Sanitizer
{
  const valid1 = sanitizePrice("1299.00");
  assert.strictEqual(valid1.isValid, true);
  assert.strictEqual(valid1.formatted, "1299.00");

  const valid2 = sanitizePrice("₹2,499.50");
  assert.strictEqual(valid2.isValid, true);
  assert.strictEqual(valid2.formatted, "2499.50");

  const valid3 = sanitizePrice("$150");
  assert.strictEqual(valid3.isValid, true);
  assert.strictEqual(valid3.formatted, "150.00");

  const invalidNegative = sanitizePrice("-100");
  assert.strictEqual(invalidNegative.isValid, false);

  const invalidText = sanitizePrice("free");
  assert.strictEqual(invalidText.isValid, false);

  console.log("✓ sanitizePrice tests passed");
}

// 2. Test Stock Status Sanitizer ("SO" -> 0, "IS" -> 1)
{
  const so = sanitizeStockStatus("SO");
  assert.strictEqual(so.isValid, true);
  assert.strictEqual(so.stockStatus, "SO");
  assert.strictEqual(so.quantity, 0);

  const is = sanitizeStockStatus("IS");
  assert.strictEqual(is.isValid, true);
  assert.strictEqual(is.stockStatus, "IS");
  assert.strictEqual(is.quantity, 1);

  const invalid = sanitizeStockStatus("AVAILABLE");
  assert.strictEqual(invalid.isValid, false);

  const empty = sanitizeStockStatus("");
  assert.strictEqual(empty.isValid, false);

  console.log('✓ sanitizeStockStatus tests passed ("SO" -> 0, "IS" -> 1)');
}

// 3. Test Collection Normalization ("Drape Saree", "Indo western", "Suits")
{
  assert.strictEqual(normalizeCollectionName("drape saree"), "Drape Saree");
  assert.strictEqual(normalizeCollectionName("indo western"), "Indo western");
  assert.strictEqual(normalizeCollectionName("indo-western"), "Indo western");
  assert.strictEqual(normalizeCollectionName("suits"), "Suits");
  assert.strictEqual(normalizeCollectionName("suit"), "Suits");

  console.log("✓ normalizeCollectionName tests passed");
}

// 4. Test Delimited Text Parser (CSV / TSV) with RFC 4180 and JSON Parser
{
  const sampleCsv = `PRODUCT NUMER,PRODUCT NAME,PRICE,SOLD OUT / IN STOCK,DESCRIPTION,Collection,Updated At,Update Status,Status,Link
SKU-001,"Red Silk Saree, Embroidered",2999.00,IS,"Handcrafted luxury silk saree
with intricate zari work",Drape Saree,2026-11-09,Ready,ACTIVE,https://example.com/img1.jpg
SKU-002,Contemporary Fusion Set,4500.00,SO,Modern fusion tunic and draped pant,Indo western,2026-11-09,Ready,ACTIVE,
SKU-003,Velvet Anarkali Suit,3800.00,IS,Royal velvet anarkali suit,Suits,2026-11-09,Ready,ACTIVE,`;

  const parsed = parseDelimitedText(sampleCsv);
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[0]["PRODUCT NUMER"], "SKU-001");
  assert.strictEqual(parsed[0]["PRODUCT NAME"], "Red Silk Saree, Embroidered");
  assert.strictEqual(parsed[0]["PRICE"], "2999.00");
  assert.strictEqual(parsed[0]["SOLD OUT / IN STOCK"], "IS");
  assert.ok(parsed[0]["DESCRIPTION"]?.includes("intricate zari work"));
  assert.strictEqual(parsed[0]["Collection"], "Drape Saree");
  assert.strictEqual(parsed[0]["Link"], "https://example.com/img1.jpg");

  // Also test JSON parsing
  const jsonParsed = parseJsonData(JSON.stringify(parsed));
  assert.strictEqual(jsonParsed.length, 3);
  assert.strictEqual(jsonParsed[0]["PRODUCT NAME"], "Red Silk Saree, Embroidered");

  // Test single row validator
  const rowResult = validateRow(parsed[0], 2);
  assert.strictEqual(rowResult.errors.length, 0);
  assert.strictEqual(rowResult.item?.title, "Red Silk Saree, Embroidered");

  console.log("✓ parseDelimitedText CSV & JSON tests passed");
}

// 5. Test Batch Validation & Field Mapping
{
  const rawData = [
    {
      "PRODUCT NUMER": "MS-001",
      "PRODUCT NAME": "Emerald Drape Saree",
      PRICE: "3500.00",
      "SOLD OUT / IN STOCK": "IS",
      DESCRIPTION: "Emerald green pre-draped saree with ruffle border.",
      Collection: "Drape Saree",
      Status: "ACTIVE",
      Link: "https://example.com/saree1.jpg",
    },
    {
      "PRODUCT NUMER": "MS-002",
      "PRODUCT NAME": "Ivory Indo-Western Dhoti Set",
      PRICE: "4200.00",
      "SOLD OUT / IN STOCK": "SO",
      DESCRIPTION: "Chic indo-western crop top and jacket with dhoti.",
      Collection: "Indo western",
      Status: "ACTIVE",
    },
    {
      "PRODUCT NUMER": "MS-003",
      "PRODUCT NAME": "Pastel Pink Sharara Suit",
      PRICE: "2800.00",
      "SOLD OUT / IN STOCK": "IS",
      DESCRIPTION: "Georgette sharara suit with gota patti detailing.",
      Collection: "Suits",
      Status: "DRAFT",
    },
  ];

  const validation = validateBatch(rawData);
  assert.strictEqual(validation.isValid, true);
  assert.strictEqual(validation.validRows.length, 3);
  assert.strictEqual(validation.errors.length, 0);

  // Check Vendor = "Meesa" mapping
  assert.strictEqual(validation.validRows[0].vendor, "Meesa");
  assert.strictEqual(validation.validRows[1].vendor, "Meesa");
  assert.strictEqual(validation.validRows[2].vendor, "Meesa");

  // Check Inventory Quantity mapping (IS -> 1, SO -> 0)
  assert.strictEqual(validation.validRows[0].inventoryQuantity, 1);
  assert.strictEqual(validation.validRows[0].stockStatus, "IS");
  assert.strictEqual(validation.validRows[1].inventoryQuantity, 0);
  assert.strictEqual(validation.validRows[1].stockStatus, "SO");
  assert.strictEqual(validation.validRows[2].inventoryQuantity, 1);
  assert.strictEqual(validation.validRows[2].stockStatus, "IS");

  // Check Collections mapping
  assert.strictEqual(validation.validRows[0].collectionName, "Drape Saree");
  assert.strictEqual(validation.validRows[1].collectionName, "Indo western");
  assert.strictEqual(validation.validRows[2].collectionName, "Suits");

  // Check Status mapping
  assert.strictEqual(validation.validRows[0].productStatus, "ACTIVE");
  assert.strictEqual(validation.validRows[2].productStatus, "DRAFT");

  console.log("✓ validateBatch valid rows tests passed");
}

// 6. Test Validation Errors & Required Fields
{
  const invalidRows = [
    {
      // Missing PRODUCT NAME
      "PRODUCT NUMER": "ERR-001",
      PRICE: "1000",
      "SOLD OUT / IN STOCK": "IS",
      DESCRIPTION: "A test description",
      Collection: "Suits",
    },
    {
      // Missing PRICE
      "PRODUCT NUMER": "ERR-002",
      "PRODUCT NAME": "Invalid Price Product",
      "SOLD OUT / IN STOCK": "SO",
      DESCRIPTION: "A test description",
      Collection: "Drape Saree",
    },
    {
      // Invalid SOLD OUT / IN STOCK (not SO or IS)
      "PRODUCT NUMER": "ERR-003",
      "PRODUCT NAME": "Invalid Stock Product",
      PRICE: "1500",
      "SOLD OUT / IN STOCK": "IN STOCK", // must be IS or SO
      DESCRIPTION: "A test description",
      Collection: "Indo western",
    },
    {
      // Missing DESCRIPTION
      "PRODUCT NUMER": "ERR-004",
      "PRODUCT NAME": "No Description Product",
      PRICE: "1500",
      "SOLD OUT / IN STOCK": "IS",
      Collection: "Suits",
    },
    {
      // Missing Collection
      "PRODUCT NUMER": "ERR-005",
      "PRODUCT NAME": "No Collection Product",
      PRICE: "1500",
      "SOLD OUT / IN STOCK": "IS",
      DESCRIPTION: "Valid description",
    },
  ];

  const validation = validateBatch(invalidRows);
  assert.strictEqual(validation.isValid, false);
  assert.strictEqual(validation.errors.length, 5);
  console.log("✓ validateBatch invalid fields error handling tests passed");
}

// 7. Test Duplicate Detection (Duplicate SKU and Duplicate Title)
{
  const dupRows = [
    {
      "PRODUCT NUMER": "DUP-001",
      "PRODUCT NAME": "Original Product",
      PRICE: "1000",
      "SOLD OUT / IN STOCK": "IS",
      DESCRIPTION: "Desc 1",
      Collection: "Suits",
    },
    {
      "PRODUCT NUMER": "DUP-001", // Duplicate SKU
      "PRODUCT NAME": "Another Product",
      PRICE: "2000",
      "SOLD OUT / IN STOCK": "SO",
      DESCRIPTION: "Desc 2",
      Collection: "Suits",
    },
    {
      "PRODUCT NUMER": "DUP-002",
      "PRODUCT NAME": "Original Product", // Duplicate Title
      PRICE: "3000",
      "SOLD OUT / IN STOCK": "IS",
      DESCRIPTION: "Desc 3",
      Collection: "Suits",
    },
  ];

  const validation = validateBatch(dupRows);
  assert.strictEqual(validation.isValid, false);
  assert.ok(validation.errors.some((e) => e.message.includes("Duplicate PRODUCT NUMER")));
  assert.ok(validation.errors.some((e) => e.message.includes("Duplicate PRODUCT NAME")));
  console.log("✓ Duplicate detection tests passed");
}

console.log("\nALL PRODUCT AUTOMATION UNIT TESTS PASSED SUCCESSFULLY! 🎉");
