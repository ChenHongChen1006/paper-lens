// ui.jsx — small presentational atoms shared across pages: Button, Card,
// Badge, Modal, Loading, EmptyState, ErrorAlert. Kept in one file since
// each is only a few lines; split out if they grow.

import { X, Inbox, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { SOURCE_SCOPE_LABELS, WEAKNESS_TYPE_LABELS } from '../lib/prompts.js';

export function Button({ variant, size, className = '', children, ...props }) {
  const classes = ['btn'];
  if (variant === 'primary') classes.push('btn-primary');
  if (variant === 'danger') classes.push('btn-danger');
  if (size === 'sm') classes.push('btn-sm');
  if (className) classes.push(className);
  return (
    <button className={classes.join(' ')} {...props}>
      {children}
    </button>
  );
}

export function Card({ className = '', children, ...props }) {
  return (
    <div className={`card ${className}`} {...props}>
      {children}
    </div>
  );
}

// sourceScope (數據細節 only) badge colors. Labels come from prompts.js
// (SOURCE_SCOPE_LABELS) so the copy has a single source of truth.
const SOURCE_SCOPE_BADGE_CLASS = {
  paper: 'badge-neutral',
  reviewed_studies: 'badge-warning',
  synthesis: 'badge-info',
  unclear: 'badge-neutral',
};

// weaknessType (弱點與延伸 only) badge colors. Labels come from prompts.js
// (WEAKNESS_TYPE_LABELS) so the copy has a single source of truth.
const WEAKNESS_TYPE_BADGE_CLASS = {
  author_limitation: 'badge-warning',
  scope_choice: 'badge-neutral',
  inferred_limitation: 'badge-info',
  field_challenge: 'badge-neutral',
  future_direction: 'badge-success',
};

const BADGE_VARIANTS = {
  exact: { cls: 'badge-success', label: '原文已核對' },
  partial: { cls: 'badge-warning', label: '部分符合' },
  not_found: { cls: 'badge-danger', label: '原文找不到這句' },
  fact: { cls: 'badge-neutral', label: '事實' },
  inference: { cls: 'badge-info', label: '推論' },
  not_mentioned: { cls: 'badge-neutral', label: '原文未提及' },
  ...Object.fromEntries(
    Object.entries(SOURCE_SCOPE_LABELS).map(([key, label]) => [
      key,
      { cls: SOURCE_SCOPE_BADGE_CLASS[key], label },
    ])
  ),
  ...Object.fromEntries(
    Object.entries(WEAKNESS_TYPE_LABELS).map(([key, label]) => [
      key,
      { cls: WEAKNESS_TYPE_BADGE_CLASS[key], label },
    ])
  ),
};

export function Badge({ kind, children, className = '' }) {
  const preset = BADGE_VARIANTS[kind];
  const cls = preset?.cls || 'badge-neutral';
  return <span className={`badge ${cls} ${className}`}>{children ?? preset?.label ?? kind}</span>;
}

export function Loading({ label = '載入中...' }) {
  return (
    <div className="loading-row">
      <Loader2 size={16} className="spin-icon" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Icon size={30} />
      </div>
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {description && <p className="mt-1" style={{ marginBottom: 0 }}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// Small inline feedback line — no border, no background fill, just an
// icon + colored text. Used for transient action results (errors,
// success confirmations, in-progress status) so the page doesn't fill up
// with heavy colored boxes. Persistent, important standing notices (e.g.
// the API key security reminder in Settings) intentionally still use the
// boxed `.alert` style instead — that's a deliberate exception, not an
// oversight.
const INLINE_ICONS = { danger: AlertTriangle, warning: AlertTriangle, success: CheckCircle2, info: null };

export function InlineNotice({ kind = 'info', message, onDismiss }) {
  if (!message) return null;
  const Icon = INLINE_ICONS[kind];
  return (
    <div className={`inline-feedback inline-feedback-${kind} mb-2`}>
      {Icon && <Icon size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
      <div style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{message}</div>
      {onDismiss && (
        <button className="modal-close" onClick={onDismiss} aria-label="關閉" style={{ padding: 0 }}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function ErrorAlert({ message, onDismiss }) {
  return <InlineNotice kind="danger" message={message} onDismiss={onDismiss} />;
}

export function Modal({ title, onClose, children, wide }) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="modal" style={wide ? { maxWidth: 760 } : undefined}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="關閉">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
