import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { relative } from '../lib/format.js';
import { Field, Notice, Pill, Section } from './kit.js';

interface AgentClient {
  kind: string; name?: string; label?: string; status: string; version?: string; reason?: string;
  headless?: boolean; resume?: boolean; checked_at?: string;
  available?: boolean; supportsResume?: boolean; executionSupported?: boolean; reviewSupported?: boolean; checkedAt?: string;
}

const statusLabels: Record<string, string> = {
  skipped: '按要求跳过', available: '已发现', ready: '已发现', verified: '已发现', unverified: '尚未验证', missing: '未找到', not_found: '未找到',
  unsupported: '暂不支持自动调用', unavailable: '暂不可用', error: '检测失败',
  auth_required: '需要登录', permission_denied: '需要权限', checking: '正在检测',
};

/** 本机路径只在用户明确配置时提交；客户端发现由后台完成。 */
export function AgentClientsCard() {
  const s = useStore();
  const [clients, setClients] = useState<AgentClient[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState('');
  const [executable, setExecutable] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api('/agent-clients', undefined, controller.signal)
      .then(result => { setClients(result.clients); setError(''); })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, []);
  const update = async (url: string, body: object, success: string) => {
    if (pending) return;
    setPending(true); setError(''); setMessage('');
    try {
      const result = await api(url, body);
      setClients(result.clients); setMessage(success); setEditing(''); setExecutable('');
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };
  return <Section title="Agent 客户端" label="Agent 客户端" aside={<button className="btn small" disabled={pending} onClick={() => void update('/agent-clients/refresh', {}, '本机客户端状态已刷新')}><RefreshCw size={15} aria-hidden="true" />{pending ? '检测中…' : '刷新检测'}</button>}>
    <p className="muted small">工作台会在这台电脑上查找已安装的客户端。换电脑或更新后可重新检测；账号与模型是否可用，以实际调用结果为准。</p>
    {error && <Notice tone="error">{error}</Notice>}
    <div role="status" aria-live="polite">{message && <p className="small">{message}</p>}{pending && !clients.length && <p className="muted small">正在读取客户端状态…</p>}</div>
    {!pending && !error && !clients.length && <p className="muted small">尚无客户端检测记录，点击“刷新检测”重试。</p>}
    <ul className="agent-client-list">{clients.map(client => {
      const ready = ['available', 'ready', 'verified'].includes(client.status);
      const name = client.name || client.label || client.kind;
      const checkedAt = client.checked_at || client.checkedAt;
      return <li key={client.kind}>
        <div className="agent-client-heading"><strong>{name}</strong><Pill tone={ready ? 'done' : 'quiet'}>{statusLabels[client.status] || '状态待确认'}</Pill></div>
        {client.reason && <p className="small">{client.reason}</p>}
        <p className="muted small">{[client.version ? '版本 ' + client.version : '', ready ? ((client.headless || client.executionSupported || client.reviewSupported) ? '支持后台调用' : '需打开客户端操作') : '', ready && (client.resume || client.supportsResume) ? '支持续接会话' : '', checkedAt ? relative(checkedAt, s.tz) + '检测' : ''].filter(Boolean).join(' · ')}</p>
        {editing === client.kind ? <form className="agent-client-path" onSubmit={e => { e.preventDefault(); void update('/agent-clients/override', { kind: client.kind, executable: executable.trim() }, '本机路径已保存并重新检测'); }}>
          <Field label={name + ' 的程序路径'} hint="填写本机已安装程序的完整路径；仅保存在这台电脑。"><input value={executable} onChange={e => setExecutable(e.target.value)} autoFocus autoComplete="off" spellCheck={false} disabled={pending} /></Field>
          <div className="tool-row"><button className="btn small primary" disabled={pending || !executable.trim()} type="submit">保存并检测</button><button className="btn small ghost" disabled={pending} type="button" onClick={() => { setEditing(''); setExecutable(''); setError(''); }}>取消</button></div>
        </form> : !ready && client.status !== 'skipped' && <details className="fold"><summary>高级修复</summary><button className="link small" disabled={pending} onClick={() => { setEditing(client.kind); setExecutable(''); setError(''); }}>指定已安装的程序路径</button></details>}
      </li>;
    })}</ul>
  </Section>;
}
