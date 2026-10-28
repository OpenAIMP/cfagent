/**
 * Query-param router (#1804 S1, issue #1808) — the URL is the source of
 * truth for navigation. The tab lives in `?tab=<id>` (query params, so no
 * Worker fallback is needed for deep links or reloads). All other query
 * params pass through untouched — notably the screening hub's own
 * `?screenerTab=`, which keeps working exactly as before.
 *
 * Pure functions (parse/build) carry the testable behavior; the window
 * wrappers are thin. Navigation pushes state and dispatches a
 * `routechange` event (pushState fires no event on its own); Chat
 * subscribes to both `popstate` (back/forward) and `routechange`.
 */
import { resolveRouteId, type RouteId } from "./routes";

/** Tab id carried by a query string; unknown or missing ids fall back to autopilot. */
export function parseTabFromSearch(search: string): RouteId {
  const tab = new URLSearchParams(search).get("tab");
  return resolveRouteId(tab ?? "");
}

/** Query string with `tab` set, every other param preserved. */
export function buildSearchWithTab(currentSearch: string, tab: RouteId): string {
  const params = new URLSearchParams(currentSearch);
  params.set("tab", tab);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/** Tab id carried by the current URL (autopilot outside a browser). */
export function readTabFromLocation(): RouteId {
  if (typeof window === "undefined") return "autopilot";
  return parseTabFromSearch(window.location.search);
}

/**
 * Inner view id carried by a query string (#1804 S2, issue #2027): the
 * view lives in `?view=<id>`, alongside the page's `?tab=<id>`. Validation
 * is the caller's job (each page owns its view ids); unknown or missing
 * views are null and the caller falls back to its default.
 */
export function parseViewFromSearch(
  search: string,
  isValid: (value: unknown) => boolean,
): string | null {
  const view = new URLSearchParams(search).get("view");
  return view !== null && isValid(view) ? view : null;
}

/** Query string with `view` set, every other param preserved. */
export function buildSearchWithView(currentSearch: string, view: string): string {
  const params = new URLSearchParams(currentSearch);
  params.set("view", view);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/**
 * Navigate to a tab: resolve (unknown ids fall back), skip when already
 * there (no duplicate history entries for re-clicking the active item),
 * otherwise pushState and notify subscribers synchronously.
 */
export function navigateToTab(tab: string): RouteId {
  const next = resolveRouteId(tab);
  if (typeof window === "undefined") return next;
  if (parseTabFromSearch(window.location.search) === next) return next;
  const url = `${window.location.pathname}${buildSearchWithTab(window.location.search, next)}${window.location.hash}`;
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event("routechange"));
  return next;
}

/** Subscribe to tab changes from back/forward and from navigateToTab. Returns unsubscribe. */
export function subscribeToRouteChanges(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", callback);
  window.addEventListener("routechange", callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("routechange", callback);
  };
}
