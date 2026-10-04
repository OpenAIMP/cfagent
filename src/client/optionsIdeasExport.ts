export interface RawOptionsIdeasExport {
  symbol: string;
  question: string;
  expirations: unknown[];
  optionChains: unknown[];
  systemPrompt: string;
  userPrompt: string;
  selection?: {
    contractsAvailable: number;
    contractsIncluded: number;
    truncated: boolean;
  };
}

export interface RetrievedOptionsDataExport {
  symbol: string;
  question: string;
  expirations: unknown[];
  optionChains: unknown[];
}

function rawChainData(chain: unknown): unknown {
  if (chain && typeof chain === "object" && "raw" in chain && chain.raw && typeof chain.raw === "object") {
    return chain.raw;
  }
  return chain;
}

function textChunks(text: string): string[][] {
  const chunkSize = 240;
  const rows: string[][] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    if (rows.length >= 65_534) {
      throw new Error("The export exceeds the row limit of the legacy .xls format.");
    }
    rows.push([String(rows.length + 1), text.slice(offset, offset + chunkSize)]);
  }
  return rows.length ? rows : [["1", ""]];
}

export async function createRawOptionsIdeasXls(input: RawOptionsIdeasExport): Promise<Uint8Array> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  const requestData = {
    request: { symbol: input.symbol, naturalLanguageQuestion: input.question },
    ...(input.selection ? { dataCoverage: input.selection } : {}),
    etrade: {
      optionExpirations: input.expirations,
      optionChains: input.optionChains.map(rawChainData),
    },
  };

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Field", "Value"],
      ["Underlying symbol", input.symbol],
      ["Natural-language question", input.question],
      ["Option expirations", input.expirations.length],
      ["Option-chain responses", input.optionChains.length],
    ]),
    "Request",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Prompt text"], ...textChunks(input.systemPrompt)]),
    "LLM System Prompt",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Prompt text"], ...textChunks(input.userPrompt)]),
    "LLM User Prompt",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Complete JSON input"], ...textChunks(JSON.stringify(requestData))]),
    "Complete Input JSON",
  );

  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function downloadRawOptionsIdeasXls(input: RawOptionsIdeasExport): Promise<void> {
  const bytes = await createRawOptionsIdeasXls(input);
  downloadXls(bytes, `${input.symbol.toLowerCase()}_llm_options_input`);
}

export async function createRetrievedOptionsDataXls(input: RetrievedOptionsDataExport): Promise<Uint8Array> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  const rawData = {
    request: { symbol: input.symbol, naturalLanguageQuestion: input.question },
    etrade: {
      optionExpirations: input.expirations,
      optionChains: input.optionChains.map(rawChainData),
    },
  };
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Field", "Value"],
      ["Underlying symbol", input.symbol],
      ["Natural-language question", input.question],
      ["Option expirations retrieved", input.expirations.length],
      ["Option-chain responses retrieved", input.optionChains.length],
    ]),
    "Request",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Complete retrieved E*TRADE JSON"], ...textChunks(JSON.stringify(rawData))]),
    "Retrieved Raw JSON",
  );
  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function downloadRetrievedOptionsDataXls(input: RetrievedOptionsDataExport): Promise<void> {
  const bytes = await createRetrievedOptionsDataXls(input);
  downloadXls(bytes, `${input.symbol.toLowerCase()}_etrade_options_raw`);
}

function downloadXls(bytes: Uint8Array, filenamePrefix: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}
