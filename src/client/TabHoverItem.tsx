import React from "react";

export interface TabHoverItemProps {
  eyebrow?: string;
  title: string;
  description: string;
  children: React.ReactNode;
  align?: "center" | "left" | "right";
  className?: string;
}

export function TabHoverItem({
  eyebrow,
  title,
  description,
  children,
  align = "center",
  className = "",
}: TabHoverItemProps) {
  return (
    <div className={`tab-hover-wrapper align-${align} ${className}`}>
      {children}
      <div className="tab-hover-popover" role="tooltip">
        {eyebrow && <span className="tab-hover-eyebrow">{eyebrow}</span>}
        <strong className="tab-hover-title">{title}</strong>
        <p className="tab-hover-desc">{description}</p>
      </div>
    </div>
  );
}
