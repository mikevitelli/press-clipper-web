import * as XLSX from "xlsx";

export interface SpreadsheetRow {
  rowIndex: number;
  outlet: string;
  date: string;
  url: string;
  author: string;
  [key: string]: string | number;
}

export interface ParseResult {
  rows: SpreadsheetRow[];
  headers: string[];
  fileName: string;
}

function findLinkColumn(headers: string[]): number {
  // Try exact matches first
  const exactTargets = [
    "article (click to read)",
    "article",
    "link",
    "url",
    "article link",
  ];
  for (const target of exactTargets) {
    const idx = headers.findIndex(
      (h) => h.toLowerCase().trim() === target
    );
    if (idx !== -1) return idx;
  }
  // Try fuzzy match
  const fuzzyTargets = ["article", "link", "url", "click"];
  for (const target of fuzzyTargets) {
    const idx = headers.findIndex((h) =>
      h.toLowerCase().includes(target)
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

function findColumnByKeywords(
  headers: string[],
  keywords: string[]
): number {
  for (const kw of keywords) {
    const idx = headers.findIndex((h) =>
      h.toLowerCase().includes(kw.toLowerCase())
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parseSpreadsheet(
  buffer: ArrayBuffer,
  fileName: string
): ParseResult {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Get raw data including hyperlinks
  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
  }) as unknown as unknown[][];

  if (jsonData.length < 2) {
    return { rows: [], headers: [], fileName };
  }

  const headers = (jsonData[0] as string[]).map((h) =>
    String(h || "").trim()
  );
  const linkColIdx = findLinkColumn(headers);
  const outletColIdx = findColumnByKeywords(headers, [
    "media outlet",
    "outlet",
    "publication",
    "source",
  ]);
  const dateColIdx = findColumnByKeywords(headers, ["date"]);
  const authorColIdx = findColumnByKeywords(headers, ["author", "writer"]);

  const rows: SpreadsheetRow[] = [];

  for (let i = 1; i < jsonData.length; i++) {
    const rowData = jsonData[i] as string[];
    if (!rowData || rowData.length === 0) continue;

    // Try to extract URL — check for hyperlinks in the cell
    let url = "";
    if (linkColIdx !== -1) {
      const cellRef = XLSX.utils.encode_cell({ r: i, c: linkColIdx });
      const cell = sheet[cellRef];
      if (cell?.l?.Target) {
        url = cell.l.Target;
      } else {
        const val = String(rowData[linkColIdx] || "");
        if (val.startsWith("http")) url = val;
      }
    }

    // Skip rows without URLs
    if (!url) continue;

    const outlet =
      outletColIdx !== -1 ? String(rowData[outletColIdx] || "") : "";
    const date = dateColIdx !== -1 ? String(rowData[dateColIdx] || "") : "";
    const author =
      authorColIdx !== -1 ? String(rowData[authorColIdx] || "") : "";

    rows.push({
      rowIndex: i + 1,
      outlet,
      date,
      url,
      author,
    });
  }

  return { rows, headers, fileName };
}
