import type { ETradeOptionChainContract } from "../../types";

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
  groupInputs?: Array<{
    id?: string;
    label: string;
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
  }>;
  finalRanking?: {
    systemPrompt: string;
    userPrompt: string;
  };
}

export interface RetrievedOptionsDataExport {
  symbol: string;
  question: string;
  expirations: unknown[];
  optionChains: unknown[];
}

export interface OptionsIdeasReportExport {
  symbol: string;
  question: string;
  dataCoverage: {
    expirationCount: number;
    chainCount: number;
    contractCount: number;
    sentContractCount?: number;
    estimatedInputTokens?: number;
    inputTruncated?: boolean;
  };
  groups: Array<{
    id: string;
    label: string;
    status: "complete" | "error";
    model?: string;
    answer?: string;
    error?: string;
    contractSymbols?: string[];
    contractWarnings?: string[];
    contractDetails?: Array<{
      symbol: string;
      expiration: string;
      contract: ETradeOptionChainContract;
    }>;
    expirationCount: number;
    contractCount: number;
    sentContractCount: number;
    inputTruncated: boolean;
  }>;
  finalAnalysis: {
    status: "complete" | "error";
    model?: string;
    answer?: string;
    error?: string;
    rankings?: Array<{ rank: number; groupId: string; strategy: string; rationale: string }>;
  };
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
  const groupInputs = input.groupInputs;
  const requestData = {
    request: { symbol: input.symbol, naturalLanguageQuestion: input.question },
    ...(groupInputs?.length
      ? {
        groupInputs: groupInputs.map((group) => ({
          groupId: group.id,
          label: group.label,
          question: group.question,
          selection: group.selection,
          systemPrompt: group.systemPrompt,
          userPrompt: group.userPrompt,
          etrade: {
            optionExpirations: group.expirations,
            optionChains: group.optionChains.map(rawChainData),
          },
        })),
        finalRanking: input.finalRanking,
      }
      : {
        ...(input.selection ? { dataCoverage: input.selection } : {}),
        etrade: {
          optionExpirations: input.expirations,
          optionChains: input.optionChains.map(rawChainData),
        },
      }),
  };

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Field", "Value"],
      ["Underlying symbol", input.symbol],
      ["Natural-language question", input.question],
      ["Option expirations", groupInputs?.length ? groupInputs.reduce((count, group) => count + group.expirations.length, 0) : input.expirations.length],
      ["Option-chain responses", groupInputs?.length ? groupInputs.reduce((count, group) => count + group.optionChains.length, 0) : input.optionChains.length],
      ...(groupInputs?.length ? [["Expiration groups analyzed", groupInputs.length]] : []),
    ]),
    "Request",
  );
  const systemPromptText = groupInputs?.length
    ? groupInputs.map((group) => `GROUP: ${group.label}\n${group.systemPrompt}`).concat(
      input.finalRanking ? [`FINAL CROSS-GROUP RANKING\n${input.finalRanking.systemPrompt}`] : [],
    ).join("\n\n")
    : input.systemPrompt;
  const userPromptText = groupInputs?.length
    ? groupInputs.map((group) => `GROUP: ${group.label}\n${group.userPrompt}`).concat(
      input.finalRanking ? [`FINAL CROSS-GROUP RANKING\n${input.finalRanking.userPrompt}`] : [],
    ).join("\n\n")
    : input.userPrompt;
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Prompt text"], ...textChunks(systemPromptText)]),
    "LLM System Prompt",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Prompt text"], ...textChunks(userPromptText)]),
    "LLM User Prompt",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Complete JSON input"], ...textChunks(JSON.stringify(requestData))]),
    "Complete Input JSON",
  );

  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function createOptionsIdeasReportXls(report: OptionsIdeasReportExport): Promise<Uint8Array> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ["Field", "Value"],
    ["Underlying symbol", report.symbol],
    ["Natural-language question", report.question],
    ["Expiration groups", report.groups.length],
    ["Expirations retrieved", report.dataCoverage.expirationCount],
    ["Option chains retrieved", report.dataCoverage.chainCount],
    ["Contracts retrieved", report.dataCoverage.contractCount],
    ["Contracts sent across group requests", report.dataCoverage.sentContractCount ?? 0],
    ["Any group input truncated", report.dataCoverage.inputTruncated ? "Yes" : "No"],
    ["Final analysis status", report.finalAnalysis.status],
    ["Final analysis model", report.finalAnalysis.model || ""],
    ["Final analysis", report.finalAnalysis.answer || report.finalAnalysis.error || ""],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Summary");

  const groupRows: string[][] = [[
    "Group",
    "Status",
    "Expirations",
    "Contracts",
    "Contracts Sent",
    "Input Truncated",
    "Model",
    "Referenced Contracts",
    "Analysis / Error",
  ]];
  for (const group of report.groups) {
    groupRows.push([
      group.label,
      group.status,
      String(group.expirationCount),
      String(group.contractCount),
      String(group.sentContractCount),
      group.inputTruncated ? "Yes" : "No",
      group.model || "",
      (group.contractSymbols || []).join(", "),
      [group.answer || group.error || "", ...(group.contractWarnings || [])].join("\n"),
    ]);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(groupRows), "Group Evaluations");

  const verifiedContracts = report.groups.flatMap((group) =>
    (group.contractDetails || []).map((detail) => ({
      group: group.label,
      ...detail,
    })),
  );
  if (verifiedContracts.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      [
        "Expiration Group",
        "Expiration",
        "E*TRADE Contract Symbol",
        "Option Type",
        "Strike",
        "Bid",
        "Ask",
        "Last",
        "Volume",
        "Open Interest",
        "Delta",
        "Gamma",
        "Theta",
        "Vega",
        "Rho",
        "Implied Volatility",
      ],
      ...verifiedContracts.map(({ group, expiration, contract }) => [
        group,
        expiration,
        contract.symbol,
        contract.optionType,
        contract.strikePrice,
        contract.bid,
        contract.ask,
        contract.lastPrice,
        contract.volume,
        contract.openInterest,
        contract.delta,
        contract.gamma,
        contract.theta,
        contract.vega,
        contract.rho,
        contract.impliedVolatility,
      ]),
    ]), "Verified Contracts");
  }

  const rankings = report.finalAnalysis.rankings || [];
  if (rankings.length) {
    const groupLabels = new Map(report.groups.map((group) => [group.id, group.label]));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Rank", "Expiration Group", "Winning Strategy", "Rationale"],
      ...rankings.map((item) => [
        String(item.rank),
        groupLabels.get(item.groupId) || item.groupId,
        item.strategy,
        item.rationale,
      ]),
    ]), "Cross-Group Ranking");
  }
  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function downloadOptionsIdeasReportXls(report: OptionsIdeasReportExport): Promise<void> {
  const bytes = await createOptionsIdeasReportXls(report);
  downloadXls(bytes, `${report.symbol.toLowerCase()}_llm_options_analysis`);
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
