/**
 * Unified Security & Authentication Layer
 *
 * Consolidates all authentication, authorization, and cryptographic integrity mechanisms:
 * - GitHub OAuth 2.0 (App Login & Session Management)
 * - E*TRADE OAuth 1.0a (Broker Signature Generation, Handshake & Auto-Renewal)
 * - Slack & Webhook Security (HMAC-SHA256 Signature Verification & Replay Protection)
 * - Cryptographic Session & Cookie Management
 */

export * from "./githubOAuth";
export * from "./etradeOAuth";
export * from "./session";
export * from "./webhookSecurity";
