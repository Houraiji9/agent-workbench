import React, { useEffect, useState } from 'react';
import { Copy, RefreshCw, PlugZap } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { Notice, Pill, Section } from './kit.js';
import type { Tone } from '../lib/flow.js';
import './OnboardingCard.css';

interface Model { id: string; name?: string; status: string; provider?: string; source?: string; observed_at?: string; evidence_state?: string }
interface Onboarding {
  prompt: string;
  mcp: { status: string; connection_status?: string; config_path?: string; connected_at?: string; detail?: string };
  team: { checked_at?: string; agents: { id: string; name: string; status: string; models: Model[]; registered_models?: Model[]; detail?: string }[] };
  diagnostics: { id: string; agent_name: string; model: string; status: string; checked_at?: string; reason?: string }[];
}
const labels: Record<string, string> = {
  missing: '尚未配置', current: '已配置', repair_needed: '需要修复', connected: '已验证连通', not_verified: '尚未验证',
  recorded: '已核对', stale: '记录已过期', started: '正在调用', needs_model: '待选择型号', manual_only: '需手动核对',
  output_limit: '输出超限', model_mismatch: '披露型号不匹配', authentication: '需要登录', quota: '额度不足', model_unavailable: '型号不可用',
  provider_requires_explicit_choice: '待选择 Provider', alias_requires_explicit_id: '待确认原生 ID', not_observed: '尚无本机匹配记录',
  pending: '待核对', advertised: '客户端提供，未试调用', configured: '已登记，未试调用', invocation_verified: '已验证调用',
  skipped: '按要求跳过', manual: '需手动核对', unknown: '未知', success: '调用成功', failed: '调用失败', timeout: '调用超时',
};
function State({ value }: { value: string }) {
  const tone: Tone = ['connected', 'invocation_verified', 'success'].includes(value) ? 'done' : ['failed', 'timeout', 'repair_needed'].includes(value) ? 'problem' : 'quiet';
  return <Pill tone={tone}>{labels[value] || '状态待确认'}</Pill>;
}

const sources: Record<string, string> = { team_registration: '团队登记', client_models: '客户端枚举', client_config: '客户端配置', invocation: '实际调用', manual: '手动资料' };
const PAGE_SIZE = 10;
function ModelRecords({models, label}: {models: Model[]; label: string}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const matches = models.filter(model => [model.id, model.name, model.provider].some(value => value?.toLowerCase().includes(query.trim().toLowerCase())));
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  return <div className="onboarding-records"><label>{label}搜索<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="名称、原生 ID 或 Provider" /></label>
    <p className="muted small" role="status">匹配 {matches.length} / {models.length} 条 · 每页最多 {PAGE_SIZE} 条</p>
    <ul>{matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((model, index) => <li key={model.id + ':' + (model.provider || '') + ':' + index}><span>{model.name || model.id}</span> <State value={model.status} /><p className="muted small">原生 ID：<code>{model.id}</code>{model.provider && <> · Provider：{model.provider}</>}</p><p className="muted small">来源：{sources[model.source || ''] || '未注明'}{model.observed_at && <> · {model.observed_at}</>}{model.evidence_state === 'stale' && <> · 记录已过期</>}</p></li>)}</ul>
    {!matches.length && <p className="muted small">没有匹配记录。</p>}
    <div className="onboarding-pagination"><button className="btn small ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {lastPage + 1}</span><button className="btn small ghost" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
  </div>;
}
/** 只读取已保存的状态；复制和展开预览均不执行客户端发现或调用。 */
export function OnboardingCard() {
  const s = useStore();
  const [data, setData] = useState<Onboarding | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [agentId, setAgentId] = useState('');
  const [teamOpen, setTeamOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const agent = data?.team.agents.find(item => item.id === agentId) || data?.team.agents[0];
  const diagnostics = data?.diagnostics.filter(item => [item.agent_name, item.model, item.reason, item.status, labels[item.status]].some(value => value?.toLowerCase().includes(historyQuery.trim().toLowerCase()))) || [];
  const historyLastPage = Math.max(0, Math.ceil(diagnostics.length / PAGE_SIZE) - 1);
  const currentHistoryPage = Math.min(historyPage, historyLastPage);
  const latestDiagnostic = data?.diagnostics.reduce<Onboarding['diagnostics'][number] | undefined>((latest, item) => !latest || (item.checked_at || '') > (latest.checked_at || '') ? item : latest, undefined);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true); setError('');
    void api('/onboarding', undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [revision]);
  const copy = async () => {
    if (!data?.prompt || copying) return;
    setCopying(true);
    try { if (!await s.copy(data.prompt, '首次配置提示词已复制，请交给 Codex 执行')) setExpanded(true); }
    finally { setCopying(false); }
  };
  return <div className="onboarding-card"><Section title={<><PlugZap size={19} aria-hidden="true" />首次配置工作台</>} label="首次配置工作台"
    aside={<button className="btn small ghost" disabled={pending} onClick={() => setRevision(v => v + 1)}><RefreshCw size={15} aria-hidden="true" />刷新记录</button>}>
    <p>复制提示词交给 Codex，接通工作台 MCP，并核对这台电脑的团队、原生模型 ID 和审查入口。已配置过也可用它核对或修复。</p>
    <div className="tool-row"><button className="btn primary" disabled={pending || copying || !data?.prompt} onClick={() => void copy()}><Copy size={16} aria-hidden="true" />{copying ? '正在复制…' : '复制首次配置提示词'}</button><span className="muted small">复制后由 Codex 执行；复制本身不会安装、探测或调用。</span></div>
    <Notice>Claude / Claude Code：按用户要求跳过。本流程不探测、安装或调用，保留已有团队及历史记录。</Notice>
    <div role="status" aria-live="polite" aria-busy={pending}>{pending && <p className="muted small">正在读取配置与核对记录…</p>}</div>
    {error && <Notice tone="error">{error}。请用“刷新记录”重试。</Notice>}
    {data && <>
      <details className="fold" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>预览首次配置提示词</summary><textarea className="onboarding-prompt" aria-label="首次配置提示词" readOnly value={data.prompt} spellCheck={false} /></details>
      <div className="onboarding-states">
        <div><h3>MCP 连接</h3><p className="onboarding-state-row">持久配置 <State value={data.mcp.status} /></p><p className="onboarding-state-row">新会话连通 <State value={data.mcp.connection_status === 'connected' ? 'connected' : 'not_verified'} /></p>
          <details className="fold"><summary>连接说明与配置位置</summary><p className="muted small">配置完成后，在目标 Codex 的新会话中实际列出工作台工具并完成一次只读调用，才算接通。</p>
          {data.mcp.detail && <p className="small">{data.mcp.detail}</p>}{data.mcp.config_path && <p className="muted small">配置位置：<code>{data.mcp.config_path}</code></p>}</details>
          {data.mcp.connected_at && <p className="muted small">连通记录：{data.mcp.connected_at}</p>}
        </div>
        <div><h3>团队与模型核对</h3><p className="small">{data.team.agents.length} 位 Agent · {data.team.agents.reduce((count, item) => count + (item.registered_models?.length || 0), 0)} 个团队登记型号</p><p className="muted small">核对时间：{data.team.checked_at || '尚无记录'}</p>
          {!data.team.agents.length && <p className="muted small">尚无核对记录。将提示词交给 Codex 后完成核对。</p>}
          <details className="fold" open={teamOpen} onToggle={event => setTeamOpen(event.currentTarget.open)}><summary>查看团队型号与参考目录</summary>{teamOpen && agent && <div className="onboarding-detail">
            <label>选择 Agent<select value={agent.id} onChange={event => setAgentId(event.target.value)}>{data.team.agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="onboarding-state-row"><strong>{agent.name}</strong><State value={agent.status} /></div>{agent.detail && <p className="small">{agent.detail}</p>}
            <p className="small"><strong>团队登记 · 任务型号选项</strong></p>{agent.registered_models?.length ? <ModelRecords key={agent.id + ':registered'} label="团队登记型号" models={agent.registered_models} /> : <p className="muted small">尚未登记常用型号，可在团队中编辑模型。</p>}
            <details className="fold" key={agent.id + ':reference'}><summary>客户端参考记录（{agent.models.length}）</summary><p className="muted small">枚举或配置参考不代表当前账号可用，也不会自动加入任务型号选项。</p>{agent.models.length ? <ModelRecords label="客户端参考型号" models={agent.models} /> : <p className="muted small">尚无客户端参考记录。</p>}</details>
          </div>}</details>
        </div>
        <div><h3>最小调用诊断</h3><p className="muted small">仅展示已保存的诊断；模型核对、实际调用与正式业务审查分别记录。</p>
          {latestDiagnostic ? <div className="onboarding-latest"><div className="onboarding-state-row"><strong>{latestDiagnostic.agent_name}</strong><State value={latestDiagnostic.status} /></div><p className="small">原生 ID：<code>{latestDiagnostic.model}</code></p>{latestDiagnostic.reason && <p className="small onboarding-summary-text" title={latestDiagnostic.reason}>{latestDiagnostic.reason}</p>}<p className="muted small">{latestDiagnostic.checked_at || '时间未记录'}</p></div> : <p className="muted small">尚无调用记录，未验证的入口保持未知。</p>}
          <details className="fold" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>诊断历史（{data.diagnostics.length}）</summary>{historyOpen && <div className="onboarding-detail"><label>搜索诊断历史<input type="search" value={historyQuery} onChange={event => { setHistoryQuery(event.target.value); setHistoryPage(0); }} placeholder="Agent、原生 ID、状态或原因" /></label><p className="muted small" role="status">匹配 {diagnostics.length} 条 · 每页最多 {PAGE_SIZE} 条</p><ul className="onboarding-list">{diagnostics.slice(currentHistoryPage * PAGE_SIZE, (currentHistoryPage + 1) * PAGE_SIZE).map(item => <li key={item.id}><div className="onboarding-state-row"><strong>{item.agent_name}</strong><State value={item.status} /></div><p className="small">原生 ID：<code>{item.model}</code></p>{item.reason && <p className="small">{item.reason}</p>}{item.checked_at && <p className="muted small">{item.checked_at}</p>}</li>)}</ul>{!diagnostics.length && <p className="muted small">没有匹配记录。</p>}<div className="onboarding-pagination"><button className="btn small ghost" disabled={currentHistoryPage === 0} onClick={() => setHistoryPage(currentHistoryPage - 1)}>上一页</button><span>{currentHistoryPage + 1} / {historyLastPage + 1}</span><button className="btn small ghost" disabled={currentHistoryPage >= historyLastPage} onClick={() => setHistoryPage(currentHistoryPage + 1)}>下一页</button></div></div>}</details>
        </div>
      </div>
    </>}
  </Section></div>;
}
