import type { Env, SessionData } from "./types";
import { createState, verifyState, createSession } from "./session";

function getRedirectUri(env: Env): string {
  return `${env.APP_BASE_URL}/auth/callback`;
}

export async function handleLogin(env: Env): Promise<Response> {
  const state = await createState(env);
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: getRedirectUri(env),
    scope: "read:user",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `https://github.com/login/oauth/authorize?${params}` },
  });
}

export async function handleOAuthCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return errorPage(`GitHub auth error: ${error}`);
  if (!code || !state) return errorPage("Missing code or state parameter");

  if (!(await verifyState(env, state))) return errorPage("Invalid OAuth state", 400);

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenResp.ok) return errorPage("Token exchange failed", 500);
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) return errorPage("No access token", 500);

  const profileResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ai-search-agent",
    },
  });

  if (!profileResp.ok) return errorPage("Failed to fetch user profile", 500);
  const user = await profileResp.json();

  const sessionData: SessionData = {
    githubLogin: user.login,
    githubAvatar: user.avatar_url,
    githubName: user.name || user.login,
    createdAt: Date.now(),
  };

  const sessionId = await createSession(env, sessionData);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
    },
  });
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const sessionId = request.headers.get("Cookie")?.match(/session_id=([^;]+)/)?.[1];
  if (sessionId) await env.SESSIONS.delete(sessionId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": "session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    },
  });
}

export function renderLoginPage(env: Env): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${env.APP_NAME} — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 3rem; text-align: center; max-width: 400px; width: 90%; }
    .card h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .card p { color: #8b949e; margin-bottom: 2rem; }
    .btn { display: inline-flex; align-items: center; gap: 0.5rem; background: #238636; color: white; text-decoration: none; padding: 0.75rem 1.5rem; border-radius: 8px; font-size: 1rem; font-weight: 600; }
    .btn:hover { background: #2ea043; }
    .btn svg { width: 20px; height: 20px; fill: white; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${env.APP_NAME}</h1>
    <p>Sign in with GitHub to start chatting with your AI Search agent.</p>
    <a href="/auth/login" class="btn">
      <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Sign in with GitHub
    </a>
  </div>
</body>
</html>`;
}

function errorPage(message: string, status = 200): Response {
  return new Response(
    `<!html><body style="font-family:system-ui;padding:2rem"><h1>Auth Error</h1><p>${message}</p><a href="/">← Back</a></body></html>`,
    { status, headers: { "Content-Type": "text/html" } }
  );
}
