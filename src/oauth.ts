import type { Env, SessionData } from "./types";
import { createState, verifyState, createSession, setSessionCookie, clearSessionCookie, getSessionId } from "./session";
import { revokeStoredTokens } from "./security/etradeOAuth";

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

  if (error) return errorPage(`GitHub authentication was cancelled or failed: ${error}`, 400);
  if (!code || !state) return errorPage("Missing required authorization code or state parameter", 400);

  const isValidState = await verifyState(env, state);
  if (!isValidState) {
    return errorPage("Invalid or expired OAuth state session. Please try signing in again.", 403);
  }

  try {
    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) return errorPage(`Token exchange failed with upstream status ${tokenResp.status}`, 502);

    const tokenData = (await tokenResp.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      return errorPage(tokenData.error_description || tokenData.error || "GitHub did not grant an access token", 400);
    }

    const profileResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ai-search-agent",
      },
    });

    if (!profileResp.ok) return errorPage("Failed to fetch user profile from GitHub", 502);

    const user = (await profileResp.json()) as {
      login: string;
      avatar_url: string;
      name?: string | null;
    };

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
        "Set-Cookie": setSessionCookie(sessionId),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected OAuth authentication error";
    return errorPage(message, 500);
  }
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const sessionId = getSessionId(request);

  if (sessionId) {
    try {
      const rawSession = await env.SESSIONS.get(sessionId);
      if (rawSession) {
        try {
          const session = JSON.parse(rawSession) as SessionData;
          if (session?.githubLogin) {
            await revokeStoredTokens(env, session.githubLogin);
          }
        } catch {}
      }
      await env.SESSIONS.delete(sessionId);
    } catch {
      // Ignore KV deletion errors on logout
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

export function renderLoginPage(env: Env): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${env.APP_NAME || "AI Search Agent"} — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 50% 10%, #1e1b4b 0%, #0b0f19 60%, #030712 100%);
      color: #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: rgba(17, 24, 39, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 3rem 2.5rem;
      text-align: center;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(99, 102, 241, 0.15);
      animation: fadeIn 0.5s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #6366f1, #06b6d4);
      border-radius: 16px;
      font-size: 2rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
      background: linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: #94a3b8;
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 2.25rem;
    }
    .features {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      margin-bottom: 2.25rem;
      text-align: left;
      background: rgba(255, 255, 255, 0.03);
      padding: 1rem 1.25rem;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 0.85rem;
      color: #cbd5e1;
    }
    .feature-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .feature-item span {
      color: #38bdf8;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      background: #ffffff;
      color: #0f172a;
      text-decoration: none;
      padding: 0.85rem 1.75rem;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      width: 100%;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(255, 255, 255, 0.1);
    }
    .btn:hover {
      background: #f1f5f9;
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(255, 255, 255, 0.15);
    }
    .btn svg {
      width: 20px;
      height: 20px;
      fill: #0f172a;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-badge">🤖</div>
    <h1>${env.APP_NAME || "AI Multi-Agent"}</h1>
    <p>Sign in with your GitHub account to research and trade with human-approved, audit-logged workflows.</p>
    
    <div class="features">
      <div class="feature-item"><span>✦</span> trading-platform order preview with human approval</div>
      <div class="feature-item"><span>✦</span> Options strategy screening &amp; best-trade ranking</div>
      <div class="feature-item"><span>✦</span> Quant vs LLM recommendation comparison</div>
      <div class="feature-item"><span>✦</span> Signed, audited trade drafts &amp; ledger</div>
    </div>

    <a href="/auth/login" class="btn">
      <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Sign in with GitHub
    </a>
    <a href="/" style="display:block;margin-top:1rem;color:#38bdf8;font-size:.85rem;text-decoration:none">&larr; What can this platform do?</a>
  </div>
</body>
</html>`;
}

function errorPage(message: string, status = 400): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Error</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 2.5rem;
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 2.5rem; margin-bottom: 1rem; }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; color: #f87171; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; word-break: break-word; }
    a {
      display: inline-block;
      background: #3b82f6;
      color: white;
      text-decoration: none;
      padding: 0.65rem 1.25rem;
      border-radius: 8px;
      font-weight: 500;
    }
    a:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>Authentication Error</h1>
    <p>${message}</p>
    <a href="/">← Return to Sign In</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
