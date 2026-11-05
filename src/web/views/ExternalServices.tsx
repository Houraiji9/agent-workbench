import React, { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, KeyRound, PencilLine, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { CopyBox, Dialog, Empty, Field, Notice, Section } from '../ui/kit.js';
import type { R } from '../lib/flow.js';
import './external-services.css';

type ServiceKind = 'api' | 'cli' | 'agent_cli' | 'agent_mcp';
interface Preset {
  id: string; name: string; vendor: string; kind: ServiceKind; protocol: string; baseUrl?: string;
  authFields: string[]; capabilities: string[]; operations: string[]; docsUrls: string[]; notes: string[];
  availability: 'documented' | 'needs_verification';
}
interface Connection {
  id: string; preset_id: string; name: string; enabled: boolean; base_url: string; model: string; region: string;
  credential_configured: boolean; credential_fields: string[]; executable: string; args: string[]; cwd: string; profile: string;
  mcp_transport: 'stdio' | 'streamable-http'; mcp_url: string; timeout_ms: number;
  allowed_project_ids: string[]; allowed_agent_ids: string[]; allow_paid: boolean; daily_call_limit?: number; status: string; version: number; last_probe?: R;
}
interface Catalog { presets: Preset[]; connections: Connection[]; invocations: R[]; vault: { available: boolean; reason?: string } }
const kindNames: Record<ServiceKind, string> = { api: 'API 服务', cli: 'CLI 工具', agent_cli: 'Agent CLI', agent_mcp: 'Agent MCP' };
const statusNames: Record<string, string> = {
  configured: '已配置，待探测', unconfigured: '待配置', disabled: '已停用', missing: '程序未找到',
  verified: '探测已通过', ready: '探测已就绪', available: '探测可用', needs_verification: '待连接验证',
  documented: '已有文档', failed: '失败', error: '探测失败', running: '进行中', queued: '已排队',
  submitted: '已提交远程任务', completed: '已完成', succeeded: '已完成', cancelled: '已取消',
  command_completed: '命令已退出，任务待核实', tool_completed: '工具已返回，结果待核实',
  interrupted: '已中断', pending: '待处理', unknown: '尚未验证', needs_rebind: '需要重新配置凭据',
  configuration_checked: '配置格式已核对', local_probe_passed: '本机探测已通过', probe_failed: '探测失败',
};
const capabilityNames: Record<string, string> = {
  text: '文本', chat: '对话', image: '图像', image_generation: '生图', image_edit: '改图', video: '视频',
  audio: '音频', speech: '语音', tts: '语音合成', stt: '语音识别', embeddings: '向量', embedding: '向量',
  rerank: '重排', search: '搜索', vision: '视觉理解', agent: 'Agent 任务', coding: '编程', canvas: '画布',
  tool_calling: '工具调用', vision_input: '视觉输入', media: '多媒体', audio_video: '音视频', digital_human: '数字人', design: '设计',
};
const labelOf = (value: string) => capabilityNames[value] || value;
const protocolNames: Record<string, string> = { 'openai-chat': 'OpenAI 对话兼容', 'openai-chat-image': 'OpenAI 对话 / 图像兼容', 'openai-images': 'OpenAI Images', 'cli-json': 'CLI / JSON', mcp: 'MCP', 'minimax-native': 'MiniMax 原生 V1', 'minimax-video-v2': 'MiniMax 视频 V2', 'volcengine-ark': '火山方舟', 'volcengine-visual-signature': '火山 AK/SK 签名', 'dashscope-video': '百炼异步视频', 'dashscope-image': '百炼图像', 'siliconflow': '硅基流动', 'kling-native': '可灵原生', 'pixverse-video': 'PixVerse 视频' };
const operationNames: Record<string, string> = { chat: '对话', 'image.generate': '生成图片', 'image.edit': '编辑图片', 'video.create': '提交视频任务', 'video.status': '查询视频进度', 'file.retrieve': '获取文件', 'cli.invoke': 'CLI 调用', 'mcp.call': 'MCP 工具调用' };
const protocolLabel = (preset: Preset) => protocolNames[preset.protocol] ? `${protocolNames[preset.protocol]}（${preset.protocol}）` : preset.protocol;
const supportLabel = (preset: Preset) => preset.operations.length ? `工作台已适配：${preset.operations.map(op => operationNames[op] || op).join('、')}` : '仅支持保存配置，调用适配尚待完成。';
const secretLabel = (name: string) => ({ apiKey: 'API Key', api_key: 'API Key', accessKey: 'Access Key', access_key: 'Access Key', secretKey: 'Secret Key', secret_key: 'Secret Key', token: '访问令牌', Authorization: 'Authorization 请求头' }[name] || name);
const safeDocsUrl = (url: string) => { try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; } };
const shownStatus = (value?: string) => statusNames[value || 'unknown'] || value || '尚未验证';
const invocationStatus = (value?: string) => value === 'unknown' ? '结果未知，需核实' : shownStatus(value);
const evidenceNames: Record<string, string> = {
  command_completed: '仅确认 CLI 进程正常退出', tool_completed: '仅确认 MCP 工具已返回',
  command_failed: 'CLI 明确报告任务失败或未完成', tool_failed: 'MCP 工具返回错误', provider_rejected: '服务明确拒绝请求',
  command_accepted: 'CLI 已受理任务，完成状态待查询', provider_accepted: '服务已受理任务，完成状态待查询',
  local_artifacts_verified: '本次产物已读取并归档', invocation_verified: '服务调用结果已记录',
  invocation_failed: '调用失败', invocation_not_verified: '调用结果尚未确认', not_sent: '尚未发送到服务',
};
const invocationEvidence = (value: unknown) => typeof value === 'string' && value ? evidenceNames[value] ? `${evidenceNames[value]}（${value}）` : value : '尚无确认依据';
const formatTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
const configFields = (c: Connection) => ({ id: c.id, version: c.version, preset_id: c.preset_id, name: c.name, enabled: c.enabled, base_url: c.base_url, model: c.model, region: c.region, executable: c.executable, args: c.args, cwd: c.cwd, profile: c.profile, mcp_transport: c.mcp_transport, mcp_url: c.mcp_url, timeout_ms: c.timeout_ms, allowed_project_ids: c.allowed_project_ids, allowed_agent_ids: c.allowed_agent_ids, allow_paid: c.allow_paid, daily_call_limit: c.daily_call_limit ?? 20 });

function Docs({ preset }: { preset: Preset }) {
  return <div className="ext-docs">{preset.docsUrls.filter(safeDocsUrl).map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer">官方资料{preset.docsUrls.length > 1 ? ` ${i + 1}` : ''}<ExternalLink size={12} aria-hidden="true" /></a>)}</div>;
}

export function ExternalServices() {
  const s = useStore();
  const [data, setData] = useState<Catalog | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all');
  const [edit, setEdit] = useState<{ preset: Preset; connection?: Connection } | null>(null);
  const [calling, setCalling] = useState<{ name: string; text: string } | null>(null);
  const [detail, setDetail] = useState<R | null>(null), [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<{ connection: Connection; action: 'delete' | 'revoke' } | null>(null);
  const [notice, setNotice] = useState('');
  const queryValue = useDeferredValue(query).trim().toLowerCase();
  const requestSeq = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++requestSeq.current;
    try {
      const next: Catalog = await api('/external-services', undefined, signal);
      if (seq === requestSeq.current) { setData(next); setError(''); }
    } catch (e) { if (!signal?.aborted && seq === requestSeq.current) setError(message(e)); }
    finally { if (!signal?.aborted && seq === requestSeq.current) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh, s.changeTick]);
  const perform = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(message(e)); } finally { setBusy(''); }
  };
  const presets = (data?.presets || []).filter(p => (kind === 'all' || p.kind === kind) && [p.name, p.vendor, ...p.capabilities].join(' ').toLowerCase().includes(queryValue));
  return <div className="external-services">
    <div className="ext-intro"><div><h2>配置一次，供 Agent 调用</h2><p>集中管理 API、CLI 和应用 MCP，查看能力、调用方式及结果。</p></div><button className="btn" disabled={!!busy || loading} onClick={() => void perform('refresh', async () => { await refresh(); })}><RefreshCw size={15} aria-hidden="true" />{busy === 'refresh' ? '刷新中…' : '刷新状态'}</button></div>
    {error && <Notice tone="error">{error}</Notice>}
    {notice && <p className="ext-feedback" role="status">{notice}</p>}
    {loading && !data && <p role="status">正在读取外部服务…</p>}
    {data && <>
      {!data.vault.available && <Notice tone="warn">凭据保险库当前不可用。{data.vault.reason || '可查看连接资料；保存新密钥前需要恢复本机安全存储。'}</Notice>}
      <Section title="我的连接" aside={<span className="muted small">{data.connections.length} 个连接</span>}>
        <p className="ext-check-hint">配置检查与本机探测不会生成内容；真实调用的执行状态见下方“最近调用”。</p>
        {!data.connections.length ? <Empty icon={<Plug size={24} aria-hidden="true" />} title="从下方预设添加连接">选择服务，填写 API Key 或程序位置，再为需要的 Agent 开启调用。</Empty> : <div className="ext-connections">{data.connections.map(c => {
          const p = data.presets.find(x => x.id === c.preset_id);
          return <article className="ext-connection" key={c.id} aria-label={c.name}>
            <header><div><h3>{c.name}</h3><p>{p ? `${kindNames[p.kind]} · ${p.name}` : c.preset_id}</p></div><span className={'ext-state' + (c.enabled ? ' active' : '')}>{c.enabled ? '已启用' : '已停用'}</span></header>
            {p && <p className="ext-protocol">协议：{protocolLabel(p)}</p>}
            <div className="ext-connection-facts"><span><ShieldCheck size={14} aria-hidden="true" />{shownStatus(c.status)}</span><span><KeyRound size={14} aria-hidden="true" />{c.credential_configured ? '凭据已保存' : '未保存凭据'}</span><span>{c.allow_paid ? '允许消耗额度 / 付费调用' : '付费调用未开启'}</span></div>
            {c.last_probe && <p className="ext-probe">{c.last_probe.message || c.last_probe.reason || shownStatus(c.last_probe.status)}{c.last_probe.checked_at || c.last_probe.at ? ` · ${formatTime(c.last_probe.checked_at || c.last_probe.at)}` : ''}</p>}
            <p className="ext-scope">{c.allowed_project_ids.includes('*') ? '所有项目' : c.allowed_project_ids.length ? `${c.allowed_project_ids.length} 个指定项目` : '未授权项目'} · {c.allowed_agent_ids.includes('*') ? '所有 Agent' : c.allowed_agent_ids.length ? `${c.allowed_agent_ids.length} 位指定 Agent` : '未授权 Agent'}</p>
            <footer>
              <button className="btn small" disabled={!!busy || !p} onClick={() => p && setEdit({ preset: p, connection: c })}><PencilLine size={14} aria-hidden="true" />编辑</button>
              <button className="btn small" disabled={!!busy} onClick={() => void perform(c.id + ':probe', async () => { const result = await api(`/external-services/${encodeURIComponent(c.id)}/probe`, {}); await refresh(); setNotice(result.message || result.reason || '检测记录已更新，未发起内容生成。'); })}>{busy === c.id + ':probe' ? '检测中…' : p?.kind === 'api' ? '检查配置' : '检测连接'}</button>
              <button className="btn small" disabled={!!busy} onClick={() => void perform(c.id + ':calling', async () => { const result = await api(`/external-services/${encodeURIComponent(c.id)}/calling`); setCalling({ name: c.name, text: typeof result === 'string' ? result : result.markdown || JSON.stringify(result, null, 2) }); })}><Copy size={14} aria-hidden="true" />调用方式</button>
              {c.credential_configured && <button className="btn small" disabled={!!busy} onClick={() => setConfirm({ connection: c, action: 'revoke' })}>撤销凭据</button>}
              <button className="icon-btn" aria-label={`删除 ${c.name}`} disabled={!!busy} onClick={() => setConfirm({ connection: c, action: 'delete' })}><Trash2 size={15} aria-hidden="true" /></button>
            </footer>
          </article>;
        })}</div>}
      </Section>
      <Section title="服务预设" aside={<span className="muted small">{presets.length} / {data.presets.length}</span>}>
        <div className="library-tools ext-library-tools"><label className="library-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索外部服务" placeholder="搜索服务、厂商或能力" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="外部服务类型" value={kind} onChange={e => setKind(e.target.value)}><option value="all">所有接入类型</option>{Object.entries(kindNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></div>
        <div className="ext-preset-grid">{presets.map(p => <article className="ext-preset" key={p.id} aria-label={p.name}>
          <header><h3>{p.name}</h3><span className="ext-kind">{kindNames[p.kind]}</span></header>
          <p className="ext-vendor">{p.vendor} · {p.availability === 'needs_verification' ? '接入方式待核验' : '官方文档已登记'}</p>
          <p className="ext-protocol">协议：{protocolLabel(p)}</p>
          <div className="ext-capabilities"><small>平台能力</small>{p.capabilities.map(v => <span key={v}>{labelOf(v)}</span>)}</div>
          <p className="ext-support">{supportLabel(p)}{p.kind === 'agent_mcp' ? '；具体工具以连接检测返回的清单为准。' : p.kind === 'cli' || p.kind === 'agent_cli' ? '；具体命令以本机版本为准。' : ''}</p>
          {!!p.notes.length && <p className="ext-preset-note">{p.notes[0]}</p>}
          <footer><Docs preset={p} /><button className="btn small" onClick={() => setEdit({ preset: p })}><Plus size={14} aria-hidden="true" />添加连接</button></footer>
        </article>)}</div>
        {!presets.length && <Empty title="没有匹配的预设">换一个服务名、能力或接入类型试试。</Empty>}
      </Section>
      <Section title="最近调用" aside={<span className="muted small">调用结果与用户验收分别记录</span>}>
        {!data.invocations.length ? <p className="muted">暂无调用记录。保存和检测连接不会自动生成内容。</p> : <div className="ext-invocations">{data.invocations.map(i => <button className="ext-invocation" key={i.id} data-call-status={i.status} disabled={!!busy} onClick={() => void perform(i.id, async () => setDetail(await api(`/external-services/invocations/${encodeURIComponent(i.id)}`)))}><span><strong>{data.connections.find(c => c.id === (i.service_id || i.connection_id))?.name || i.connection_name || i.service_id || i.connection_id}</strong><small>{operationNames[i.operation] || i.operation} · {formatTime(i.created_at)}</small><small>证据：{invocationEvidence(i.evidence)}</small></span><span className="ext-invocation-state">{invocationStatus(i.status)}</span></button>)}</div>}
      </Section>
    </>}
    {edit && data && <ConnectionEditor key={edit.connection?.id || edit.preset.id} {...edit} vaultAvailable={data.vault.available} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await refresh(); setNotice('连接已保存，未发起真实调用。可以检测配置，或查看调用方式。'); }} />}
    {calling && <Dialog title={`${calling.name} · 调用方式`} onClose={() => setCalling(null)} wide footer={<button className="btn primary" onClick={() => void s.copy(calling.text, '调用方式已复制')}><Copy size={15} aria-hidden="true" />复制调用方式</button>}><CopyBox label="外部服务调用卡" text={calling.text} rows={16} /></Dialog>}
    {detail && <Dialog title="外部服务调用详情" onClose={() => setDetail(null)} wide><p><strong>{invocationStatus(detail.status)}</strong> · {operationNames[detail.operation] || detail.operation}</p><p>证据：{invocationEvidence(detail.evidence)}</p>{detail.message && <p>{detail.message}</p>}<p className="muted">仅显示本次真实调用的脱敏记录；命令退出或工具返回不代表异步媒体任务完成。执行完成仍需检查产物，不代表用户验收。</p><pre className="pre">{JSON.stringify(detail, null, 2)}</pre></Dialog>}
    {confirm && <Dialog title={confirm.action === 'delete' ? '删除外部服务连接' : '撤销保存的凭据'} onClose={() => { if (!busy) setConfirm(null); }} footer={<><button className="btn" disabled={!!busy} onClick={() => setConfirm(null)}>取消</button><button className="btn danger" disabled={!!busy} onClick={() => void perform('confirm', async () => {
      const c = confirm.connection;
      if (confirm.action === 'delete') await api(`/external-services/${encodeURIComponent(c.id)}/delete`, { version: c.version });
      else await api('/external-services/save', { ...configFields(c), enabled: false, wipe_secrets: true });
      setConfirm(null); await refresh(); setNotice(confirm.action === 'delete' ? '连接已删除。' : '凭据已撤销，连接已停用。');
    })}>{busy ? '处理中…' : confirm.action === 'delete' ? '确认删除连接' : '撤销并停用'}</button></>}><p>{confirm.action === 'delete' ? `删除“${confirm.connection.name}”后，Agent 无法再通过该连接调用。` : `撤销“${confirm.connection.name}”在工作台保存的凭据并停用连接；这不会注销服务商账号或撤销服务商签发的 Key。`}</p>{error && <Notice tone="error">{error}</Notice>}</Dialog>}
  </div>;
}

function invalidRoute(executable: string, args: string[], urls: string[]) {
  if (args.some(a => /(?:^|\s)--?(?:api[-_]?key|access[-_]?token|token|password|secret(?:[-_]?key)?|authorization)(?:[=\s]|$)/i.test(a))) return '不要把密钥或令牌放在程序参数中，请移到下方凭据字段。';
  if (executable.includes('\n')) return '程序位置只能填写一个可执行文件路径。';
  for (const raw of urls.filter(Boolean)) {
    try { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol)) return '服务地址需要使用 http 或 https。'; if (u.username || u.password || u.hash || [...u.searchParams.keys()].some(k => /key|token|secret|password|authorization/i.test(k))) return '服务地址不能包含账号、密码、片段或密钥查询参数，请使用凭据字段。'; if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return '远程服务地址需要使用 HTTPS；HTTP 仅用于本机回环服务。'; }
    catch { return '请填写完整的服务地址。'; }
  }
  return '';
}

function ConnectionEditor({ preset, connection, vaultAvailable, onClose, onSaved }: { preset: Preset; connection?: Connection; vaultAvailable: boolean; onClose(): void; onSaved(): Promise<void> }) {
  const s = useStore();
  const [form, setForm] = useState(() => ({
    name: connection?.name || preset.name, enabled: !!(connection?.enabled && connection.allowed_project_ids.length && connection.allowed_agent_ids.length && preset.operations.length), base_url: connection?.base_url || preset.baseUrl || '',
    model: connection?.model || '', region: connection?.region || '', executable: connection?.executable || '', args: (connection?.args || []).join('\n'),
    cwd: connection?.cwd || '', profile: connection?.profile || '', mcp_transport: connection?.mcp_transport || 'stdio', mcp_url: connection?.mcp_url || '',
    timeout_ms: connection?.timeout_ms || 120000, daily_call_limit: connection?.daily_call_limit ?? 20, allowed_project_ids: connection?.allowed_project_ids || [], allowed_agent_ids: connection?.allowed_agent_ids || [], allow_paid: connection?.allow_paid || false,
  }));
  const [secrets, setSecrets] = useState<Record<string, string>>({}), [secretFields, setSecretFields] = useState(() => [...new Set([...preset.authFields, ...(connection?.credential_fields || [])])]);
  const [rawMcp, setRawMcp] = useState(''), [importNotice, setImportNotice] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [newSecretName, setNewSecretName] = useState('');
  const errorRef = useRef<HTMLDivElement>(null), advancedRef = useRef<HTMLDetailsElement>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(prev => ({ ...prev, [key]: value }));
  const setScope = (key: 'allowed_project_ids' | 'allowed_agent_ids', value: string[]) => setForm(prev => ({ ...prev, [key]: value, enabled: value.length ? prev.enabled : false }));
  const hasScope = !!(form.allowed_project_ids.length && form.allowed_agent_ids.length);
  const isMcp = preset.kind === 'agent_mcp', isExecutable = preset.kind === 'cli' || preset.kind === 'agent_cli' || (isMcp && form.mcp_transport === 'stdio');
  const close = () => { if (!saving) { setSecrets({}); setRawMcp(''); onClose(); } };
  const fail = (text: string) => { setError(text); requestAnimationFrame(() => errorRef.current?.focus()); };
  const addSecretField = () => {
    const key = newSecretName.trim(), valid = isMcp && form.mcp_transport === 'streamable-http' ? /^[A-Za-z_][A-Za-z0-9_-]{0,100}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
    if (!valid.test(key)) return fail('凭据名称格式不正确，请按 CLI 或 MCP 文档填写。');
    setSecretFields(prev => [...new Set([...prev, key])]); setNewSecretName(''); setError('');
  };
  const importMcp = () => {
    try {
      const parsed = JSON.parse(rawMcp);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))) throw Error('请粘贴单个 MCP 服务配置对象。');
      const entries = parsed.mcpServers ? Object.values(parsed.mcpServers) : [parsed];
      if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object' || Array.isArray(entries[0])) throw Error('请一次导入一个 MCP 服务配置。');
      const config = entries[0] as R;
      if ((config.command !== undefined && typeof config.command !== 'string') || (config.url !== undefined && typeof config.url !== 'string')) throw Error('MCP command 和 url 需要是字符串。');
      if (config.args && (!Array.isArray(config.args) || config.args.some((v: unknown) => typeof v !== 'string'))) throw Error('MCP args 需要是字符串数组。');
      const importedArgs: string[] = config.args || [], importedUrl = String(config.url || '');
      const routeError = invalidRoute(String(config.command || ''), importedArgs, [importedUrl]);
      if (routeError) throw Error(routeError);
      if (!config.command && !importedUrl) throw Error('配置需要提供 command 或 url。');
      if (config.command && importedUrl) throw Error('一次连接请选择 command 或 url 中的一种方式。');
      if (config.type === 'sse' || config.transport === 'sse') throw Error('此入口目前支持 stdio 或 Streamable HTTP，请从应用获取对应配置。');
      for (const value of [config.env, config.headers]) if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw Error('MCP 环境变量和请求头需要是键值对象。');
      const incoming: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.env || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw Error('MCP 环境变量名称或值格式不正确。');
        incoming[key] = value;
      }
      for (const [key, value] of Object.entries(config.headers || {})) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || typeof value !== 'string') throw Error('MCP 请求头名称或值格式不正确。');
        incoming[key.toLowerCase() === 'authorization' ? 'Authorization' : `header_${key}`] = value;
      }
      setForm(prev => ({ ...prev, executable: String(config.command || ''), args: importedArgs.join('\n'), mcp_transport: importedUrl ? 'streamable-http' : 'stdio', mcp_url: importedUrl }));
      setSecrets(prev => ({ ...prev, ...incoming })); setSecretFields(prev => [...new Set([...prev, ...Object.keys(incoming)])]); setRawMcp(''); setError(''); setImportNotice('配置已填入。环境变量与请求头已转为凭据字段，请检查后保存。');
    } catch (e) { fail(e instanceof SyntaxError ? 'MCP 配置不是有效的 JSON，请检查后重试。' : message(e)); }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (saving) return;
    if (rawMcp.trim()) return fail('请先点“填入配置”导入 MCP JSON，再保存连接。');
    const args = form.args.split(/\r?\n/).filter(a => a.trim().length);
    const routeError = invalidRoute(form.executable, args, [form.base_url, form.mcp_url]);
    if (routeError) return fail(routeError);
    if (!form.name.trim()) return fail('请填写连接名称。');
    if (form.enabled && (!form.allowed_project_ids.length || !form.allowed_agent_ids.length)) return fail('启用前，请在高级设置中至少选择一个允许调用的项目和一位 Agent。');
    if (isExecutable && !form.executable.trim()) return fail('请填写已安装程序的完整路径。');
    if (isMcp && form.mcp_transport === 'streamable-http' && !form.mcp_url.trim()) return fail('请填写 MCP 服务地址。');
    if (!Number.isInteger(form.timeout_ms) || form.timeout_ms < 1000 || form.timeout_ms > 300000) return fail('超时时间需要在 1 至 300 秒之间。');
    if (!Number.isInteger(form.daily_call_limit) || form.daily_call_limit < 1 || form.daily_call_limit > 10000) return fail('每日调用次数需要是 1 至 10000 之间的整数。');
    const changedSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.length));
    if (!vaultAvailable && Object.keys(changedSecrets).length) return fail('本机凭据保险库不可用，暂时无法保存新密钥。');
    setSaving(true); setError('');
    try {
      await api('/external-services/save', { ...form, name: form.name.trim(), args, preset_id: preset.id, ...(connection ? { id: connection.id, version: connection.version } : {}), secrets: changedSecrets });
      setSecrets({}); setRawMcp(''); await onSaved();
    } catch (err) { fail(message(err)); } finally { setSaving(false); }
  };
  const projects = (s.data.projects as R[]).filter(p => !p.archived), agents = [...(s.data.agents as R[]).filter(a => !a.archived), { id: 'manager', name: '工作台管理连接' }];
  return <Dialog title={connection ? `编辑连接 · ${connection.name}` : `添加连接 · ${preset.name}`} sub={`${kindNames[preset.kind]} · ${preset.protocol}`} onClose={close} wide footer={<><button className="btn" disabled={saving} onClick={close}>取消</button><button className="btn primary" form="external-service-form" type="submit" disabled={saving}>{saving ? '保存中…' : '保存连接'}</button></>}>
    <form id="external-service-form" className="ext-form" onSubmit={save}>
      <div ref={errorRef} tabIndex={-1}>{error && <Notice tone="error">{error}</Notice>}</div>
      <div className="ext-form-intro"><Docs preset={preset} /><p>协议：{protocolLabel(preset)}</p><p>{supportLabel(preset)}</p><p>{preset.availability === 'needs_verification' ? '预设提供配置入口，实际连接方式仍需核验。' : '预设资料来自官方文档，账号权限与实际调用结果需要分别验证。'}</p>{preset.notes.map(note => <p key={note}>{note}</p>)}</div>
      <Field label="连接名称"><input value={form.name} onChange={e => set('name', e.target.value)} required maxLength={120} /></Field>
      {preset.kind === 'api' && <div className="ext-form-grid"><Field label="API 地址"><input type="url" value={form.base_url} onChange={e => set('base_url', e.target.value)} placeholder="https://…" /></Field><Field label="模型 ID" hint="填写服务商实际支持的调用 ID，可按调用需要留空。"><input value={form.model} onChange={e => set('model', e.target.value)} /></Field></div>}
      {isMcp && <>
        <details className="ext-disclosure"><summary>导入应用提供的 MCP 配置</summary><div className="ext-details-body"><Field label="MCP 配置 JSON" hint="粘贴单个服务，或只含一个服务的 mcpServers 对象。导入后原文会清空。"><textarea aria-label="MCP 配置 JSON" rows={5} value={rawMcp} onChange={e => setRawMcp(e.target.value)} spellCheck={false} autoComplete="off" /></Field><button className="btn" type="button" onClick={importMcp} disabled={!rawMcp.trim()}>填入配置</button>{importNotice && <p role="status">{importNotice}</p>}</div></details>
        <Field label="MCP 连接方式"><select value={form.mcp_transport} onChange={e => set('mcp_transport', e.target.value as 'stdio' | 'streamable-http')}><option value="stdio">本地程序（stdio）</option><option value="streamable-http">服务地址（Streamable HTTP）</option></select></Field>
        {form.mcp_transport === 'streamable-http' && <Field label="MCP 服务地址" hint="使用应用正式提供的外部调用地址。"><input aria-label="MCP 服务地址" type="url" value={form.mcp_url} onChange={e => set('mcp_url', e.target.value)} placeholder="http://127.0.0.1:…/mcp" /></Field>}
      </>}
      {isExecutable && <Field label="程序完整路径" hint="填写已安装的 exe、cmd 或其他受支持入口；保存不会安装或启动生成任务。"><input value={form.executable} onChange={e => set('executable', e.target.value)} placeholder="选择的 CLI 可执行文件路径" spellCheck={false} /></Field>}
      {!!secretFields.length && <fieldset className="ext-fieldset"><legend>凭据</legend><p className="field-hint">{connection?.credential_configured ? '已有凭据不会显示。留空保留原值，填写新值即可替换。' : '凭据存入本机保险库，不会写入调用卡或任务资料。'}</p><div className="ext-form-grid">{secretFields.map(key => <Field key={key} label={secretLabel(key)} hint={connection?.credential_fields?.includes(key) ? '已保存 · 留空保留' : undefined}><input aria-label={secretLabel(key)} type="password" autoComplete="new-password" value={secrets[key] || ''} onChange={e => setSecrets(prev => ({ ...prev, [key]: e.target.value }))} spellCheck={false} disabled={!vaultAvailable} /></Field>)}</div></fieldset>}
      {(isMcp || isExecutable) && <details className="ext-disclosure"><summary>{isMcp ? '补充环境变量或请求头凭据' : '补充环境变量凭据'}</summary><div className="ext-details-body"><p className="field-hint">{isMcp ? '环境变量使用原名称；HTTP 鉴权可用 Authorization，其他请求头使用 header_名称。可通过上方配置导入一次填入。' : '填写 CLI 文档要求的环境变量名称，例如 MINIMAX_API_KEY。值会作为凭据加密保存。'}</p><Field label="新增凭据名称"><input value={newSecretName} onChange={e => setNewSecretName(e.target.value)} placeholder={isMcp ? '例如 API_KEY 或 Authorization' : '例如 MINIMAX_API_KEY'} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSecretField(); } }} /></Field><button className="btn" type="button" disabled={!newSecretName.trim()} onClick={addSecretField}>添加凭据字段</button></div></details>}
      <details className="ext-disclosure" ref={advancedRef}><summary>高级设置 · 区域、参数、调用范围</summary><div className="ext-details-body">
        <div className="ext-form-grid"><Field label="服务区域" hint="按服务商要求填写，例如 cn、global 或地域 ID。"><input value={form.region} onChange={e => set('region', e.target.value)} /></Field><Field label="超时时间（秒）"><input type="number" min={1} step={1} value={form.timeout_ms / 1000} onChange={e => set('timeout_ms', Number(e.target.value) * 1000)} /></Field><Field label="每日最多调用次数" hint="限制调用次数，实际费用由服务商按模型和用量计算。"><input type="number" min={1} step={1} value={form.daily_call_limit} onChange={e => set('daily_call_limit', Number(e.target.value))} /></Field></div>
        {isExecutable && <><Field label="固定参数" hint="每行一个参数，保持原始边界；密钥、令牌请使用凭据字段。"><textarea rows={4} value={form.args} onChange={e => set('args', e.target.value)} spellCheck={false} /></Field><div className="ext-form-grid"><Field label="工作目录"><input value={form.cwd} onChange={e => set('cwd', e.target.value)} /></Field><Field label="配置档案（profile）"><input value={form.profile} onChange={e => set('profile', e.target.value)} /></Field></div></>}
        {preset.kind !== 'api' && <Field label="模型 ID（可选）"><input value={form.model} onChange={e => set('model', e.target.value)} /></Field>}
        <ScopePicker label="允许调用的项目" items={projects} selected={form.allowed_project_ids} onChange={v => setScope('allowed_project_ids', v)} />
        <ScopePicker label="允许调用的 Agent" items={agents} selected={form.allowed_agent_ids} onChange={v => setScope('allowed_agent_ids', v)} />
      </div></details>
      <div className="ext-access"><label><input type="checkbox" checked={form.enabled} disabled={!hasScope || !preset.operations.length} onChange={e => set('enabled', e.target.checked)} /><span><strong>启用此连接</strong><small>{!preset.operations.length ? '此预设尚无调用适配，可先保存配置。' : !hasScope ? '选择至少一个项目和一位 Agent 后才可启用；未勾选的范围不授权。' : '允许符合调用范围的 Agent 使用；保存本身不会生成内容。'}</small></span></label>{!hasScope && !!preset.operations.length && <button className="btn small" type="button" onClick={() => { if (advancedRef.current) { advancedRef.current.open = true; advancedRef.current.querySelector('summary')?.focus(); advancedRef.current.scrollIntoView({ block: 'nearest' }); } }}>选择调用范围</button>}<label><input type="checkbox" checked={form.allow_paid} onChange={e => set('allow_paid', e.target.checked)} /><span><strong>允许消耗额度或产生 API 费用</strong><small>后续实际调用可能使用服务商积分、订阅额度或付费余额。</small></span></label></div>
    </form>
  </Dialog>;
}

function ScopePicker({ label, items, selected, onChange }: { label: string; items: R[]; selected: string[]; onChange(value: string[]): void }) {
  const all = selected.includes('*');
  return <fieldset className="ext-fieldset"><legend>{label}</legend><p className="field-hint">未勾选时不授权调用。可选择指定范围，或明确允许全部。</p><div className="ext-scope-options"><label><input type="checkbox" checked={all} onChange={e => onChange(e.target.checked ? ['*'] : [])} />{label.includes('项目') ? '全部项目' : '全部 Agent'}</label>{items.map(item => <label key={item.id}><input type="checkbox" disabled={all} checked={all || selected.includes(item.id)} onChange={e => onChange(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />{item.name}</label>)}{selected.filter(id => id !== '*' && !items.some(i => i.id === id)).map(id => <label key={id}><input type="checkbox" checked onChange={() => onChange(selected.filter(v => v !== id))} />{id}（未在当前列表）</label>)}</div></fieldset>;
}
