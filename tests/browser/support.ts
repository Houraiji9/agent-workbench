// 浏览器测试辅助：所有数据都写入 browser-server 的独立临时账本，并标注“测试”。
import { expect, request, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskInput } from '../helpers.ts';

export const EVIDENCE = process.env.WORKBENCH_EVIDENCE_DIR || path.join('.test-tmp', 'browser-shots');
export const shot = (page: Page, name: string, fullPage = true) => { if(process.env.WORKBENCH_CAPTURE_SHOTS!=='1')return Promise.resolve(Buffer.alloc(0));fs.mkdirSync(EVIDENCE, { recursive: true }); return page.screenshot({ animations:'disabled', path: path.join(EVIDENCE, name + '.png'), fullPage }); };

/** 测试用的独立后台会话：与页面的会话分开，避免替换页面自己的操作凭据。 */
export async function api(_page: Page) {
  const ctx = await request.newContext({ baseURL: 'http://127.0.0.1:14318' });
  const boot = await (await ctx.get('/api/bootstrap')).json();
  const post = async (url: string, data: unknown, ok = true) => {
    const r = await ctx.post('/api' + url, { headers: { 'x-workbench-csrf': boot.csrf }, data: data as object });
    if (ok) expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const get = async (url: string) => (await ctx.get('/api' + url)).json();
  return { boot, post, get, root: boot.authorized_roots[0] as string };
}

export interface Made { tid: string; rid: string; root: string; project: Record<string, any>; title: string; seq: number; post: (url: string, data: unknown, ok?: boolean) => Promise<any>; get: (url: string) => Promise<any>; report(type: string, extra?: Record<string, unknown>): Promise<any> }

/** 建立一个项目和一项任务，并按需要推进到指定阶段（使用真实业务接口）。 */
export async function makeTask(page: Page, opts: { title?: string; stage?: 'ready' | 'order' | 'running' | 'submitted' | 'reviewed' | 'closeout'; skipReview?: boolean; agent?: string; userAcceptance?: string[] | null } = {}): Promise<Made> {
  const { post, get, root: base } = await api(page);
  const root = path.join(base, '测试项目-' + randomUUID().slice(0, 8));
  fs.mkdirSync(root, { recursive: true });
  const title = opts.title || '测试任务-' + randomUUID().slice(0, 6);
  const project = await post('/projects', { name: '测试项目 ' + title, path: root });
  const q = await post('/requests', { project_id: project.id, text: '测试需求：' + title, ...(opts.skipReview ? { skip_review: true, review_note: '测试：用户明确不安排审查' } : {}) });
  const agent = opts.agent || 'codex';
  const t = { ...taskInput(root), title, agent_id: agent, reviewer_id: opts.skipReview ? null : 'grok-build', ...(opts.userAcceptance === null ? {} : { user_acceptance: opts.userAcceptance || ['我能看懂测试结果', '结果符合测试需求'] }) };
  const plan = await post('/plans', { schema_version: 1, plan_id: 'plan-' + randomUUID(), request_id: q.id, expected_version: 1, tasks: [t] });
  const tid = plan.task_ids[0];
  const made: Made = {
    tid, rid: '', root, project, title, seq: 0, post, get,
    async report(type, extra = {}) {
      const detail=await get('/tasks/'+tid),task=detail.task,run=detail.runs.find((r:any)=>r.id===task.current_run_id);
      made.seq=run.seq+1;
      return post('/receipts', { schema_version: 1, event_id: 'EV-' + randomUUID(), task_id: tid, run_id: task.current_run_id, task_version: 1, seq: made.seq, event_type: type, occurred_at: new Date().toISOString(), data: { identity: agent, cwd: root, message: '测试回执：' + type, ...(type === 'submitted' ? { result: '测试结果报告：所有数据都是隔离测试数据，不代表真实执行。' } : {}), ...extra } });
    },
  };
  const stage = opts.stage || 'ready';
  if (stage === 'ready') return made;
  const order = await post('/tasks/' + tid + '/export', { version: 1 });
  made.rid = order.run_id;
  if (stage === 'order') return made;
  await made.report('started');
  if (stage === 'running') return made;
  await made.report('submitted');
  if (stage === 'submitted') return made;
  const d = await get('/tasks/' + tid);
  if(!opts.skipReview)await post('/reviews', { run_id: made.rid, reviewer_id: 'grok-build', performed: true, verdict: 'passed', evidence: '测试夹具：模拟审查引用，并非真实审查', findings: '', artifact_hashes: d.artifacts.map((a: any) => a.sha256) });
  if(stage!=='closeout')await completeCloseout(made);
  return made;
}

export async function completeCloseout(made:Made){const d=await made.get('/tasks/'+made.tid),run=d.runs.find((r:any)=>r.id===d.task.current_run_id);await made.report('closeout_started',{closeout_id:run.closeout.id});const r=await made.report('closeout_completed',{closeout_id:run.closeout.id,result:'隔离页面测试的收尾报告：核对使用入口与任务剩余事项，均已检查完成。',closeout_results:run.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离页面测试逐项核对完成'}))});expect(r.disposition).toBe('applied')}


export const nav = (page: Page, label: string) => page.locator('nav').getByRole('button', { name: label, exact: true }).click();
export const drawer = (page: Page) => page.getByRole('dialog', { name: '任务详情' });
export const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
