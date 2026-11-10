// The few building blocks every page uses, so pages look alike: page head, tabs, grouped rows,
// switches, number fields, side sheets, list rows and empty states.
import { useEffect, useRef } from 'react';
import { useT } from './i18n';
import { Icon } from './icons';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep keyboard focus inside a dialog while it is open, close it on Escape, and give focus back
 * to whatever opened it when it closes.
 */
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    if (box && !box.contains(document.activeElement)) {
      const auto = box.querySelector<HTMLElement>('[autofocus]') || box.querySelector<HTMLElement>(FOCUSABLE);
      auto?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!ref.current) return;
      // Only the top-most dialog reacts.
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      } else if (e.key === 'Tab') {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return ref;
}

export function PageHead({ title, children, crumb }: { title: string; children?: React.ReactNode; crumb?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-title">
        {crumb && <div className="crumb">{crumb}</div>}
        <h1>{title}</h1>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: string; count?: number }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs-line" role="tablist">
      {tabs.map((x) => (
        <button key={x.key} role="tab" aria-selected={value === x.key} className={value === x.key ? 'on' : ''} onClick={() => onChange(x.key)}>
          {x.label}
          {x.count !== undefined && <span className="tab-count">{x.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Group({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="group">
      {(title || action) && (
        <header className="group-head">
          {title && <h3>{title}</h3>}
          {action}
        </header>
      )}
      <div className="group-card">{children}</div>
    </section>
  );
}

export function Row({ label, sub, children, htmlFor }: { label: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="g-row">
      <label className="g-label" htmlFor={htmlFor}>
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </label>
      <div className="g-control">{children}</div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch-ui ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Num({ value, min, max, step = 1, onChange, unit, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; unit?: string; label: string }) {
  return (
    <span className="num-field">
      <input type="number" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value))))} />
      {unit && <span>{unit}</span>}
    </span>
  );
}

/** A panel that slides in from the right; Escape or a click outside closes it. */
export function Sheet({ title, onClose, children, head, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; head?: React.ReactNode; wide?: boolean }) {
  const t = useT();
  const ref = useDialog<HTMLElement>(onClose);
  return (
    <div className="drawer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className={`drawer sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head">
          {head || <h2 className="sheet-h">{title}</h2>}
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label={t.closeSheet}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </aside>
    </div>
  );
}

export function EmptyState({ icon, text, action }: { icon: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-mark">
        <Icon name={icon} size={22} />
      </span>
      <p>{text}</p>
      {action}
    </div>
  );
}
