/**
 * Data structures and types for the Product Automation pipeline.
 */

export interface RawSheetRow {
  "PRODUCT NUMER"?: string;
  "PRODUCT NUMBER"?: string;
  "PRODUCT NAME"?: string;
  PRICE?: string | number;
  "SOLD OUT / IN STOCK"?: string;
  DESCRIPTION?: string;
  Collection?: string;
  "Updated At"?: string;
  "Update Status"?: string;
  Status?: string;
  Link?: string;
  [key: string]: unknown;
}

export type StockStatus = "SO" | "IS";

export interface ValidatedProductItem {
  rowNumber: number;
  productNumber?: string;
  title: string;
  descriptionHtml: string;
  price: string;
  stockStatus: StockStatus;
  inventoryQuantity: 0 | 1;
  vendor: "Meesa";
  collectionName: "Drape Saree" | "Indo western" | "Suits" | string;
  productStatus: "ACTIVE" | "DRAFT";
  link?: string;
  updatedAt?: string;
  updateStatus?: string;
}

export interface ValidationError {
  row: number;
  field: string;
  message: string;
  value?: unknown;
}

export interface ValidationResult {
  isValid: boolean;
  totalRows: number;
  validRows: ValidatedProductItem[];
  errors: ValidationError[];
}

export interface ShopifyLocation {
  id: string;
  name: string;
  isPrimary: boolean;
}

export interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
  isSmart: boolean;
}

export type SyncActionType = "CREATED" | "UPDATED" | "FAILED" | "SKIPPED";

export interface ProductSyncResult {
  row: number;
  productNumber?: string;
  title: string;
  action: SyncActionType;
  productId?: string;
  variantId?: string;
  inventoryQuantity: number;
  collectionId?: string;
  collectionName?: string;
  mediaStatus?: "ATTACHED" | "SKIPPED" | "FAILED";
  errors?: string[];
}

export interface BatchProcessReport {
  totalProcessed: number;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
  skippedCount: number;
  results: ProductSyncResult[];
  validationErrors: ValidationError[];
  timestamp: string;
}
