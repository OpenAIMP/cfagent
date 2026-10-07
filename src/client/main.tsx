import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat";
import "./styles.css";

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
