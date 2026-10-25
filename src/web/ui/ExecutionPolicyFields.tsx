import React from 'react';
import type { R } from '../lib/flow.js';
import { Field, Notice } from './kit.js';

type ModelOption = { id: string; name?: string };

export function ExecutionPolicyFields({ value, onChange, models = [], disabled = false, emptyLabel = '按规划建议' }: {
  value: R;
  onChange(value: R): void;
  models?: ModelOption[];
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const policy = {
    main_model: value.main_model ?? null,
    allow_subagents: value.allow_subagents ?? false,
    child_models: Array.isArray(value.child_models) ? value.child_models as string[] : [],
    autonomy: value.autonomy ?? 'fixed',
    max_concurrency: value.max_concurrency ?? 2,
    max_depth: value.max_depth ?? 1,
    max_calls: value.max_calls ?? 6,
    context_bytes: value.context_bytes ?? 49152,
    token_budget: value.token_budget ?? null,
    note: value.note ?? '',
  };
  const update = (changes: R) => onChange({ ...value, ...changes });

  return <fieldset disabled={disabled} className="form" aria-label="执行权限与模型">
    <Field label="主模型">
      <select value={policy.main_model || ''} onChange={e => update({ main_model: e.target.value || null })}>
        <option value="">{emptyLabel}</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select>
    </Field>

    <label className="check">
      <input type="checkbox" checked={policy.allow_subagents} onChange={e => update({ allow_subagents: e.target.checked })} />
      允许使用子代理
    </label>

    <Field label="允许使用的子模型">
      {models.length ? <select multiple size={Math.min(Math.max(models.length, 3), 8)} value={policy.child_models}
        onChange={e => update({ child_models: Array.from(e.currentTarget.selectedOptions, option => option.value) })}>
        {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select> : <Notice>未取得可选模型</Notice>}
    </Field>

    <p className="muted small">客户端内部子代理仅能下发要求，工作台目前不能强制拦截；Token是软提醒。</p>

    <details className="fold">
      <summary>高级设置</summary>
      <Field label="自主模式">
        <select value={policy.autonomy} onChange={e => update({ autonomy: e.target.value })}>
          <option value="fixed">固定设置</option>
          <option value="within_allowlist">允许名单内自主选择</option>
        </select>
      </Field>
      <Field label="最大并发（1–4）">
        <input type="number" min={1} max={4} step={1} value={policy.max_concurrency}
          onChange={e => update({ max_concurrency: Number(e.target.value) })} />
      </Field>
      <Field label="最大层数（0–2）">
        <input type="number" min={0} max={2} step={1} value={policy.max_depth}
          onChange={e => update({ max_depth: Number(e.target.value) })} />
      </Field>
      <Field label="总次数上限（0–30）">
        <input type="number" min={0} max={30} step={1} value={policy.max_calls}
          onChange={e => update({ max_calls: Number(e.target.value) })} />
      </Field>
      <Field label="每个子代理上下文（KiB，1–256）">
        <input type="number" min={1} max={256} step={1} value={Math.round(policy.context_bytes / 1024)}
          onChange={e => update({ context_bytes: Number(e.target.value) * 1024 })} />
      </Field>
      <Field label="Token提醒预算（可留空）">
        <input type="number" min={1} max={100000000} step={1} value={policy.token_budget ?? ''}
          onChange={e => update({ token_budget: e.target.value === '' ? null : Number(e.target.value) })} />
      </Field>
      <Field label="执行说明">
        <textarea rows={2} maxLength={2000} value={policy.note}
          onChange={e => update({ note: e.target.value })} />
      </Field>
    </details>
  </fieldset>;
}
