import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat";
import "./styles.css";

const user = (window as any).__USER__;

if (!user) {
  window.location.replace("/auth/login");
} else {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Chat user={user} />
    </React.StrictMode>
  );
}
