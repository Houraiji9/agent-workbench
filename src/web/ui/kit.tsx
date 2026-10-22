// 基础组件：对话框、抽屉、接力线、状态标签、头像、页签与空状态。
import React, { useEffect, useId, useRef } from 'react';
import { X, Check } from 'lucide-react';
import { type Relay, type Tone, statusText, toneOfStatus } from '../lib/flow.js';

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') || node?.querySelector<HTMLElement>('.dialog-body textarea, .dialog-body input, .dialog-body select') || node?.querySelector<HTMLElement>('button');
    setTimeout(() => (first || node)?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length > 0);
        if (!items.length) return;
        const a = items[0], z = items[items.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    node?.addEventListener('keydown', onKey);
    return () => { node?.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

export function Dialog({ title, sub, onClose, children, wide, footer, label }: {
  title: string; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode; label?: string;
}) {
  const ref = useFocusTrap(true, onClose);
  const id = useId();
  return <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} tabIndex={-1} className={'dialog' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-labelledby={id} aria-label={label}>
      <header className="dialog-head">
        <div>
          <h2 id={id}>{title}</h2>
          {sub && <p className="dialog-sub">{sub}</p>}
        </div>
        <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="dialog-body">{children}</div>
      {footer && <footer className="dialog-foot">{footer}</footer>}
    </div>
  </div>;
}

export function Drawer({ onClose, children, label }: { onClose: () => void; children: React.ReactNode; label: string }) {
  const ref = useFocusTrap(true, onClose);
  return <div className="drawer-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <aside ref={ref} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label={label}>
      {children}
    </aside>
  </div>;
}

export function Pill({ status, tone, children }: { status?: string; tone?: Tone; children?: React.ReactNode }) {
  const t = tone || (status ? toneOfStatus[status] : 'quiet') || 'quiet';
  return <span className={'pill t-' + t}>{children ?? (status ? statusText[status] || status : '')}</span>;
}

/** 接力线：六个交接点，接力棒停在谁手里一目了然。 */
export function RelayTrack({ relay, compact }: { relay: Relay; compact?: boolean }) {
  const { legs, at, tone } = relay;
  if (compact) {
    return <div className={'relay-mini t-' + tone} aria-label={at < 0 ? '已取消' : at >= legs.length ? '全部完成' : `第 ${at + 1} 步，共 ${legs.length} 步：${legs[at].label}`}>
      {legs.map((l, i) => <span key={l.key} className={i < at || at >= legs.length ? 'done' : i === at ? 'now' : ''} />)}
    </div>;
  }
  return <ol className={'relay t-' + tone} aria-label="任务进度">
    {legs.map((l, i) => {
      const state = at < 0 ? 'off' : i < at || at >= legs.length ? 'done' : i === at ? 'now' : 'todo';
      const skipped = l.key === 'review' && relay.skippedReview;
      return <li key={l.key} className={state + (skipped ? ' skipped' : '')} aria-current={state === 'now' ? 'step' : undefined}>
        <span className="relay-dot">{state === 'done' ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
        <span className="relay-label">{l.label}</span>
        <span className="relay-who">{l.who}</span>
      </li>;
    })}
  </ol>;
}

const avatarHues = [208, 162, 28, 268, 340, 190, 120, 44, 300, 230, 10, 80, 250, 150];
export function Avatar({ name, id, size = 34 }: { name: string; id: string; size?: number }) {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = avatarHues[h % avatarHues.length];
  const letter = (name.replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase();
  return <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.44, ['--hue' as string]: hue } as React.CSSProperties}>{letter}</span>;
}

export function Tabs({ tabs, value, onChange, label }: { tabs: [string, string, number?][]; value: string; onChange(v: string): void; label: string }) {
  return <div className="tabs" role="tablist" aria-label={label}>
    {tabs.map(([k, text, count]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
      {text}{count ? <span className="tab-count">{count}</span> : null}
    </button>)}
  </div>;
}

export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty">
    {icon && <div className="empty-icon">{icon}</div>}
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: React.ReactNode }) {
  return <div className={'notice n-' + tone} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function Section({ title, aside, children, label }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; label?: string }) {
  return <section className="section" aria-label={label || (typeof title === 'string' ? title : undefined)}>
    <div className="section-head"><h2>{title}</h2>{aside}</div>
    {children}
  </section>;
}

/** 可复制的长文本：显示内容本身，剪贴板被系统拒绝时用户仍能手动选取。 */
export function CopyBox({ text, rows = 5, label }: { text: string; rows?: number; label: string }) {
  return <textarea className="copy-box" readOnly rows={rows} aria-label={label} value={text} onFocus={e => e.currentTarget.select()} />;
}
