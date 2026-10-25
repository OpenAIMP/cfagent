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
  private static platforms = new Map<TradingPlatformId, (env: Env, orm?: DatabaseORM, userLogin?: string, overrideEnv?: string) => ITradingPlatform>();

  /**
   * Registers a trading platform provider. The factory may accept an
   * overrideEnv (the caller's requested broker environment, e.g.
   * "live"/"sandbox") — factories that do not model environments
   * simply ignore it.
   */
  static register(id: TradingPlatformId, factory: (env: Env, orm?: DatabaseORM, userLogin?: string, overrideEnv?: string) => ITradingPlatform): void {
    this.platforms.set(id, factory);
  }

  /**
   * Resolves a trading platform by ID
   */
  static getPlatform(id: TradingPlatformId, env: Env, orm?: DatabaseORM, userLogin: string = "default_trader", overrideEnv?: string): ITradingPlatform {
    const factory = this.platforms.get(id);
    if (!factory) {
      // Fallback to etrade or first registered
      const fallback = this.platforms.get("etrade");
      if (fallback) return fallback(env, orm, userLogin, overrideEnv);
      throw new Error(`Trading platform [${id}] is not registered.`);
    }
    return factory(env, orm, userLogin, overrideEnv);
  }

  /**
   * Lists all available trading platforms
   */
  static getRegisteredPlatforms(): TradingPlatformId[] {
    return Array.from(this.platforms.keys());
  }
}
