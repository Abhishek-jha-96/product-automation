import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getShopCollections,
  getShopVendors,
  getPrimaryLocation,
} from "../services/product-automation/shopify-client.ts";
import {
  validateBatch,
} from "../services/product-automation/validator.ts";
import {
  parseDelimitedText,
  parseJsonData,
  parseLocalSheetFile,
} from "../services/product-automation/parser.ts";
import {
  processProductCatalog,
} from "../services/product-automation/processor.ts";
import type {
  BatchProcessReport,
  ValidationResult,
  RawSheetRow,
} from "../services/product-automation/types.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  try {
    const [collections, vendors, location] = await Promise.all([
      getShopCollections(admin).catch(() => []),
      getShopVendors(admin).catch(() => []),
      getPrimaryLocation(admin).catch(() => ({
        id: "",
        name: "Default Location",
        isPrimary: true,
      })),
    ]);

    const hasMeesaVendor = vendors.some(
      (v) => v.trim().toLowerCase() === "meesa",
    );

    return {
      collections,
      vendors,
      hasMeesaVendor,
      primaryLocation: location,
    };
  } catch (err) {
    console.warn("Loader failed to query shop info:", err);
    return {
      collections: [],
      vendors: [],
      hasMeesaVendor: false,
      primaryLocation: { id: "", name: "Default Location", isPrimary: true },
    };
  }
};

type ActionData =
  | {
      ok: true;
      mode: "validate";
      validation: ValidationResult;
      totalParsed: number;
    }
  | {
      ok: true;
      mode: "sync";
      report: BatchProcessReport;
    }
  | {
      ok: false;
      error: string;
    };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent")?.toString() || "validate";
  const inputMode = formData.get("inputMode")?.toString() || "text";
  const filePath = formData.get("filePath")?.toString()?.trim();
  const rawText = formData.get("rawText")?.toString()?.trim();

  try {
    let rawRows: RawSheetRow[] = [];

    if (inputMode === "file") {
      if (!filePath) {
        return { ok: false, error: "Please enter a valid local file path." };
      }
      rawRows = parseLocalSheetFile(filePath);
    } else {
      if (!rawText) {
        return { ok: false, error: "Please paste spreadsheet CSV or JSON content." };
      }
      if (rawText.startsWith("[") || rawText.startsWith("{")) {
        rawRows = parseJsonData(rawText);
      } else {
        rawRows = parseDelimitedText(rawText);
      }
    }

    if (rawRows.length === 0) {
      return { ok: false, error: "No product rows found in the provided spreadsheet." };
    }

    if (intent === "validate") {
      const validation = validateBatch(rawRows);
      return {
        ok: true,
        mode: "validate",
        validation,
        totalParsed: rawRows.length,
      };
    }

    // Process Catalog Sync
    const report = await processProductCatalog(admin, { rawRows });
    return {
      ok: true,
      mode: "sync",
      report,
    };
  } catch (err) {
    console.error("Action error:", err);
    return {
      ok: false,
      error: (err as Error).message || "An unexpected error occurred during processing.",
    };
  }
};

const SAMPLE_CSV = `PRODUCT NUMER,PRODUCT NAME,PRICE,SOLD OUT / IN STOCK,DESCRIPTION,Collection,Updated At,Update Status,Status,Link
MS-DS-01,Crimson Georgette Drape Saree,3499.00,IS,"Handcrafted pre-pleated drape saree with delicate scalloped embroidery.",Drape Saree,2026-11-09,Ready,ACTIVE,
MS-IW-02,Sage Green Indo-Western Skirt Set,4999.00,SO,"Contemporary draped cape and high-waisted palazzo ensemble.",Indo western,2026-11-09,Ready,ACTIVE,
MS-SU-03,Ivory Raw Silk Anarkali Suit,3899.00,IS,"Classic pure silk anarkali with organza dupatta and gotta work.",Suits,2026-11-09,Ready,ACTIVE,`;

export default function Index() {
  const { collections, hasMeesaVendor, primaryLocation } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting" || navigation.state === "loading";

  const [inputMode, setInputMode] = useState<"text" | "file">("text");
  const [filePath, setFilePath] = useState("");
  const [rawText, setRawText] = useState(SAMPLE_CSV);

  useEffect(() => {
    if (actionData && actionData.ok) {
      if (actionData.mode === "sync") {
        shopify.toast.show(
          `Sync Complete: ${actionData.report.createdCount} created, ${actionData.report.updatedCount} updated, ${actionData.report.failedCount} failed`,
        );
      } else if (actionData.mode === "validate") {
        if (actionData.validation.isValid) {
          shopify.toast.show("Validation passed: All rows valid!");
        } else {
          shopify.toast.show(`Validation found ${actionData.validation.errors.length} issues.`);
        }
      }
    } else if (actionData && !actionData.ok) {
      shopify.toast.show(`Error: ${actionData.error}`);
    }
  }, [actionData, shopify]);

  const handleValidate = () => {
    const fd = new FormData();
    fd.append("intent", "validate");
    fd.append("inputMode", inputMode);
    fd.append("filePath", filePath);
    fd.append("rawText", rawText);
    submit(fd, { method: "POST" });
  };

  const handleSync = () => {
    const fd = new FormData();
    fd.append("intent", "sync");
    fd.append("inputMode", inputMode);
    fd.append("filePath", filePath);
    fd.append("rawText", rawText);
    submit(fd, { method: "POST" });
  };

  return (
    <s-page heading="Shopify Product Automation Bot">
      <s-button
        slot="primary-action"
        onClick={handleSync}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Sync to Shopify Store
      </s-button>

      {/* Overview & Store Prerequisites */}
      <s-section heading="Store Configuration & Mappings">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Automated pipeline converting local spreadsheets to Shopify products adhering to strict store constraints.
          </s-paragraph>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
              <div>
                <strong>Fixed Vendor:</strong>
                <div>
                  <span style={{ color: "#008060", fontWeight: 600 }}>Meesa</span>{" "}
                  {hasMeesaVendor ? "(Confirmed in store)" : "(Will be assigned)"}
                </div>
              </div>
              <div>
                <strong>Target Collections:</strong>
                <div>
                  {["Drape Saree", "Indo western", "Suits"].map((cName) => {
                    const exists = collections.some(
                      (col) => col.title.toLowerCase() === cName.toLowerCase(),
                    );
                    return (
                      <span
                        key={cName}
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          marginRight: "6px",
                          marginBottom: "4px",
                          borderRadius: "4px",
                          fontSize: "12px",
                          background: exists ? "#e3f1df" : "#fbeae5",
                          color: exists ? "#108043" : "#bf0711",
                        }}
                      >
                        {cName} {exists ? "✓" : "!"}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div>
                <strong>Stock Logic (SOLD OUT / IN STOCK):</strong>
                <div style={{ fontSize: "13px" }}>
                  <code>IS</code> &rarr; Qty 1 (In Stock) | <code>SO</code> &rarr; Qty 0 (Sold Out)
                </div>
              </div>
              <div>
                <strong>Inventory Location:</strong>
                <div style={{ fontSize: "13px" }}>
                  {primaryLocation.name || "Primary Store Location"}
                </div>
              </div>
            </div>
          </s-box>
        </s-stack>
      </s-section>

      {/* Catalog Input */}
      <s-section heading="Catalog Ingestion">
        <s-stack direction="block" gap="base">
          <div style={{ display: "flex", gap: "16px", marginBottom: "8px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
              <input
                type="radio"
                name="inputModeRadio"
                checked={inputMode === "text"}
                onChange={() => setInputMode("text")}
              />
              <span>Paste Spreadsheet Data (CSV / TSV / JSON)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
              <input
                type="radio"
                name="inputModeRadio"
                checked={inputMode === "file"}
                onChange={() => setInputMode("file")}
              />
              <span>Local File Path (CSV / XLSX / JSON)</span>
            </label>
          </div>

          {inputMode === "file" ? (
            <div>
              <label
                htmlFor="input-file-path"
                style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}
              >
                Absolute or relative file path on device:
              </label>
              <input
                id="input-file-path"
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="/home/abhishek/Desktop/catalog.csv or ./data/products.xlsx"
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: "6px",
                  border: "1px solid #ccc",
                  fontSize: "14px",
                  boxSizing: "border-box",
                }}
              />
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <label htmlFor="input-raw-content" style={{ fontWeight: 500 }}>Spreadsheet Content:</label>
                <button
                  type="button"
                  onClick={() => setRawText(SAMPLE_CSV)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#2c6ecb",
                    cursor: "pointer",
                    textDecoration: "underline",
                    fontSize: "12px",
                  }}
                >
                  Reset to Sample Sheet
                </button>
              </div>
              <textarea
                id="input-raw-content"
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={10}
                style={{
                  width: "100%",
                  fontFamily: "monospace",
                  fontSize: "13px",
                  padding: "10px",
                  borderRadius: "6px",
                  border: "1px solid #ccc",
                  boxSizing: "border-box",
                  whiteSpace: "pre",
                }}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: "10px" }}>
            <s-button
              onClick={handleValidate}
              variant="secondary"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Validate Catalog (Dry Run)
            </s-button>
            <s-button
              onClick={handleSync}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Sync to Shopify Store
            </s-button>
          </div>
        </s-stack>
      </s-section>

      {/* Validation Feedback */}
      {actionData && actionData.ok && actionData.mode === "validate" && (
        <s-section heading="Pre-Flight Validation Results">
          <s-stack direction="block" gap="base">
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "6px",
                background: actionData.validation.isValid ? "#e3f1df" : "#fbeae5",
                color: actionData.validation.isValid ? "#108043" : "#bf0711",
                fontWeight: 600,
              }}
            >
              {actionData.validation.isValid
                ? `✓ All ${actionData.validation.validRows.length} rows passed validation and are ready to sync!`
                : `⚠ Found ${actionData.validation.errors.length} validation errors across ${actionData.totalParsed} rows.`}
            </div>

            {actionData.validation.errors.length > 0 && (
              <div>
                <s-heading>Validation Errors</s-heading>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "8px", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ background: "#f4f6f8", borderBottom: "1px solid #dfe3e8" }}>
                        <th style={{ padding: "8px", textAlign: "left" }}>Row #</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Field</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Error Message</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actionData.validation.errors.map((err, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #f4f6f8" }}>
                          <td style={{ padding: "8px", fontWeight: 600 }}>{err.row}</td>
                          <td style={{ padding: "8px", color: "#bf0711" }}>{err.field}</td>
                          <td style={{ padding: "8px" }}>{err.message}</td>
                          <td style={{ padding: "8px", fontFamily: "monospace", color: "#637381" }}>
                            {String(err.value ?? "")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {actionData.validation.validRows.length > 0 && (
              <div>
                <s-heading>Valid Products Preview ({actionData.validation.validRows.length})</s-heading>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "8px", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ background: "#f4f6f8", borderBottom: "1px solid #dfe3e8" }}>
                        <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Title (PRODUCT NAME)</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Price</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Stock Code</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Qty</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Vendor</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Collection</th>
                        <th style={{ padding: "8px", textAlign: "left" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actionData.validation.validRows.map((item, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #f4f6f8" }}>
                          <td style={{ padding: "8px", fontFamily: "monospace" }}>{item.productNumber || "-"}</td>
                          <td style={{ padding: "8px", fontWeight: 500 }}>{item.title}</td>
                          <td style={{ padding: "8px" }}>₹{item.price}</td>
                          <td style={{ padding: "8px" }}>
                            <span
                              style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                background: item.stockStatus === "IS" ? "#e3f1df" : "#fbeae5",
                                color: item.stockStatus === "IS" ? "#108043" : "#bf0711",
                                fontWeight: 600,
                              }}
                            >
                              {item.stockStatus}
                            </span>
                          </td>
                          <td style={{ padding: "8px", fontWeight: 600 }}>{item.inventoryQuantity}</td>
                          <td style={{ padding: "8px", color: "#008060" }}>{item.vendor}</td>
                          <td style={{ padding: "8px" }}>{item.collectionName}</td>
                          <td style={{ padding: "8px" }}>{item.productStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </s-stack>
        </s-section>
      )}

      {/* Sync Execution Report */}
      {actionData && actionData.ok && actionData.mode === "sync" && (
        <s-section heading="Shopify Store Sync Report">
          <s-stack direction="block" gap="base">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "12px",
                marginBottom: "12px",
              }}
            >
              <div style={{ padding: "12px", background: "#f4f6f8", borderRadius: "6px", textAlign: "center" }}>
                <div style={{ fontSize: "20px", fontWeight: 700 }}>{actionData.report.totalProcessed}</div>
                <div style={{ fontSize: "12px", color: "#637381" }}>Total Ingested</div>
              </div>
              <div style={{ padding: "12px", background: "#e3f1df", borderRadius: "6px", textAlign: "center" }}>
                <div style={{ fontSize: "20px", fontWeight: 700, color: "#108043" }}>
                  {actionData.report.createdCount}
                </div>
                <div style={{ fontSize: "12px", color: "#108043" }}>Created</div>
              </div>
              <div style={{ padding: "12px", background: "#e0f2fe", borderRadius: "6px", textAlign: "center" }}>
                <div style={{ fontSize: "20px", fontWeight: 700, color: "#0369a1" }}>
                  {actionData.report.updatedCount}
                </div>
                <div style={{ fontSize: "12px", color: "#0369a1" }}>Updated</div>
              </div>
              <div style={{ padding: "12px", background: "#fbeae5", borderRadius: "6px", textAlign: "center" }}>
                <div style={{ fontSize: "20px", fontWeight: 700, color: "#bf0711" }}>
                  {actionData.report.failedCount}
                </div>
                <div style={{ fontSize: "12px", color: "#bf0711" }}>Failed</div>
              </div>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f4f6f8", borderBottom: "1px solid #dfe3e8" }}>
                    <th style={{ padding: "8px", textAlign: "left" }}>Row</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>Title</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>Action</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>Inventory Qty</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>Collection</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>Media</th>
                    <th style={{ padding: "8px", textAlign: "left" }}>Shopify Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {actionData.report.results.map((res, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f4f6f8" }}>
                      <td style={{ padding: "8px" }}>{res.row}</td>
                      <td style={{ padding: "8px", fontFamily: "monospace" }}>{res.productNumber || "-"}</td>
                      <td style={{ padding: "8px", fontWeight: 500 }}>{res.title}</td>
                      <td style={{ padding: "8px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "4px",
                            fontWeight: 600,
                            fontSize: "12px",
                            background:
                              res.action === "CREATED"
                                ? "#e3f1df"
                                : res.action === "UPDATED"
                                  ? "#e0f2fe"
                                  : "#fbeae5",
                            color:
                              res.action === "CREATED"
                                ? "#108043"
                                : res.action === "UPDATED"
                                  ? "#0369a1"
                                  : "#bf0711",
                          }}
                        >
                          {res.action}
                        </span>
                      </td>
                      <td style={{ padding: "8px", fontWeight: 600 }}>{res.inventoryQuantity}</td>
                      <td style={{ padding: "8px" }}>{res.collectionName || "-"}</td>
                      <td style={{ padding: "8px" }}>{res.mediaStatus || "-"}</td>
                      <td style={{ padding: "8px" }}>
                        {res.productId ? (
                          <s-button
                            onClick={() => {
                              shopify.intents.invoke?.("edit:shopify/Product", {
                                value: res.productId,
                              });
                            }}
                            variant="tertiary"
                          >
                            View Product
                          </s-button>
                        ) : (
                          <span style={{ color: "#bf0711", fontSize: "12px" }}>
                            {res.errors?.join(", ") || "Failed"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </s-stack>
        </s-section>
      )}

      {/* Template Specs & Info */}
      <s-section slot="aside" heading="Column Schema Guide">
        <s-paragraph>
          <strong>All Columns:</strong>
          <br />
          <code>PRODUCT NUMER</code>, <code>PRODUCT NAME</code>, <code>PRICE</code>,{" "}
          <code>SOLD OUT / IN STOCK</code>, <code>DESCRIPTION</code>, <code>Collection</code>,{" "}
          <code>Updated At</code>, <code>Update Status</code>, <code>Status</code>, <code>Link</code>
        </s-paragraph>
        <s-paragraph>
          <strong>Required Columns:</strong>
          <br />
          <code>PRODUCT NAME</code>, <code>PRICE</code>, <code>SOLD OUT / IN STOCK</code>,{" "}
          <code>DESCRIPTION</code>, <code>Collection</code>
        </s-paragraph>
        <s-paragraph>
          <strong>Collection Options:</strong>
          <br />
          &bull; Drape Saree
          <br />
          &bull; Indo western
          <br />
          &bull; Suits
        </s-paragraph>
        <s-paragraph>
          <strong>Stock Options:</strong>
          <br />
          &bull; <code>IS</code> &rarr; In Stock (Qty: 1)
          <br />
          &bull; <code>SO</code> &rarr; Sold Out (Qty: 0)
        </s-paragraph>
        <s-paragraph>
          <strong>Vendor:</strong>
          <br />
          Fixed to <code>Meesa</code>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
