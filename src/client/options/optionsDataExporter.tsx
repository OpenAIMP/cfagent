import React, { useState, useRef, useEffect } from "react";
import { apiFetch as fetch } from "../apiFetch";
import {
  downloadRawOptionsIdeasXls,
  downloadRetrievedOptionsDataXls,
  type RawOptionsIdeasExport,
  type RetrievedOptionsDataExport,
} from "../optionsIdeasExport";
import "./strategyDiscovery.css";

export async function fetchOptionsDataForExport(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<{ retrievedData: RetrievedOptionsDataExport; llmInput: RawOptionsIdeasExport }> {
  const query = `Retrieve complete raw option chains and normalized LLM contract datasets for ${symbol}.`;
  const response = await fetch("/api/trading/options/llm-ideas", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-environment": activeEnv,
      ...(userLogin ? { "x-user-login": userLogin } : {}),
    },
    body: JSON.stringify({
      symbol: symbol.trim().toUpperCase(),
      question: query,
    }),
  });

  const data = (await response.json()) as any;
  if (!response.ok && (!data || !data.retrievedData)) {
    throw new Error(data?.error || `Failed to retrieve options data for ${symbol}.`);
  }

  if (!data.retrievedData) {
    throw new Error("No option chain data was returned by the broker.");
  }

  return {
    retrievedData: data.retrievedData,
    llmInput: data.llmInput,
  };
}

export async function downloadRawOptionsData(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<void> {
  const { retrievedData } = await fetchOptionsDataForExport(symbol, activeEnv, userLogin);
  await downloadRetrievedOptionsDataXls(retrievedData);
}

export async function downloadNormalizedOptionsData(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<void> {
  const { llmInput } = await fetchOptionsDataForExport(symbol, activeEnv, userLogin);
  if (!llmInput) {
    throw new Error("Normalized LLM input data was not generated.");
  }
  await downloadRawOptionsIdeasXls(llmInput);
}

export async function downloadBothOptionsData(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<void> {
  const { retrievedData, llmInput } = await fetchOptionsDataForExport(symbol, activeEnv, userLogin);
  await downloadRetrievedOptionsDataXls(retrievedData);
  if (llmInput) {
    await downloadRawOptionsIdeasXls(llmInput);
  }
}

export interface OptionsDataDownloadDropdownProps {
  symbol: string;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  label?: string;
  className?: string;
}

export function OptionsDataDownloadDropdown({
  symbol,
  activeEnv = "TEST",
  userLogin,
  label = "📥 Download Options Data",
  className = "",
}: OptionsDataDownloadDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [downloading, setDownloading] = useState<"raw" | "normalized" | "both" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleDownload = async (type: "raw" | "normalized" | "both") => {
    const sym = symbol.trim().toUpperCase() || "TSLA";
    setDownloading(type);
    setErrorMessage("");
    setStatusMessage(`Retrieving complete chains for ${sym}…`);
    try {
      if (type === "raw") {
        await downloadRawOptionsData(sym, activeEnv, userLogin);
        setStatusMessage(`Downloaded raw E*TRADE options data for ${sym} (.xls)`);
      } else if (type === "normalized") {
        await downloadNormalizedOptionsData(sym, activeEnv, userLogin);
        setStatusMessage(`Downloaded normalized LLM input data for ${sym} (.xls)`);
      } else {
        await downloadBothOptionsData(sym, activeEnv, userLogin);
        setStatusMessage(`Downloaded raw & normalized options packages for ${sym} (.xls)`);
      }
      setTimeout(() => {
        setStatusMessage("");
        setIsOpen(false);
      }, 2500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to download options data.");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className={`options-download-dropdown-wrap ${className}`} ref={dropdownRef}>
      <button
        type="button"
        className="options-download-main-btn"
        onClick={() => setIsOpen(!isOpen)}
        disabled={downloading !== null}
        title={`Download raw and normalized options datasets for ${symbol.toUpperCase()}`}
      >
        {downloading ? "⏳ Downloading…" : `${label} ▾`}
      </button>

      {isOpen && (
        <div className="options-download-menu">
          <div className="options-download-menu-header">
            <strong>Download Options Data for {symbol.toUpperCase()}</strong>
            <span>Excel 97–2003 (.xls) Workbooks</span>
          </div>

          <button
            type="button"
            className="options-download-menu-item"
            disabled={downloading !== null}
            onClick={() => void handleDownload("raw")}
          >
            <div className="menu-item-icon">📦</div>
            <div className="menu-item-text">
              <strong>Raw E*TRADE Options Data</strong>
              <small>Complete unadulterated option chain JSON &amp; expirations</small>
            </div>
          </button>

          <button
            type="button"
            className="options-download-menu-item"
            disabled={downloading !== null}
            onClick={() => void handleDownload("normalized")}
          >
            <div className="menu-item-icon">📊</div>
            <div className="menu-item-text">
              <strong>Normalized LLM Input Data</strong>
              <small>Grouped contracts, Greeks, and exact prompts fed to LLM</small>
            </div>
          </button>

          <button
            type="button"
            className="options-download-menu-item highlight"
            disabled={downloading !== null}
            onClick={() => void handleDownload("both")}
          >
            <div className="menu-item-icon">📁</div>
            <div className="menu-item-text">
              <strong>Download Both Packages</strong>
              <small>Both raw E*TRADE chains and normalized LLM inputs</small>
            </div>
          </button>

          {statusMessage && <div className="options-download-status success">{statusMessage}</div>}
          {errorMessage && <div className="options-download-status error">{errorMessage}</div>}
        </div>
      )}
    </div>
  );
}
