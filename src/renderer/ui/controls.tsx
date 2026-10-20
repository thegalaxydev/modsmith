import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ico, type IconName } from './icons';
import { store } from '../store';

export function useOverlay(open: boolean) {
  useEffect(() => (open ? store.pushOverlay() : undefined), [open]);
}

export function IconButton({ icon, label, onClick, disabled, active, tone, size = 16, className = '' }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; active?: boolean; tone?: 'danger' | 'accent'; size?: number; className?: string }) {
  return (
    <button type="button" className={`icon-btn ${active ? 'active' : ''} ${tone ?? ''} ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled} aria-pressed={active}>
      <Ico name={icon} size={size} />
    </button>
  );
}

export function Button({ icon, children, onClick, disabled, variant = 'default', title, busy, size = 'md', type = 'button' }: { icon?: IconName; children?: ReactNode; onClick?: () => void; disabled?: boolean; variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'warn'; title?: string; busy?: boolean; size?: 'sm' | 'md' | 'lg'; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}`} onClick={onClick} disabled={disabled || busy} title={title} aria-busy={busy || undefined}>
      {busy ? <Ico name="loading" size={16} className="spin" /> : icon ? <Ico name={icon} size={16} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

function flipIntoView(el: HTMLElement | null, anchor: HTMLElement | null, pos: { top: number; left: number } | null, setPos: (p: { top: number; left: number }) => void) {
  if (!el || !anchor || !pos) return;
  const h = el.getBoundingClientRect().height;
  const r = anchor.getBoundingClientRect();
  if (pos.top + h > window.innerHeight - 8 && pos.top > r.top) {
    const above = r.top - h - 6;
    const top = above >= 8 ? above : Math.max(8, window.innerHeight - h - 8);
    if (top !== pos.top) setPos({ top, left: pos.left });
  }
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  disabled?: boolean;
  hint?: string;
  danger?: boolean;
  separator?: boolean;
}

export function Menu({ trigger, items, align = 'right', label }: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode; items: MenuItem[]; align?: 'left' | 'right'; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const width = 240;
    const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left });
  }, [open, align]);
  useLayoutEffect(() => flipIntoView(menu.current, anchor.current, pos, setPos), [pos]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        anchor.current?.querySelector('button')?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={anchor} className="menu-anchor">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open &&
        pos &&
        createPortal(
          <div ref={menu} className="menu" role="menu" aria-label={label} style={{ top: pos.top, left: pos.left }}>
            {items.map((it, i) =>
              it.separator ? (
                <div key={i} className="menu-sep" role="separator" />
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  className={`menu-item ${it.danger ? 'danger' : ''}`}
                  disabled={it.disabled}
                  title={it.hint}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect?.();
                  }}
                >
                  <span className="menu-icon">{it.icon && <Ico name={it.icon} />}</span>
                  <span className="grow">{it.label}</span>
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </span>
  );
}

export function Popover({ trigger, children, width = 340, label, align = 'left' }: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode; children: (close: () => void) => ReactNode; width?: number; label: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(open);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const left = align === 'right' ? r.right - width : r.left;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [open, width, align]);
  useLayoutEffect(() => flipIntoView(panel.current, anchor.current, pos, setPos), [pos]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={anchor} className="menu-anchor">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open &&
        pos &&
        createPortal(
          <div ref={panel} className="popover" role="dialog" aria-label={label} style={{ top: pos.top, left: pos.left, width }}>
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} className={`switch ${checked ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

export function Section({ title, children, actions, collapsible, defaultOpen = true }: { title: string; children: ReactNode; actions?: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="sect">
      <div className="sect-head">
        {collapsible ? (
          <button type="button" className="sect-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Ico name={open ? 'chevronDown' : 'chevronRight'} size={14} />
            <span>{title}</span>
          </button>
        ) : (
          <h3>{title}</h3>
        )}
        <div className="spacer" />
        {actions}
      </div>
      {open && <div className="sect-body">{children}</div>}
    </section>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon: IconName; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Ico name={icon} size={20} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {actions && <div className="row center wrap">{actions}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; action?: ReactNode }) {
  const icon: IconName = tone === 'error' ? 'problems' : tone === 'warn' ? 'warning' : tone === 'success' ? 'success' : 'info';
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Ico name={icon} size={16} />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Ico name={o.icon} size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
