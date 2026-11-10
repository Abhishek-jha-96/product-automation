import type {
  RawSheetRow,
  ValidatedProductItem,
  ValidationError,
  ValidationResult,
  StockStatus,
} from "./types.ts";

/**
 * Standard known collections defined in the store
 */
export const ALLOWED_COLLECTIONS = [
  "Drape Saree",
  "Indo western",
  "Suits",
] as const;

export const FIXED_VENDOR = "Meesa" as const;

/**
 * Normalize and match collection title to known collections
 */
export function normalizeCollectionName(rawCollection: string): string {
  const clean = rawCollection.trim();
  const lower = clean.toLowerCase();

  if (lower === "drape saree" || lower === "drapesaree" || lower === "drape sarees") {
    return "Drape Saree";
  }
  if (
    lower === "indo western" ||
    lower === "indo-western" ||
    lower === "indowestern"
  ) {
    return "Indo western";
  }
  if (lower === "suits" || lower === "suit") {
    return "Suits";
  }

  // Return formatted original if not in default 3
  return clean;
}

/**
 * Validate price string/number and format to valid Shopify Money string (e.g. "1299.00")
 */
export function sanitizePrice(rawPrice: unknown): { isValid: boolean; formatted: string; error?: string } {
  if (rawPrice === undefined || rawPrice === null || rawPrice === "") {
    return { isValid: false, formatted: "", error: "Price is required." };
  }

  const str = String(rawPrice).trim();
  // Strip currency symbols and commas
  const cleaned = str.replace(/[$,₹€£\s]/g, "");
  const num = parseFloat(cleaned);

  if (isNaN(num)) {
    return {
      isValid: false,
      formatted: "",
      error: `Invalid price "${rawPrice}". Must be a valid number.`,
    };
  }

  if (num < 0) {
    return {
      isValid: false,
      formatted: "",
      error: `Price cannot be negative: ${num}.`,
    };
  }

  return { isValid: true, formatted: num.toFixed(2) };
}

/**
 * Validate stock status: only "SO" (Sold Out) or "IS" (In Stock) are allowed
 */
export function sanitizeStockStatus(rawStatus: unknown): {
  isValid: boolean;
  stockStatus?: StockStatus;
  quantity?: 0 | 1;
  error?: string;
} {
  if (rawStatus === undefined || rawStatus === null || rawStatus === "") {
    return {
      isValid: false,
      error: 'SOLD OUT / IN STOCK is required. Must be "SO" or "IS".',
    };
  }

  const upper = String(rawStatus).trim().toUpperCase();

  if (upper === "SO") {
    return { isValid: true, stockStatus: "SO", quantity: 0 };
  }

  if (upper === "IS") {
    return { isValid: true, stockStatus: "IS", quantity: 1 };
  }

  return {
    isValid: false,
    error: `Invalid stock value "${rawStatus}". Must be "SO" (Sold Out) or "IS" (In Stock).`,
  };
}

/**
 * Validate and sanitize a single raw sheet row
 */
export function validateRow(
  raw: RawSheetRow,
  rowNumber: number,
): { item?: ValidatedProductItem; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  // 1. PRODUCT NAME (Title) - REQUIRED
  const rawTitle = raw["PRODUCT NAME"];
  const title = typeof rawTitle === "string" ? rawTitle.trim() : String(rawTitle || "").trim();
  if (!title) {
    errors.push({
      row: rowNumber,
      field: "PRODUCT NAME",
      message: "PRODUCT NAME (Title) is required and cannot be empty.",
      value: rawTitle,
    });
  }

  // 2. DESCRIPTION - REQUIRED
  const rawDesc = raw["DESCRIPTION"];
  const description = typeof rawDesc === "string" ? rawDesc.trim() : String(rawDesc || "").trim();
  if (!description) {
    errors.push({
      row: rowNumber,
      field: "DESCRIPTION",
      message: "DESCRIPTION is required and cannot be empty.",
      value: rawDesc,
    });
  }

  // 3. PRICE - REQUIRED
  const priceResult = sanitizePrice(raw["PRICE"]);
  if (!priceResult.isValid) {
    errors.push({
      row: rowNumber,
      field: "PRICE",
      message: priceResult.error || "Invalid PRICE.",
      value: raw["PRICE"],
    });
  }

  // 4. SOLD OUT / IN STOCK - REQUIRED
  const stockResult = sanitizeStockStatus(raw["SOLD OUT / IN STOCK"]);
  if (!stockResult.isValid || stockResult.stockStatus === undefined || stockResult.quantity === undefined) {
    errors.push({
      row: rowNumber,
      field: "SOLD OUT / IN STOCK",
      message: stockResult.error || 'SOLD OUT / IN STOCK must be "SO" or "IS".',
      value: raw["SOLD OUT / IN STOCK"],
    });
  }

  // 5. Collection - REQUIRED
  const rawCollection = raw["Collection"];
  const collectionStr = typeof rawCollection === "string" ? rawCollection.trim() : String(rawCollection || "").trim();
  if (!collectionStr) {
    errors.push({
      row: rowNumber,
      field: "Collection",
      message: 'Collection is required (expected: "Drape Saree", "Indo western", or "Suits").',
      value: rawCollection,
    });
  }
  const normalizedCollection = normalizeCollectionName(collectionStr);

  // Optional fields
  const productNumber = (raw["PRODUCT NUMER"] || raw["PRODUCT NUMBER"] || "").toString().trim() || undefined;

  let productStatus: "ACTIVE" | "DRAFT" = "ACTIVE";
  
  // Already Processed Product
  if (raw["Status"] == "Done") {
    errors.push({
      row: rowNumber,
      field: "Status",
      message: 'Status is "Done". Already processed move to next in the sheet.',
      value: raw["Status"],
    })
  }
  
  if (raw["Status"]) {
    const s = String(raw["Status"]).trim().toUpperCase();
    if (s === "DRAFT" || s === "INACTIVE" || s === "ARCHIVED") {
      productStatus = "DRAFT";
    }
  }

  const link = raw["Link"] ? String(raw["Link"]).trim() : undefined;
  const updatedAt = raw["Updated At"] ? String(raw["Updated At"]).trim() : undefined;
  const updateStatus = raw["Update Status"] ? String(raw["Update Status"]).trim() : undefined;

  if (errors.length > 0) {
    return { errors };
  }

  const item: ValidatedProductItem = {
    rowNumber,
    productNumber,
    title,
    descriptionHtml: description,
    price: priceResult.formatted,
    stockStatus: stockResult.stockStatus!,
    inventoryQuantity: stockResult.quantity!,
    vendor: FIXED_VENDOR,
    collectionName: normalizedCollection,
    productStatus,
    link,
    updatedAt,
    updateStatus,
  };

  return { item, errors: [] };
}

/**
 * Pre-flight validation across the full batch of rows:
 * - Checks individual row field constraints
 * - Detects duplicate product numbers / SKUs
 * - Detects duplicate titles
 */
export function validateBatch(rawRows: RawSheetRow[]): ValidationResult {
  const errors: ValidationError[] = [];
  const validRows: ValidatedProductItem[] = [];

  const seenProductNumbers = new Map<string, number>();
  const seenTitles = new Map<string, number>();

  rawRows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for 0-index, +1 for header row
    const { item, errors: rowErrors } = validateRow(row, rowNumber);

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    if (item) {
      // Check duplicate product numbers (if provided)
      if (item.productNumber) {
        const existingRow = seenProductNumbers.get(item.productNumber.toLowerCase());
        if (existingRow !== undefined) {
          errors.push({
            row: rowNumber,
            field: "PRODUCT NUMER",
            message: `Duplicate PRODUCT NUMER "${item.productNumber}". First seen on row ${existingRow}.`,
            value: item.productNumber,
          });
        } else {
          seenProductNumbers.set(item.productNumber.toLowerCase(), rowNumber);
        }
      }

      // Check duplicate titles
      const titleKey = item.title.toLowerCase();
      const existingTitleRow = seenTitles.get(titleKey);
      if (existingTitleRow !== undefined) {
        errors.push({
          row: rowNumber,
          field: "PRODUCT NAME",
          message: `Duplicate PRODUCT NAME "${item.title}". First seen on row ${existingTitleRow}.`,
          value: item.title,
        });
      } else {
        seenTitles.set(titleKey, rowNumber);
      }

      validRows.push(item);
    }
  });

  return {
    isValid: errors.length === 0,
    totalRows: rawRows.length,
    validRows,
    errors,
  };
}
