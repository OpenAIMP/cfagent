import { useState } from "react";
export function ReasoningView({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning || !reasoning.trim()) return null;

  return (
    <div className="reasoning-trace">
      <div className="reasoning-header" onClick={() => setOpen(!open)}>
        <span className="reasoning-icon">💭</span>
        <span className="reasoning-title">Thought Process</span>
        <span className="reasoning-preview">
          {open ? "" : `— ${reasoning.slice(0, 70).replace(/\n/g, " ")}...`}
        </span>
        <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="reasoning-body">
          <div className="reasoning-text">{reasoning}</div>
        </div>
      )}
    </div>
  );
}
