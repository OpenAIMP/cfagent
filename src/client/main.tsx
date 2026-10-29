import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat";
import { ToastProvider } from "./components/ui";
import { applyThemeToDocument, getStoredTheme, initThemeListener } from "./theme";
import { applyTypographyToDocument, getStoredFontScale, getStoredFontStyle, initTypographyListener } from "./typography";
import { applyDensityToDocument, getStoredDensity, initDensityListener } from "./designTokens";
import "./styles.css";
import "./tokens.css";
import "./components/ui/primitives.css";

// Startup applies preferences without writing storage.
applyThemeToDocument(getStoredTheme());
applyTypographyToDocument(getStoredFontScale(), getStoredFontStyle());
applyDensityToDocument(getStoredDensity());
const disposeThemeListener = initThemeListener();
const disposeDensityListener = initDensityListener();
const disposeTypographyListener = initTypographyListener();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeThemeListener();
    disposeDensityListener();
    disposeTypographyListener();
  });
}

const devUser = import.meta.env.DEV
  ? {
      login: "local_analyst",
      name: "Institutional Analyst",
      avatar: "https://avatars.githubusercontent.com/u/82253453?v=4",
    }
  : null;

const user = (window as any).__USER__ || devUser;

if (!user) {
  // #1254 PR-B: the exact /auth/login route is deleted; the
  // generic provider route for the default provider (github)
  // is the login start. Remember the page being refreshed so the
  // post-login boot returns to it instead of the default tab.
  try {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next.startsWith("/") && !next.startsWith("//")) {
      window.sessionStorage.setItem("auth:next", next);
    }
  } catch {
    // sessionStorage can be unavailable (private mode); the login still works.
  }
  window.location.replace("/auth/login/github");
} else {
  // Restore the page saved before the login redirect, before Chat reads
  // the URL, so a refresh lands back on the same tab/view.
  try {
    const next = window.sessionStorage.getItem("auth:next");
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      window.sessionStorage.removeItem("auth:next");
      window.history.replaceState({}, "", next);
    }
  } catch {
    // Ignore storage failures; the default tab is still valid.
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ToastProvider>
        <Chat user={user} />
      </ToastProvider>
    </React.StrictMode>
  );
}
