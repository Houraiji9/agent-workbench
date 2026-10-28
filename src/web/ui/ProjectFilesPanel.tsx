import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, FolderOpen, RefreshCw, RotateCcw, Save, Search, ShieldAlert } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { bytes, fullDate } from '../lib/format.js';
import { Empty, Field, Notice, Tabs } from './kit.js';
import type { FileCategory, FileEntry, FileMove, FileRetention, FileValidity, ProjectFile, ScanResult } from '../../core/project-files.js';

type Coverage = ScanResult['coverage'];
type Preview = { kind: 'text' | 'html' | 'unavailable'; text?: string; reason?: string };
type FilesResponse = { files: ProjectFile[]; moves: FileMove[]; coverage: Coverage | null };
type EntryTab = FileEntry | 'unclassified';
type Draft = Pick<ProjectFile, 'category' | 'validity' | 'retention' | 'purpose'> & { cleanup_reason: string };

const entries: [EntryTab, string][] = [
  ['deliverable', '成果'], ['source', '工程'], ['process', '过程'], ['test', '测试'],
  ['invalid', '无效'], ['cleanup', '待清理'], ['backup', '备份'], ['unclassified', '待分类'],
];
const categoryNames: Record<FileCategory, string> = {
  deliverable: '成果', source: '工程', process: '过程', test: '测试', backup: '备份', unknown: '未知',
};
const validityNames: Record<FileValidity, string> = { current: '当前', historical: '历史', invalid: '无效', unknown: '未知' };
const retentionNames: Record<FileRetention, string> = { keep: '保留', cleanup_candidate: '待清理', moved: '已移走' };
const classificationSourceNames={user:'用户分类',agent:'Agent 分类',rule:'路径规则建议',artifact:'成果登记',unknown:'待说明'};
const moveStatusNames: Record<FileMove['status'], string> = {
  prepared: '移动未确认', moved: '已移走', failed: '移动失败', restored: '已恢复', restore_failed: '恢复失败', uncertain: '状态待核实',
};
const recoveryLocationNames = {original_only:'原文件位于原位置',destination_only:'文件位于待清理位置',both:'两处都有文件，保留双方',neither:'两处均未找到，保留记录',unverified:'尚未完成核对'};
const canRecoverMove = (move: FileMove) => ['prepared','moved','restore_failed','uncertain'].includes(move.status) && !!move.original_path && !!move.destination_path && !!move.sha256;
const recoveryLabel = (move: FileMove) => ['prepared','uncertain'].includes(move.status) ? '核对并恢复' : '恢复';

function unknown(value: unknown, labels: Record<string, string>) {
  return typeof value === 'string' && labels[value] ? labels[value] : '未知';
}

export function ProjectFilesPanel({ projectId }: { projectId: string }) {
  const s = useStore();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [moves, setMoves] = useState<FileMove[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [tab, setTab] = useState<EntryTab>('deliverable');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [previewOpen, setPreviewOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ackTemporary, setAckTemporary] = useState(false);
  const [moveReason, setMoveReason] = useState('');
  const [moveResults, setMoveResults] = useState<FileMove[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const projectGeneration = useRef(0);

  const applyResponse = (response: FilesResponse) => {
    setFiles(Array.isArray(response.files) ? response.files : []);
    setMoves(Array.isArray(response.moves) ? response.moves : []);
    setCoverage(response.coverage ?? null);
  };
  const loadFiles = async (targetProjectId = projectId, generation = projectGeneration.current) => {
    const response = await api(`/projects/${encodeURIComponent(targetProjectId)}/files`);
    if (generation === projectGeneration.current) applyResponse(response as FilesResponse);
    return response as FilesResponse;
  };

  useLayoutEffect(() => {
    const generation = ++projectGeneration.current;
    setFiles([]); setMoves([]); setCoverage(null); setPreviews({}); setPreviewOpen(new Set());
    setSelected(new Set()); setAckTemporary(false); setMoveReason(''); setMoveResults([]); setError('');
    setExpanded(new Set()); setDrafts({}); setQuery(''); setPage(0); setTab('deliverable');
    setLoading(true);
    void api(`/projects/${encodeURIComponent(projectId)}/files`).then((response: FilesResponse) => {
      if (generation === projectGeneration.current) applyResponse(response);
    }).catch((e: unknown) => {
      if (generation === projectGeneration.current) setError(e instanceof Error ? e.message : '读取项目文件失败');
    }).finally(() => { if (generation === projectGeneration.current) setLoading(false); });
    return () => { if (generation === projectGeneration.current) projectGeneration.current++; };
  }, [projectId]);

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return files.filter(file => {
      const matchesTab = tab === 'unclassified'
        ? file.category === 'unknown' || file.validity === 'unknown' || file.classification_source === 'unknown'
        : tab === 'invalid'
          ? file.validity === 'invalid' && file.retention !== 'moved'
          : tab === 'cleanup'
            ? file.retention === 'cleanup_candidate' || file.retention === 'moved'
            : file.category === tab && file.retention !== 'moved';
      const matchesSearch = !needle || `${file.path} ${file.purpose || ''}`.toLocaleLowerCase().includes(needle);
      return matchesTab && matchesSearch;
    });
  }, [files, query, tab]);
  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / 40));
  const pageFiles = visibleFiles.slice(page * 40, (page + 1) * 40);

  const actAndReload = async (action: () => Promise<unknown>, success: string) => {
    const generation = projectGeneration.current;
    const targetProjectId = projectId;
    setError('');
    const result = await s.act(async () => {
      const response = await action();
      await loadFiles(targetProjectId, generation);
      return response;
    }, success);
    if (result === null && generation === projectGeneration.current) setError('操作未完成，请查看提示后重试。');
  };
  const scan = () => void actAndReload(
    () => api(`/projects/${encodeURIComponent(projectId)}/files/scan`, {}),
    '项目文件扫描完成',
  );
  const openFile = (file: ProjectFile) => void actAndReload(
    () => api(`/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}/open`, {}),
    '已定位项目文件',
  );
  const previewFile = async (file: ProjectFile) => {
    const generation = projectGeneration.current;
    const targetProjectId = projectId;
    setPreviewOpen(old => new Set(old).add(file.id));
    setError('');
    try {
      const preview = await api(`/projects/${encodeURIComponent(targetProjectId)}/files/${encodeURIComponent(file.id)}/preview`) as Preview;
      if (generation === projectGeneration.current) setPreviews(old => ({ ...old, [file.id]: preview }));
    } catch (e) {
      if (generation === projectGeneration.current) setPreviews(old => ({ ...old, [file.id]: { kind: 'unavailable', reason: e instanceof Error ? e.message : '无法预览此文件' } }));
    }
  };
  const fileDraft = (file: ProjectFile): Draft => drafts[file.id] || {
    category: file.category,
    validity: file.validity,
    retention: file.retention === 'moved' ? 'keep' : file.retention,
    purpose: file.purpose || '',
    cleanup_reason: file.cleanup_reason || '',
  };
  const toggleEdit = (file: ProjectFile) => setExpanded(old => {
    const next = new Set(old);
    if (next.has(file.id)) next.delete(file.id);
    else { next.add(file.id); setDrafts(draftsOld => ({ ...draftsOld, [file.id]: fileDraft(file) })); }
    return next;
  });
  const changeDraft = (file: ProjectFile, changes: Partial<Draft>) => setDrafts(old => ({
    ...old, [file.id]: { ...fileDraft(file), ...changes },
  }));
  const saveClassification = (file: ProjectFile) => {
    const draft = fileDraft(file);
    void actAndReload(() => api(`/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}/classify`, {
      category: draft.category, validity: draft.validity, retention: draft.retention,
      purpose: draft.purpose, cleanup_reason: draft.cleanup_reason,
    }), '文件分类已保存');
  };
  const restoreMove = (move: FileMove) => {
    const generation = projectGeneration.current;
    const targetProjectId = projectId;
    void s.act(async()=>{
      const result=await api(`/projects/${encodeURIComponent(targetProjectId)}/files/moves/${encodeURIComponent(move.id)}/restore`, {});
      await loadFiles(targetProjectId, generation);if(result.status!=='restored')throw Error(result.error||'恢复尚未完成，请查看移动记录。');return result;
    },'文件状态已核对并恢复').then(result=>{if(result===null&&generation===projectGeneration.current)setError('文件核对或恢复未完成；请查看移动记录，双方文件均应保留。')});
  };
  const moveSelected = () => {
    if (!ackTemporary || !moveReason.trim() || !selected.size) return;
    const generation = projectGeneration.current;
    const targetProjectId = projectId;
    const selections = [...selected].map(id => ({ id, sourceDeclaration: 'user_created_temporary' as const, reason: moveReason.trim() }));
    void s.act(async () => {
      const response = await api(`/projects/${encodeURIComponent(targetProjectId)}/files/move`, { selections }) as { results: FileMove[] };
      if (generation === projectGeneration.current) setMoveResults(response.results || []);
      await loadFiles(targetProjectId, generation);
      if (generation === projectGeneration.current) { setSelected(new Set()); setAckTemporary(false); setMoveReason(''); }
      return response;
    }, '待清理文件移动请求已处理').then(result => { if (result === null && generation === projectGeneration.current) setError('移动请求失败；未成功的项目会逐项显示后端结果。'); });
  };

  return <section className="section" aria-label="项目文件">
    <div className="section-head"><h2>项目文件</h2><button className="btn small" disabled={s.busy || loading} onClick={scan}><RefreshCw size={15} />扫描项目文件</button></div>
    {error && <Notice tone="error">{error}</Notice>}
    {coverage === null
      ? <Notice tone="warn">项目文件尚未扫描。点击“扫描项目文件”开始扫描授权的项目目录。</Notice>
      : <div className="muted small">扫描范围：{coverage.scope} · 扫描状态：{coverage.complete ? '所列范围内已完成' : '所列范围内不完整'} · 已查看 {coverage.visitedEntries} 项，发现 {coverage.observedFiles} 个文件 · 跳过 {coverage.skipped} 项 · 未知 {coverage.unknown} 项 · 扫描时间 {fullDate(coverage.observed_at, s.tz)}{coverage.truncated ? ' · 已达到扫描限制' : ''}{coverage.reasons.length ? ` · ${coverage.reasons.join('、')}` : ''}</div>}
    {coverage === null && <button className="btn primary" disabled={s.busy || loading} onClick={scan}><FolderOpen size={15} />查看项目文件</button>}
    <Tabs tabs={entries.map(([id, label]) => [id, label, id === 'unclassified' ? files.filter(f => f.category === 'unknown' || f.validity === 'unknown' || f.classification_source === 'unknown').length : undefined])}
      value={tab} label="项目文件分类" onChange={value => { setTab(value as EntryTab); setPage(0); }} />
    <div className="filter-row"><Search size={16} /><input className="filter-input" aria-label="搜索文件名称或用途" placeholder="搜索文件名或用途" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} /></div>
    {tab === 'cleanup' && <section className="file-cleanup-confirm">
      <p className="muted">移动只适用于你创建且不再使用的临时文件。系统会保留恢复记录，不会删除文件。</p>
      <label className="check"><input type="checkbox" checked={ackTemporary} onChange={e => setAckTemporary(e.target.checked)} />这些是我创建且不再使用的临时文件，没有其他引用</label>
      <Field label="移动原因"><input value={moveReason} maxLength={2000} onChange={e => setMoveReason(e.target.value)} placeholder="说明为什么这些文件可以移入待清理" /></Field>
      <button className="btn danger" disabled={!ackTemporary || !moveReason.trim() || !selected.size || s.busy} onClick={moveSelected}>移动已选文件（{selected.size}）</button>
    </section>}
    {moveResults.length > 0 && <Notice tone={moveResults.some(m => m.status !== 'moved') ? 'warn' : 'info'}>
      <strong>本次移动结果</strong><ul>{moveResults.map(move => <li key={move.id} style={{ overflowWrap: 'anywhere' }}>{move.original_path}：{unknown(move.status, moveStatusNames)}{move.error ? `（${move.error}）` : ''}</li>)}</ul>
    </Notice>}
    {!loading && !pageFiles.length && <Empty title={query ? '没有找到匹配文件' : coverage ? '此分类暂无文件' : '尚无扫描结果'} />}
    <div className="row-list">
      {pageFiles.map(file => {
        const draft = fileDraft(file);
        const isMoved = file.retention === 'moved';
        const relatedMoves = moves.filter(move => move.file_id === file.id);
        const canMove = tab === 'cleanup' && file.retention === 'cleanup_candidate' && file.classification_source === 'user';
        return <article className="project-file-row" key={file.id}>
          <div className="file-row-main">
            {canMove && <input type="checkbox" aria-label={`选择 ${file.path}`} checked={selected.has(file.id)} onChange={e => setSelected(old => {
              const next = new Set(old); e.target.checked ? next.add(file.id) : next.delete(file.id); return next;
            })} />}
            <div className="file-row-copy" style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{file.path.split(/[\\/]/).pop() || file.path}</strong>
              <code style={{ display: 'block', overflowWrap: 'anywhere' }}>{file.path}</code>
              <small>{unknown(file.category, categoryNames)} · {unknown(file.validity, validityNames)} · {unknown(file.retention, retentionNames)} · {unknown(file.classification_source,classificationSourceNames)} · 登记版本 {file.revision||1}</small>
              {(file.classification_reason||file.classification?.reason)&&<small style={{display:'block',overflowWrap:'anywhere'}}>分类依据：{file.classification_reason||file.classification?.reason}</small>}
              {file.classification&&<small style={{display:'block',overflowWrap:'anywhere'}}>记录者：{file.classification.actor==='user'?'用户':file.classification.actor==='agent'?file.classification.actor_id:'系统规则或成果登记'}{file.classification.task_id?` · Task ${file.classification.task_id}`:''}{file.classification.run_id?` · Run ${file.classification.run_id}`:''} · {fullDate(file.classification.recorded_at,s.tz)}</small>}
              {file.classification_stale&&<small role="status" style={{display:'block'}}>需重新核对：{file.snapshot_warning||'文件快照已变化，原分类保留'}</small>}
              {file.purpose && <p>{file.purpose}</p>}
              <small>{file.bytes === null ? '大小未知' : bytes(file.bytes)} · {fullDate(file.mtime, s.tz)}</small>
              {file.sources?.length ? <small className="file-sources" style={{ overflowWrap: 'anywhere' }}>来源：{file.sources.map((source, index) => <span key={`${source.task_id}-${source.artifact_id}-${index}`}>{source.label || source.artifact_id} · Task {source.task_id} · Run {source.run_id || '未知'} · {source.agent_id ? s.name(source.agent_id) : 'Agent未知'} · {source.current === true ? '当前' : source.current === false ? '历史' : '未知'} · SHA-256 {source.sha256 || '未知'}</span>)}</small> : <small>来源 Task/Agent/Run：未知 · SHA-256：未知</small>}
            </div>
            <div className="file-row-actions">
              {!isMoved && <button className="btn small ghost" disabled={s.busy} onClick={() => toggleEdit(file)}><Save size={14} />{expanded.has(file.id) ? '收起分类' : '编辑分类'}</button>}
              {file.category === 'deliverable' && !isMoved && <button className="btn small ghost" disabled={s.busy} onClick={() => void previewFile(file)}><Eye size={14} />预览</button>}
              {!isMoved && <button className="btn small ghost" disabled={s.busy} onClick={() => openFile(file)}><FolderOpen size={14} />定位</button>}
              {relatedMoves.filter(canRecoverMove).map(move => <button className="btn small ghost" key={move.id} disabled={s.busy} onClick={() => restoreMove(move)}><RotateCcw size={14} />{recoveryLabel(move)}</button>)}
            </div>
          </div>
          {expanded.has(file.id) && !isMoved && <div className="file-classification-form">
            <Field label="分类"><select value={draft.category} onChange={e => changeDraft(file, { category: e.target.value as FileCategory })}>{Object.entries(categoryNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="效力"><select value={draft.validity} onChange={e => changeDraft(file, { validity: e.target.value as FileValidity })}>{Object.entries(validityNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="保留策略"><select value={draft.retention} onChange={e => changeDraft(file, { retention: e.target.value as Exclude<FileRetention, 'moved'> })}><option value="keep">保留</option><option value="cleanup_candidate">待清理</option></select></Field>
            <Field label="用途"><input maxLength={2000} value={draft.purpose} onChange={e => changeDraft(file, { purpose: e.target.value })} /></Field>
            {draft.retention === 'cleanup_candidate' && <Field label="待清理原因"><input maxLength={2000} value={draft.cleanup_reason} onChange={e => changeDraft(file, { cleanup_reason: e.target.value })} /></Field>}
            <p className="muted small"><ShieldAlert size={14} /> 分类只记录用途和保留策略，不改变文件位置或内容。</p>
            <button className="btn primary small" disabled={s.busy || (draft.retention === 'cleanup_candidate' && !draft.cleanup_reason.trim())} onClick={() => saveClassification(file)}>保存分类</button>
          </div>}
          {previewOpen.has(file.id) && <div className="file-preview">
            {!previews[file.id] ? <p className="muted">正在读取安全预览…</p> : previews[file.id].kind === 'text'
              ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{previews[file.id].text || ''}</pre>
              : previews[file.id].kind === 'html'
                ? <iframe title={`${file.path} 的隔离预览`} sandbox="" srcDoc={previews[file.id].text || ''} />
                : <Notice tone="warn">{previews[file.id].reason || '此文件无法预览。'}</Notice>}
          </div>}
          {relatedMoves.map(move => <small key={`move-${move.id}`} className="file-move-status" style={{ display: 'block', overflowWrap: 'anywhere' }}>
            移动记录：{unknown(move.status, moveStatusNames)} · 原位置：{move.original_path}{move.reconciliation ? ` · ${recoveryLocationNames[move.reconciliation.location]}` : ''} · {move.error || ''}
          </small>)}
        </article>;
      })}
    </div>
    {pageCount > 1 && <div className="pagination"><button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} / {pageCount} 页</span><button className="btn small" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>}
    {moves.some(move => ['prepared','uncertain'].includes(move.status)) && <Notice tone="warn">存在未确认的移动记录。可选择“核对并恢复”：系统会核对原位置与待清理副本、内容和占用；重名、内容变化或位置不明时保留现场，不会自动删除任何文件。</Notice>}
    {moves.length > 0 && <details className="fold"><summary>移动记录（{moves.length}）</summary><ul>{moves.map(move => <li key={move.id} style={{ overflowWrap: 'anywhere' }}>{unknown(move.status, moveStatusNames)} · {move.original_path} → {move.destination_path}{move.reconciliation ? ` · ${recoveryLocationNames[move.reconciliation.location]}` : ''}{move.error ? ` · ${move.error}` : ''}{canRecoverMove(move) && <button className="btn small ghost" disabled={s.busy} onClick={() => restoreMove(move)}>{recoveryLabel(move)}</button>}</li>)}</ul></details>}
  </section>;
}
