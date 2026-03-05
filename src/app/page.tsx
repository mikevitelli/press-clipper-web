"use client";

import { useState, useCallback, useRef } from "react";
import { parseSpreadsheet, type SpreadsheetRow, type ParseResult } from "@/lib/parse-xlsx";
import { generateCombinedDocx, generateSingleDocx, type ClipData } from "@/lib/generate-docx";
import { saveAs } from "file-saver";

type RowStatus = "pending" | "scraping" | "success" | "paywall" | "error";

interface RowState {
  row: SpreadsheetRow;
  status: RowStatus;
  message?: string;
  data?: ClipData;
  selected: boolean;
}

type OutputMode = "combined" | "individual";

export default function Home() {
  const [step, setStep] = useState<"upload" | "select" | "processing" | "done">("upload");
  const [parseResult, setParsResult] = useState<ParseResult | null>(null);
  const [rowStates, setRowStates] = useState<RowState[]>([]);
  const [outputMode, setOutputMode] = useState<OutputMode>("combined");
  const [isGenerating, setIsGenerating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // ---- UPLOAD STEP ----
  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.xlsx?$/i)) {
      alert("Please upload an .xlsx file");
      return;
    }
    const buffer = await file.arrayBuffer();
    const result = parseSpreadsheet(buffer, file.name);
    if (result.rows.length === 0) {
      alert("No rows with URLs found in the spreadsheet");
      return;
    }
    setParsResult(result);
    setRowStates(
      result.rows.map((row) => ({
        row,
        status: "pending",
        selected: true,
      }))
    );
    setStep("select");
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  // ---- SELECT STEP ----
  const toggleRow = (index: number) => {
    setRowStates((prev) =>
      prev.map((rs, i) =>
        i === index ? { ...rs, selected: !rs.selected } : rs
      )
    );
  };

  const toggleAll = () => {
    const allSelected = rowStates.every((rs) => rs.selected);
    setRowStates((prev) =>
      prev.map((rs) => ({ ...rs, selected: !allSelected }))
    );
  };

  const selectedCount = rowStates.filter((rs) => rs.selected).length;

  // ---- PROCESSING STEP ----
  const startProcessing = async () => {
    setStep("processing");

    const selectedIndices = rowStates
      .map((rs, i) => (rs.selected ? i : -1))
      .filter((i) => i !== -1);

    for (const idx of selectedIndices) {
      setRowStates((prev) =>
        prev.map((rs, i) =>
          i === idx ? { ...rs, status: "scraping" } : rs
        )
      );

      try {
        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: rowStates[idx].row.url }),
        });

        const data = await res.json();

        if (data.error) {
          setRowStates((prev) =>
            prev.map((rs, i) =>
              i === idx
                ? {
                    ...rs,
                    status: data.paywall ? "paywall" : "error",
                    message: data.error,
                  }
                : rs
            )
          );
        } else {
          const clipData: ClipData = {
            ...data,
            outlet: rowStates[idx].row.outlet,
          };
          setRowStates((prev) =>
            prev.map((rs, i) =>
              i === idx
                ? { ...rs, status: "success", data: clipData }
                : rs
            )
          );
        }
      } catch (e) {
        setRowStates((prev) =>
          prev.map((rs, i) =>
            i === idx
              ? {
                  ...rs,
                  status: "error",
                  message: e instanceof Error ? e.message : "Unknown error",
                }
              : rs
          )
        );
      }
    }

    setStep("done");
  };

  // ---- DOWNLOAD ----
  const handleDownload = async () => {
    setIsGenerating(true);
    const successClips = rowStates
      .filter((rs) => rs.status === "success" && rs.data)
      .map((rs) => rs.data!);

    if (successClips.length === 0) {
      alert("No clips were successfully scraped");
      setIsGenerating(false);
      return;
    }

    try {
      if (outputMode === "combined") {
        const blob = await generateCombinedDocx(successClips);
        const baseName = parseResult?.fileName
          .replace(/\[EXT\]\s*/g, "")
          .replace(/\.xlsx?$/i, "")
          .trim();
        saveAs(blob, `${baseName} - Press Clips.docx`);
      } else {
        for (const clip of successClips) {
          const blob = await generateSingleDocx(clip);
          const safeName = (clip.outlet || clip.title)
            .replace(/[^a-zA-Z0-9\s-]/g, "")
            .trim();
          saveAs(blob, `${safeName} - ${clip.date || "Clip"}.docx`);
        }
      }
    } catch (e) {
      alert(`Failed to generate document: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
    setIsGenerating(false);
  };

  // ---- STATUS HELPERS ----
  const statusIcon = (status: RowStatus) => {
    switch (status) {
      case "pending": return "○";
      case "scraping": return "◌";
      case "success": return "✓";
      case "paywall": return "🔒";
      case "error": return "✕";
    }
  };

  const statusColor = (status: RowStatus) => {
    switch (status) {
      case "pending": return "text-gray-400";
      case "scraping": return "text-blue-500 animate-pulse";
      case "success": return "text-green-600";
      case "paywall": return "text-amber-500";
      case "error": return "text-red-500";
    }
  };

  const successCount = rowStates.filter((rs) => rs.status === "success").length;
  const paywallCount = rowStates.filter((rs) => rs.status === "paywall").length;
  const errorCount = rowStates.filter((rs) => rs.status === "error").length;

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">
          Press Clipper
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a media report spreadsheet, select articles, generate formatted press clips.
        </p>
      </div>

      {/* STEP 1: UPLOAD */}
      {step === "upload" && (
        <div
          className={`border-2 border-dashed rounded-xl p-16 text-center transition-colors cursor-pointer ${
            dragOver
              ? "border-blue-400 bg-blue-50"
              : "border-gray-300 hover:border-gray-400"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="text-4xl mb-3 text-gray-300">📋</div>
          <p className="text-gray-600 font-medium">
            Drop your .xlsx spreadsheet here
          </p>
          <p className="text-sm text-gray-400 mt-1">or click to browse</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
      )}

      {/* STEP 2: SELECT ROWS */}
      {step === "select" && parseResult && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-gray-500">
                Found <span className="font-semibold text-gray-800">{rowStates.length}</span> articles
              </p>
            </div>
            <div className="flex items-center gap-4">
              <select
                value={outputMode}
                onChange={(e) => setOutputMode(e.target.value as OutputMode)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white"
              >
                <option value="combined">Combined document</option>
                <option value="individual">Individual documents</option>
              </select>
              <button
                onClick={toggleAll}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                {rowStates.every((rs) => rs.selected) ? "Deselect all" : "Select all"}
              </button>
            </div>
          </div>

          <div className="border border-gray-200 rounded-xl overflow-hidden bg-white divide-y divide-gray-100">
            {rowStates.map((rs, i) => (
              <label
                key={i}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={rs.selected}
                  onChange={() => toggleRow(i)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 accent-blue-600"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">
                    {rs.row.outlet || "Unknown outlet"}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {rs.row.date} · {rs.row.url}
                  </p>
                </div>
              </label>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <button
              onClick={() => {
                setStep("upload");
                setParsResult(null);
                setRowStates([]);
              }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Upload different file
            </button>
            <button
              onClick={startProcessing}
              disabled={selectedCount === 0}
              className="px-5 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Generate {selectedCount} clip{selectedCount !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: PROCESSING / STEP 4: DONE */}
      {(step === "processing" || step === "done") && (
        <div>
          {/* Progress summary */}
          {step === "done" && (
            <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
              <div className="flex items-center gap-6 text-sm">
                <span className="text-green-600 font-medium">
                  {successCount} clipped
                </span>
                {paywallCount > 0 && (
                  <span className="text-amber-500">
                    {paywallCount} paywalled
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="text-red-500">{errorCount} failed</span>
                )}
              </div>
              {successCount > 0 && (
                <button
                  onClick={handleDownload}
                  disabled={isGenerating}
                  className="mt-4 w-full px-5 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-60 transition-colors"
                >
                  {isGenerating
                    ? "Generating..."
                    : outputMode === "combined"
                    ? `Download combined document (${successCount} clips)`
                    : `Download ${successCount} individual documents`}
                </button>
              )}
            </div>
          )}

          {/* Row status list */}
          <div className="border border-gray-200 rounded-xl overflow-hidden bg-white divide-y divide-gray-100">
            {rowStates
              .filter((rs) => rs.selected)
              .map((rs, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <span className={`text-lg ${statusColor(rs.status)}`}>
                    {statusIcon(rs.status)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {rs.row.outlet || "Unknown outlet"}
                    </p>
                    {rs.message && (
                      <p className="text-xs text-gray-400 truncate">
                        {rs.message}
                      </p>
                    )}
                    {rs.status === "success" && rs.data && (
                      <p className="text-xs text-green-600 truncate">
                        {rs.data.title}
                      </p>
                    )}
                  </div>
                </div>
              ))}
          </div>

          {/* Actions */}
          {step === "done" && (
            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => {
                  setStep("upload");
                  setParsResult(null);
                  setRowStates([]);
                }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ← Start over
              </button>
              <div className="flex items-center gap-3">
                <select
                  value={outputMode}
                  onChange={(e) => setOutputMode(e.target.value as OutputMode)}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white"
                >
                  <option value="combined">Combined</option>
                  <option value="individual">Individual</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
