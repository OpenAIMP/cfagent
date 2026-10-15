import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat";
import { applyThemeToDocument, getStoredTheme, initThemeListener } from "./theme";
import { applyTypographyToDocument, getStoredFontScale, getStoredFontStyle, initTypographyListener } from "./typography";
import { applyDensityToDocument, getStoredDensity, initDensityListener } from "./designTokens";
import "./styles.css";
import "./tokens.css";

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
  window.location.replace("/auth/login");
} else {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Chat user={user} />
    </React.StrictMode>
  );
}
