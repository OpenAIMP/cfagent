/**
 * Trading Platform Registry & Abstract Factory
 *
 * Implements:
 * - Strategy Pattern (GoF): Pluggable broker implementations.
 * - Factory Pattern (GoF): Dynamic resolution based on configuration and user preference.
 * - Open/Closed Principle (OCP): New platforms register via registerPlatform().
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type { ITradingPlatform, TradingPlatformId } from "./interfaces";

export class TradingPlatformRegistry {
  private static platforms = new Map<TradingPlatformId, (env: Env, orm?: DatabaseORM, userLogin?: string) => ITradingPlatform>();

  /**
   * Registers a trading platform provider
   */
  static register(id: TradingPlatformId, factory: (env: Env, orm?: DatabaseORM, userLogin?: string) => ITradingPlatform): void {
    this.platforms.set(id, factory);
  }

  /**
   * Resolves a trading platform by ID
   */
  static getPlatform(id: TradingPlatformId, env: Env, orm?: DatabaseORM, userLogin: string = "default_trader"): ITradingPlatform {
    const factory = this.platforms.get(id);
    if (!factory) {
      // Fallback to etrade or first registered
      const fallback = this.platforms.get("etrade");
      if (fallback) return fallback(env, orm, userLogin);
      throw new Error(`Trading platform [${id}] is not registered.`);
    }
    return factory(env, orm, userLogin);
  }

  /**
   * Lists all available trading platforms
   */
  static getRegisteredPlatforms(): TradingPlatformId[] {
    return Array.from(this.platforms.keys());
  }
}
