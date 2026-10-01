/**
 * Pluggable Trading Capability Microservice
 *
 * Implements:
 * - Strategy + Abstract Factory + Registry patterns for broker platforms.
 * - Dynamic Market Screener.
 * - Trading Micro-Agent with HITL safety and W3C DID stamping.
 */

import { TradingPlatformRegistry } from "./registry";
import { ETradeTradingPlatform } from "./etrade/platform";
import { AlpacaTradingPlatform } from "./alpaca/platform";

// Register default pluggable platforms
TradingPlatformRegistry.register("etrade", (env, orm, userLogin) => new ETradeTradingPlatform(env, orm, userLogin));
TradingPlatformRegistry.register("alpaca", (env, orm, userLogin) => new AlpacaTradingPlatform(env, orm, userLogin));
TradingPlatformRegistry.register("sandbox", (env, orm, userLogin) => new ETradeTradingPlatform(env, orm, userLogin));

export * from "./interfaces";
export * from "./registry";
export * from "./screener";
export * from "./agent";
export * from "./etrade/client";
export * from "./etrade/platform";
export * from "./alpaca/platform";
