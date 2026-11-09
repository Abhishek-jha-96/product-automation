import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RawSheetRow } from "./types.ts";

/**
 * Standard column names expected from spreadsheets
 */
export const KNOWN_COLUMNS = [
  "PRODUCT NUMER",
  "PRODUCT NAME",
  "PRICE",
  "SOLD OUT / IN STOCK",
  "DESCRIPTION",
  "Collection",
  "Updated At",
  "Update Status",
  "Status",
  "Link",
] as const;

/**
 * Map header variations to standardized canonical column names
 */
function normalizeHeaderName(rawHeader: string): string {
  const trimmed = rawHeader.trim();
  const lower = trimmed.toLowerCase().replace(/[\s_-]+/g, " ");

  if (lower === "product numer" || lower === "product number" || lower === "sku") {
    return "PRODUCT NUMER";
  }
  if (lower === "product name" || lower === "title" || lower === "name") {
    return "PRODUCT NAME";
  }
  if (lower === "price" || lower === "amount" || lower === "cost") {
    return "PRICE";
  }
  if (
    lower === "sold out / in stock" ||
    lower === "sold out/in stock" ||
    lower === "stock status" ||
    lower === "inventory status" ||
    lower === "inventory" ||
    lower === "stock"
  ) {
    return "SOLD OUT / IN STOCK";
  }
  if (lower === "description" || lower === "body html" || lower === "desc") {
    return "DESCRIPTION";
  }
  if (lower === "collection" || lower === "collections" || lower === "category") {
    return "Collection";
  }
  if (lower === "updated at" || lower === "update date" || lower === "updated_at") {
    return "Updated At";
  }
  if (lower === "update status" || lower === "sync status" || lower === "update_status") {
    return "Update Status";
  }
  if (lower === "status" || lower === "product status") {
    return "Status";
  }
  if (lower === "link" || lower === "image url" || lower === "image link" || lower === "url" || lower === "media") {
    return "Link";
  }

  return trimmed;
}

/**
 * Robust RFC 4180 CSV / TSV parser.
 * Handles embedded newlines, quotes, commas, and tabs.
 */
export function parseDelimitedText(content: string, delimiter?: string): RawSheetRow[] {
  if (!content || !content.trim()) {
    return [];
  }

  // Auto-detect delimiter (comma vs tab) if not supplied
  const firstLine = content.split(/\r?\n/)[0] || "";
  const sep = delimiter || (firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",");

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }

    if (!inQuotes && char === sep) {
      currentRow.push(currentField);
      currentField = "";
      i++;
      continue;
    }

    if (!inQuotes && (char === "\r" || char === "\n")) {
      if (char === "\r" && nextChar === "\n") {
        i++;
      }
      currentRow.push(currentField);
      currentField = "";
      // Avoid pushing empty rows at the end of files
      if (currentRow.some((cell) => cell.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((cell) => cell.trim().length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length < 1) {
    return [];
  }

  const rawHeaders = rows[0];
  const normalizedHeaders = rawHeaders.map(normalizeHeaderName);

  const parsedData: RawSheetRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const rowValues = rows[r];
    const rowObj: RawSheetRow = {};

    normalizedHeaders.forEach((header, index) => {
      rowObj[header] = rowValues[index] !== undefined ? rowValues[index].trim() : "";
    });

    parsedData.push(rowObj);
  }

  return parsedData;
}

/**
 * Parse JSON array or wrapper object
 */
export function parseJsonData(content: string): RawSheetRow[] {
  const parsed = JSON.parse(content);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows || parsed.data || parsed.products || [];

  return rows.map((rawRow: Record<string, unknown>) => {
    const normalized: RawSheetRow = {};
    for (const [key, value] of Object.entries(rawRow)) {
      const normKey = normalizeHeaderName(key);
      normalized[normKey] = value !== undefined && value !== null ? String(value).trim() : "";
    }
    return normalized;
  });
}

/**
 * Parse Excel .xlsx file using Python's standard library (zipfile + xml.etree)
 * without needing external node packages.
 */
function parseXlsxFile(filePath: string): RawSheetRow[] {
  const pythonScript = `
import zipfile, xml.etree.ElementTree as ET, json, sys

path = sys.argv[1]
with zipfile.ZipFile(path, 'r') as z:
    # 1. Read shared strings
    shared_strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        sst_tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in sst_tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
            t = si.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t')
            shared_strings.append(t.text if t is not None and t.text else '')

    # 2. Read first sheet
    sheet_name = 'xl/worksheets/sheet1.xml'
    sheet_tree = ET.fromstring(z.read(sheet_name))
    sheet_data = sheet_tree.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheetData')

    rows = []
    for row in sheet_data.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'):
        row_vals = []
        for c in row.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
            cell_type = c.get('t')
            v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
            val = v.text if v is not None and v.text else ''
            if cell_type == 's' and val:
                val = shared_strings[int(val)] if int(val) < len(shared_strings) else val
            row_vals.append(val)
        if any(x.strip() for x in row_vals if x):
            rows.append(row_vals)

    if not rows:
        print(json.dumps([]))
        sys.exit(0)

    headers = rows[0]
    result = []
    for r in rows[1:]:
        obj = {}
        for idx, h in enumerate(headers):
            val = r[idx] if idx < len(r) else ''
            obj[h] = val
        result.append(obj)

    print(json.dumps(result))
`;

  const output = execFileSync("python3", ["-c", pythonScript, filePath], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  return parseJsonData(output);
}

/**
 * Universal file ingestion function: reads local spreadsheet files by path
 */
export function parseLocalSheetFile(filePath: string): RawSheetRow[] {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Local spreadsheet file not found at: ${resolvedPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();

  if (ext === ".xlsx" || ext === ".xlsm") {
    return parseXlsxFile(resolvedPath);
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");

  if (ext === ".json") {
    return parseJsonData(content);
  }

  if (ext === ".tsv") {
    return parseDelimitedText(content, "\t");
  }

  // Default to CSV parser
  return parseDelimitedText(content);
}
