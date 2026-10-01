/**
 * E*TRADE OAuth Bridge (Backward Compatibility Facade)
 *
 * NOTE: The OAuth 1.0a authentication and token lifecycle have been migrated
 * to the Security Layer in `src/security/etradeOAuth.ts` as per SOLID Architecture.
 * This file re-exports all contracts, types, and functions to maintain compatibility.
 */

export * from "../security/etradeOAuth";
