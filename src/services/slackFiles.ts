/**
 * Post files (PDFs, screenshots) to Slack through the bot's Web API -
 * the only Slack path that can carry file attachments. (The incoming
 * webhook, SLACK_WEBHOOK_URL, accepts text only; Slack offers no way
 * to attach a file through it.) Uses the three-step external upload:
 * files.getUploadURLExternal -> POST the bytes -> files.completeUploadExternal
 * into the configured channel.
 *
 * Ported from cfpay src/slack-files.ts (issue #331).
 * Best-effort by contract: callers report the outcome, a Slack failure
 * never fails the screener run that produced the files.
 */

export interface SlackFile {
  filename: string;
  /** base64 content */
  contentB64: string;
  title?: string;
}

export interface SlackPostResult {
  configured: boolean;
  posted: number;
  error?: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function slackBotHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

export interface SlackFilesEnv {
  SLACK_BOT_TOKEN?: string;
  /** Channel ID for file uploads. Falls back to SCREENER_SLACK_CHANNEL. */
  SLACK_CHANNEL_ID?: string;
  SCREENER_SLACK_CHANNEL?: string;
  SLACK_CHANNEL?: string;
}

/** Post a header message, then upload each file into the channel. */
export async function postFilesToSlack(
  env: SlackFilesEnv,
  headerText: string,
  files: SlackFile[],
  doFetch: FetchFn = fetch,
): Promise<SlackPostResult> {
  const token = env.SLACK_BOT_TOKEN;
  const channel = env.SLACK_CHANNEL_ID || env.SCREENER_SLACK_CHANNEL || env.SLACK_CHANNEL;
  if (!token || !channel) {
    return {
      configured: false,
      posted: 0,
      error: "Slack file posting is not configured (SLACK_BOT_TOKEN / channel).",
    };
  }
  const headers = { Authorization: `Bearer ${token}` };
  try {
    await doFetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: slackBotHeaders(token),
      body: JSON.stringify({ channel, text: headerText }),
    });
  } catch {
    // The header is context; the files are the point. Keep going.
  }
  let posted = 0;
  let firstError: string | undefined;
  for (const file of files) {
    try {
      const bytes = b64ToBytes(file.contentB64);
      const query = new URLSearchParams({ filename: file.filename, length: String(bytes.length) });
      const upRes = await doFetch(`https://slack.com/api/files.getUploadURLExternal?${query}`, { headers });
      const up = (await upRes.json().catch(() => null)) as {
        ok?: boolean;
        upload_url?: string;
        file_id?: string;
        error?: string;
      } | null;
      if (!up?.ok || !up.upload_url || !up.file_id) {
        throw new Error(up?.error || "files.getUploadURLExternal failed");
      }
      const put = await doFetch(up.upload_url, { method: "POST", body: bytes as BodyInit });
      if (!put.ok) throw new Error(`file upload POST returned ${put.status}`);
      const doneRes = await doFetch("https://slack.com/api/files.completeUploadExternal", {
        method: "POST",
        headers: slackBotHeaders(token),
        body: JSON.stringify({
          files: [{ id: up.file_id, title: file.title || file.filename }],
          channel_id: channel,
        }),
      });
      const done = (await doneRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!done?.ok) throw new Error(done?.error || "files.completeUploadExternal failed");
      posted++;
    } catch (err) {
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
    }
  }
  return { configured: true, posted, error: firstError };
}
