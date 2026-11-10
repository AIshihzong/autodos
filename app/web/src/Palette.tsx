import { useEffect, useMemo, useState } from 'react';
import { State } from './api';
import { PhaseBadge, todoKey } from './Board';
import { useT } from './i18n';
import { Icon } from './icons';
import { useDialog } from './ui';

export type Page = 'inbox' | 'workspace' | 'chat' | 'agents' | 'projects' | 'schedules' | 'usage' | 'settings';
export const PAGES: { key: Page; icon: string }[] = [
  { key: 'inbox', icon: 'inbox' },
  { key: 'workspace', icon: 'work' },
  { key: 'chat', icon: 'chat' },
  { key: 'agents', icon: 'agents' },
  { key: 'projects', icon: 'folder' },
  { key: 'schedules', icon: 'clock' },
  { key: 'usage', icon: 'chart' },
  { key: 'settings', icon: 'gear' },
];

export function Palette({ state, onClose, onOpen, onGo }: { state: State; onClose: () => void; onOpen: (id: string) => void; onGo: (p: Page) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useDialog<HTMLDivElement>(onClose);

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    const pages = PAGES.filter((p) => !s || String((t as any)[p.key] || p.key).toLowerCase().includes(s) || p.key.includes(s)).map((p) => ({ kind: 'page' as const, key: p.key, label: String((t as any)[p.key] || p.key), icon: p.icon }));
    const todos = state.todos
      .filter((x) => !s || `#${x.number} ${todoKey(x, state)} ${x.title}`.toLowerCase().includes(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12)
      .map((x) => ({ kind: 'todo' as const, key: x.id, label: x.title, todo: x }));
    return [...todos, ...pages];
  }, [q, state.todos, t]);

  useEffect(() => setSel(0), [q]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    if (it.kind === 'todo') onOpen(it.key);
    else onGo(it.key as Page);
  };

  return (
    <div className="modal-back top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="palette" role="dialog" aria-modal="true" aria-label={t.search}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder={t.paletteHint}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              else if (e.key === 'Enter') choose(sel);
              else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list">
          {items.length === 0 && <p className="empty">{t.noResults}</p>}
          {items.map((it, i) => (
            <button key={it.kind + it.key} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              {it.kind === 'todo' ? (
                <>
                  <span className="num">{todoKey(it.todo, state)}</span>
                  <span className="grow ellipsis">{it.label}</span>
                  <PhaseBadge phase={it.todo.phase} />
                </>
              ) : (
                <>
                  <Icon name={it.icon} />
                  <span className="grow">
                    {t.goTo} · {it.label}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
