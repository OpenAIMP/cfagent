/**
 * What remains of the original GitHub OAuth module after #1254:
 * the logout handler and the login-page renderer. The GitHub
 * login FLOW itself is the declarative factory registration in
 * providers.ts (PR-A), served by the generic registry routes;
 * PR-B deleted the wiring-off legacy flow that used to live here
 * (handleLogin / handleOAuthCallback / exchangeGithubCode /
 * fetchGithubProfile) together with the exact /auth/login +
 * /auth/callback routes that reached it.
 */
import type { Env } from "../types";
import { clearSessionCookie, getSessionId, isSessionIdFormat, getSession, deleteSession } from "./session";
import { invalidateSessionCache } from "./sessionCache";
import {
  buildLogoutAuditEventInput,
  recordWiredAuthAudit,
} from "./iaaaAuthAudit";
import type { AuditStore } from "./iaaaAudit";
import { logoutAuditTenant } from "./iaaaGates";
import { revokeStoredTokens } from "./etradeOAuth";
import { SERVER_PALETTE } from "../theme/serverPalette";

/**
 * Audit seam for the logout hook (Phase 2b-part1). The caller —
 * server.ts /auth/logout — supplies the wiring flag, a store, and
 * the raw tenant id; logoutAuditTenant (iaaaGates.ts, a leaf
 * module) resolves them to a tenant or null. Without a resolved
 * tenant the hook is dormant and nothing is recorded. The tenant
 * is never defaulted here: inventing one would fabricate
 * attribution. No import of providers.ts here on purpose:
 * providers.ts imports this module, so importing the wiring
 * predicate back would create a cycle.
 */
export interface LogoutAuditOptions {
  wiringEnabled?: boolean;
  auditStore?: AuditStore;
  tenantId?: string;
}

export async function handleLogout(env: Env, request: Request, options?: LogoutAuditOptions): Promise<Response> {
  const sessionId = getSessionId(request);

  // Issue #329: only a UUID-shaped cookie can name a session; skipping the
  // read (and the delete) for anything else keeps junk cookies off the
  // session store.
  if (isSessionIdFormat(sessionId)) {
    try {
      // Authoritative read from the session store (not KV): logout must see the
      // real record even if a cache layer still holds a copy.
      const session = await getSession(env, sessionId);
      if (session?.githubLogin) {
        await revokeStoredTokens(env, session.githubLogin);
      }
      // #945 Phase 2b-part1 logout audit hook: record BEFORE
      // deleteSession, only for wired sessions (internalUserId
      // present), only when wiring is ON, and only when a tenant
      // resolves. Best-effort: recordWiredAuthAudit never throws,
      // and a failed write never changes the logout outcome.
      const tenantId = logoutAuditTenant({
        wiringEnabled: options?.wiringEnabled ?? false,
        internalUserId: session?.internalUserId,
        tenantId: options?.tenantId,
      });
      if (tenantId && options?.auditStore && session?.internalUserId) {
        await recordWiredAuthAudit(
          options.auditStore,
          buildLogoutAuditEventInput({
            internalUserId: session.internalUserId,
            tenantId,
            timestamp: Date.now(),
            correlationId: sessionId,
          }),
        );
      }
      invalidateSessionCache(sessionId);
      await deleteSession(env, sessionId);
    } catch {
      // Logout must never fail the request; the cookie is cleared regardless.
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

/**
 * #945 Google-as-plugin — composable login page.
 *
 * With no second argument (or an empty list) this renders exactly
 * the legacy GitHub-only page, byte for byte. When server.ts passes
 * the enabled providers (computed there and passed in, so this
 * renderer stays registry-agnostic), the
 * page renders one button per provider, href /auth/login/<id>,
 * labelled "Sign in with <displayName>". Provider ids and display
 * names are HTML-escaped; the GitHub button keeps its brand mark.
 */
export interface LoginPageProvider {
  id: string;
  displayName: string;
}

export function renderLoginPage(env: Env, providers?: LoginPageProvider[]): string {
  const multiProvider = Array.isArray(providers) && providers.length > 0;
  const intro = multiProvider
    ? "Sign in with one of your accounts to research and trade with human-approved, audit-logged workflows."
    : "Sign in with your GitHub account to research and trade with human-approved, audit-logged workflows.";
  const githubMark = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
  const buttons = multiProvider
    ? providers!
        .map((p) => {
          const mark = p.id === "github" ? `${githubMark}\n      ` : "";
          return `<a href="/auth/login/${encodeURIComponent(p.id)}" class="btn">\n      ${mark}Sign in with ${escapeHtml(p.displayName)}\n    </a>`;
        })
        .join("\n    ")
    : `<a href="/auth/login" class="btn">
      ${githubMark}
      Sign in with GitHub
    </a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${env.APP_NAME || "NextGenTP"} — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 50% 10%, ${SERVER_PALETTE.indigo950} 0%, ${SERVER_PALETTE.pageBackground} 60%, ${SERVER_PALETTE.backgroundEnd} 100%);
      color: ${SERVER_PALETTE.gray100};
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: ${SERVER_PALETTE.loginCard};
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid ${SERVER_PALETTE.whiteAlpha10};
      border-radius: 20px;
      padding: 3rem 2.5rem;
      text-align: center;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 25px 50px -12px ${SERVER_PALETTE.blackAlpha50}, 0 0 40px ${SERVER_PALETTE.primaryAlpha};
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
      background: linear-gradient(135deg, ${SERVER_PALETTE.indigo500}, ${SERVER_PALETTE.cyan500});
      border-radius: 16px;
      font-size: 2rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 8px 24px ${SERVER_PALETTE.primaryBorder};
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
      background: linear-gradient(180deg, ${SERVER_PALETTE.onGradient} 0%, ${SERVER_PALETTE.textSecondary} 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: ${SERVER_PALETTE.textMuted};
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
      background: ${SERVER_PALETTE.whiteAlpha3};
      padding: 1rem 1.25rem;
      border-radius: 12px;
      border: 1px solid ${SERVER_PALETTE.muted};
      font-size: 0.85rem;
      color: ${SERVER_PALETTE.textSecondary};
    }
    .feature-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .feature-item span {
      color: ${SERVER_PALETTE.accent};
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      background: ${SERVER_PALETTE.onGradient};
      color: ${SERVER_PALETTE.card};
      text-decoration: none;
      padding: 0.85rem 1.75rem;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      width: 100%;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px ${SERVER_PALETTE.whiteAlpha10};
    }
    .btn:hover {
      background: ${SERVER_PALETTE.slate100};
      transform: translateY(-1px);
      box-shadow: 0 6px 20px ${SERVER_PALETTE.whiteAlpha15};
    }
    .btn svg {
      width: 20px;
      height: 20px;
      fill: ${SERVER_PALETTE.card};
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-badge">🤖</div>
    <h1>${env.APP_NAME || "NextGenTP"}</h1>
    <p>${intro}</p>
    
    <div class="features">
      <div class="feature-item"><span>✦</span> trading-platform order preview with human approval</div>
      <div class="feature-item"><span>✦</span> Options strategy screening &amp; best-trade ranking</div>
      <div class="feature-item"><span>✦</span> Quant vs LLM recommendation comparison</div>
      <div class="feature-item"><span>✦</span> Signed, audited trade drafts &amp; ledger</div>
    </div>

    ${buttons}
    <a href="/" style="display:block;margin-top:1rem;color:${SERVER_PALETTE.accent};font-size:.85rem;text-decoration:none">&larr; What can this platform do?</a>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
