import { useEffect, useMemo, useState } from "react";
import { createResearchWorkbook, encodeBase64, type ResearchReportSheet } from "./researchReports";
import "./researchReports.css";

interface ResearchReportActionsProps {
  title: string;
  query: string;
  sheets: ResearchReportSheet[];
  userLogin?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "research";
}

export function ResearchReportActions({ title, query, sheets, userLogin }: ResearchReportActionsProps) {
  const [email, setEmail] = useState("");
  const [slackChannel, setSlackChannel] = useState("");
  const [nlq, setNlq] = useState(query);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const rowsAvailable = useMemo(() => sheets.some((sheet) => sheet.rows.length > 0), [sheets]);

  useEffect(() => setNlq(query), [query]);

  const workbook = () => createResearchWorkbook(sheets);
  const fileName = `${safeFilePart(title)}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  const runAction = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    setStatus("");
    setError("");
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Research report action failed.");
    } finally {
      setBusy("");
    }
  };

  const download = () => runAction("download", async () => {
    const bytes = await workbook();
    const blobBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(blobBuffer).set(bytes);
    const url = URL.createObjectURL(new Blob([blobBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    return "Workbook downloaded.";
  });

  const sendEmail = () => runAction("email", async () => {
    if (!email.trim()) throw new Error("Enter an email address.");
    const bytes = await workbook();
    await postJson("/api/trading/reports/email", {
      to: email.trim(),
      fileName,
      attachmentBase64: encodeBase64(bytes),
      query,
      title,
    });
    return `Workbook emailed to ${email.trim()}.`;
  });

  const sendSlack = () => runAction("slack", async () => {
    if (!nlq.trim()) throw new Error("Enter an NLQ to send to Slack.");
    const response = await postJson<{ handled?: boolean; error?: string }>("/api/trading/slack/test", {
      type: "event_callback",
      event: {
        type: "app_mention",
        text: nlq.trim(),
        channel: slackChannel.trim(),
        user: userLogin || "research_report",
        ts: String(Date.now() / 1000),
        ...(email.trim() ? { email_to: email.trim() } : {}),
      },
    });
    if (!response.handled) throw new Error("Slack did not handle the research query.");
    return "Research query submitted to the Slack agent.";
  });

  const askVoice = () => runAction("voice", async () => {
    if (!nlq.trim()) throw new Error("Enter an NLQ to send to the voice agent.");
    const response = await postJson<{ spokenText?: string }>("/api/trading/voice/turn", {
      transcript: nlq.trim(),
      userLogin,
    });
    return response.spokenText || "Research query submitted to the voice agent.";
  });

  const publishWebhook = () => runAction("webhook", async () => {
    await postJson("/api/trading/reports/webhook", {
      eventType: "research.recommendations",
      title,
      query,
      sheets,
    });
    return "Recommendation report sent to the configured signed webhook.";
  });

  return (
    <section className="research-report-actions" aria-label={`${title} export and delivery`}>
      <h3>Export and share this research</h3>
      <div className="research-report-controls">
        <button type="button" disabled={Boolean(busy) || !rowsAvailable} onClick={() => void download()}>
          {busy === "download" ? "Preparing…" : "Download .xlsx"}
        </button>
        <label>
          Email recipient (workbook or NLQ response)
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        </label>
        <button type="button" disabled={Boolean(busy) || !rowsAvailable || !email.trim()} onClick={() => void sendEmail()}>
          {busy === "email" ? "Sending…" : "Send email"}
        </button>
      </div>
      <label className="research-report-query">
        Submit the same research question to Slack or voice
        <textarea value={nlq} onChange={(event) => setNlq(event.target.value)} rows={2} />
      </label>
      <div className="research-report-controls">
        <label>
          Slack channel ID
          <input value={slackChannel} onChange={(event) => setSlackChannel(event.target.value)} placeholder="C0123456789" />
        </label>
        <button type="button" disabled={Boolean(busy) || !nlq.trim() || !slackChannel.trim()} onClick={() => void sendSlack()}>
          {busy === "slack" ? "Sending…" : "Submit to Slack"}
        </button>
        <button type="button" disabled={Boolean(busy) || !nlq.trim()} onClick={() => void askVoice()}>
          {busy === "voice" ? "Sending…" : "Ask voice agent"}
        </button>
        <button type="button" disabled={Boolean(busy) || !rowsAvailable} onClick={() => void publishWebhook()}>
          {busy === "webhook" ? "Sending…" : "Publish recommendations"}
        </button>
      </div>
      {status && <p className="research-report-status" role="status">{status}</p>}
      {error && <p className="research-report-error" role="alert">{error}</p>}
      <p className="research-report-disclaimer">Research only. These channels do not place trades; report values reflect the data currently loaded in this view.</p>
    </section>
  );
}
