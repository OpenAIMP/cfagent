/**
 * Legacy import surface for the GitHub OAuth module. After #1254
 * PR-B deleted the login flow, only the logout handler and the
 * login-page renderer remain — re-exported by name so the shrink
 * is greppable. New code should import from
 * ./security/githubOAuth directly.
 */
export { handleLogout, renderLoginPage } from "./security/githubOAuth";
export type { LoginPageProvider, LogoutAuditOptions } from "./security/githubOAuth";
