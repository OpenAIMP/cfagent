import React from 'react';
import './foundations.css';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
}
export function Button({ variant = 'secondary', size = 'md', loading = false, disabled, type = 'button', className = '', children, ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
    data-variant={variant} data-size={size} className={`ds-button ${className}`}>
    {loading && <span aria-hidden="true">… </span>}{children}
  </button>;
}

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'card' | 'raised' | 'sunken';
}
export function Surface({ tone = 'card', className = '', ...props }: SurfaceProps) {
  return <div {...props} data-tone={tone} className={`ds-surface ${className}`} />;
}

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> { tone?: StatusTone; }
/** Static label by default; callers choose whether an update needs a live region. */
export function StatusBadge({ tone = 'neutral', className = '', ...props }: StatusBadgeProps) {
  return <span {...props} data-tone={tone} className={`ds-status-badge ${className}`} />;
}

export interface AsyncStateProps {
  state: 'loading' | 'empty' | 'error';
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}
/** Use for transitions and failures, not around every polling update. */
export function AsyncState({ state, title, description, action, className = '' }: AsyncStateProps) {
  return <div className={`ds-async-state ${className}`} data-state={state}
    role={state === 'error' ? 'alert' : 'status'} aria-atomic="true">
    <strong className="ds-async-state-title">{title}</strong>
    {description && <p className="ds-async-state-description">{description}</p>}
    {action && <div className="ds-async-state-action">{action}</div>}
  </div>;
}
