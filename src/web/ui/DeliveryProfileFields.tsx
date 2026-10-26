import React, { useRef } from 'react';
import { Field } from './kit.js';
import type { DeliveryProfile } from '../../core/delivery-profile.ts';
import './delivery-form.css';

type DeliveryProfileFieldsProps = {
  value: DeliveryProfile;
  onChange(value: DeliveryProfile): void;
  disabled?: boolean;
};

const artifactOptions: [DeliveryProfile['artifacts'][number], string][] = [
  ['source', '源码'],
  ['software', '可运行的软件'],
  ['service', '服务或接口'],
  ['document', '说明文档'],
  ['media', '图片、音频或视频'],
  ['other', '其他成果'],
];

const deploymentOptions: [DeliveryProfile['deployment']['mode'], string][] = [
  ['none', '不需要部署'],
  ['local', '在本机使用'],
  ['remote', '部署到远程环境'],
  ['other', '其他方式'],
];

function withDeployment(value: DeliveryProfile, patch: Partial<DeliveryProfile['deployment']>): DeliveryProfile {
  return { ...value, deployment: { ...value.deployment, ...patch } };
}

export function DeliveryProfileFields({ value, onChange, disabled = false }: DeliveryProfileFieldsProps) {
  // Keep each location's draft separate, including the portable target and verification.
  const locations = useRef<Partial<Record<DeliveryProfile['deployment']['mode'], DeliveryProfile['deployment']>>>({});
  locations.current[value.deployment.mode] = value.deployment;
  const setArtifact = (artifact: DeliveryProfile['artifacts'][number], checked: boolean) => {
    if (!checked && value.artifacts.length <= 1) return;
    const artifacts = checked
      ? [...new Set([...value.artifacts, artifact])]
      : value.artifacts.filter(item => item !== artifact);
    onChange({ ...value, artifacts });
  };

  return <div className="delivery-profile-fields">
    <fieldset className="check-list delivery-artifacts" disabled={disabled}>
      <legend className="field-label">交付成果（可多选）</legend>
      {artifactOptions.map(([key, label]) => <label className="check" key={key}>
        <input type="checkbox" disabled={disabled || (value.artifacts.length === 1 && value.artifacts.includes(key))}
          checked={value.artifacts.includes(key)} onChange={e => setArtifact(key, e.target.checked)} />
        {label}
      </label>)}
    </fieldset>
    <Field label="交付后在哪里使用">
      <select disabled={disabled} value={value.deployment.mode}
        onChange={e => {
          const mode = e.target.value as DeliveryProfile['deployment']['mode'];
          const previous = locations.current[mode];
          onChange({ ...value, deployment: previous || { ...value.deployment, mode, target: '', verification: mode === 'none' ? 'none' : 'executor_reported' } });
        }}>
        {deploymentOptions.map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
      </select>
    </Field>
    {value.deployment.mode !== 'none' && <Field label={value.deployment.verification === 'portable_manifest' ? '本机运行目录' : '使用位置补充说明（可选）'}>
      <input disabled={disabled} required={value.deployment.verification === 'portable_manifest'} maxLength={4000} value={value.deployment.target}
        onChange={e => onChange(withDeployment(value, { target: e.target.value }))}
        placeholder={value.deployment.mode === 'local' ? '例如：我的 Windows 电脑' : value.deployment.mode === 'remote' ? '例如：现有测试服务器' : '简单描述即可'} />
    </Field>}
    <details className="fold delivery-notes">
      <summary>成果与使用说明（可选）</summary>
      <Field label="成果补充说明（可选）">
        <textarea rows={2} maxLength={4000} disabled={disabled} value={value.artifact_description || ''}
          onChange={e => onChange({ ...value, artifact_description: e.target.value })}
          placeholder="只写需要特别说明的成果要求" />
      </Field>
      {value.deployment.mode !== 'none' && <>
      <Field label="部署或安装方式（可选）">
        <textarea rows={2} maxLength={3000} disabled={disabled} value={value.deployment.deploy}
          onChange={e => onChange(withDeployment(value, { deploy: e.target.value }))}
          placeholder="如果有偏好，可以写在这里" />
      </Field>
      <Field label="怎样确认运行正常（可选）">
        <textarea rows={2} maxLength={3000} disabled={disabled} value={value.deployment.health}
          onChange={e => onChange(withDeployment(value, { health: e.target.value }))}
          placeholder="例如：能正常打开并完成一次主要操作" />
      </Field>
      <Field label="出现问题时怎样恢复（可选）">
        <textarea rows={2} maxLength={3000} disabled={disabled} value={value.deployment.rollback}
          onChange={e => onChange(withDeployment(value, { rollback: e.target.value }))}
          placeholder="不确定时可以留空" />
      </Field>
      </>}
    </details>
  </div>;
}

export function ImportanceField({ value, onChange, disabled = false }: {
  value: 'normal' | 'critical';
  onChange(value: 'normal' | 'critical'): void;
  disabled?: boolean;
}) {
  const hint = value === 'critical'
    ? '建议优先高能力模型，完整独立审查。'
    : '优先使用够用的经济模型。';
  return <Field label="需求重要程度" hint={hint}>
    <select disabled={disabled} value={value} onChange={e => onChange(e.target.value as 'normal' | 'critical')}>
      <option value="normal">普通</option>
      <option value="critical">重点</option>
    </select>
  </Field>;
}

const artifactLabels = new Map(artifactOptions);
const deploymentLabels = new Map(deploymentOptions);

export function deliverySummary(profile: DeliveryProfile): string {
  const artifacts = profile.artifacts.map(item => artifactLabels.get(item) || item).filter(Boolean);
  const mode = deploymentLabels.get(profile.deployment.mode) || profile.deployment.mode;
  const target = profile.deployment.mode !== 'none' && profile.deployment.target.trim();
  return `${artifacts.length ? artifacts.join('、') : '由 Codex 补充成果'} · ${mode}${target ? `（${target}）` : ''}`;
}
