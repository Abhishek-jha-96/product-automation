import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  processProductCatalog,
  validateBatch,
  parseLocalSheetFile,
  parseDelimitedText,
  parseJsonData,
} from "../services/product-automation/index.ts";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    let body: Record<string, unknown> = {};
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      body = await request.json();
    } else {
      const formData = await request.formData();
      body = {
        filePath: formData.get("filePath")?.toString(),
        rawText: formData.get("rawText")?.toString(),
        validateOnly: formData.get("validateOnly") === "true",
      };
    }

    const filePath = body.filePath as string | undefined;
    const rawText = body.rawText as string | undefined;
    const validateOnly = Boolean(body.validateOnly);

    if (!filePath && !rawText) {
      return new Response(
        JSON.stringify({ error: "Missing required input: provide 'filePath' or 'rawText'." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Ingest data
    let rawRows: ReturnType<typeof parseDelimitedText> = [];
    if (filePath) {
      rawRows = parseLocalSheetFile(filePath);
    } else if (rawText) {
      const trimmed = rawText.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        rawRows = parseJsonData(trimmed);
      } else {
        rawRows = parseDelimitedText(trimmed);
      }
    }

    // If dry run validation only
    if (validateOnly) {
      const validation = validateBatch(rawRows);
      return new Response(JSON.stringify({ ok: true, mode: "validate", validation }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Full processing
    const report = await processProductCatalog(admin, {
      rawRows,
    });

    return new Response(JSON.stringify({ ok: true, mode: "sync", report }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("api.process-products error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
