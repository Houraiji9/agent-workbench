// 设置：外观、授权文件夹、备份、Codex 接入、高级工具与回执问题。
import React from 'react';
import { Sun, Moon, ShieldPlus, HardDriveDownload, ClipboardPaste, FileInput, Copy, TriangleAlert } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import type { R } from '../lib/flow.js';
import { relative } from '../lib/format.js';
import { Section, Notice } from '../ui/kit.js';

export function Settings() {
  const s = useStore();
  const { data } = s;
  return <div className="page-wrap settings-page">
    <header className="page-head"><div><h1>设置</h1><p>管理本机数据、项目文件夹和备份。</p></div></header>
    <div className="settings-cols">

    <Section title="外观">
      <div className="seg" role="radiogroup" aria-label="外观">
        <button role="radio" aria-checked={s.theme !== 'dark'} className={s.theme !== 'dark' ? 'on' : ''} onClick={() => s.setTheme('light')}><Sun size={16} />浅色</button>
        <button role="radio" aria-checked={s.theme === 'dark'} className={s.theme === 'dark' ? 'on' : ''} onClick={() => s.setTheme('dark')}><Moon size={16} />深色</button>
      </div>
      <h3 className="set-sub">界面大小</h3>
      <p className="small">在桌面版里按 <kbd>Ctrl</kbd> + <kbd>+</kbd> 放大、<kbd>Ctrl</kbd> + <kbd>-</kbd> 缩小、<kbd>Ctrl</kbd> + <kbd>0</kbd> 恢复自动大小。大屏幕（例如 2K、4K）会自动放大一些，调整后会记住。</p>
      <p className="muted small">时间按 {data.timezone} 显示（在项目的 config/local.json 里修改）。</p>
    </Section>

    <Section title="授权的文件夹" aside={<button className="btn small" onClick={() => s.openDialog('add-root')}><ShieldPlus size={15} />授权新文件夹</button>}>
      <p className="muted small">在这些文件夹内登记和管理项目。</p>
      <ul className="path-list">{data.authorized_roots.map((p: string) => <li key={p} className="path-row"><code>{p}</code><button className="btn small ghost" onClick={() => void s.copy(p, '路径已复制')}><Copy size={14} />复制</button></li>)}</ul>
    </Section>

    <Section title="备份">
      <p>备份会保存任务账本、归档的成果、执行包和工作台本地凭据。项目源码和第三方工具里的原始会话仍由它们自己保管。</p>
      <Notice tone="warn">备份里有本机凭据，请只保存在这台电脑上，不要发给别人。</Notice>
      <button className="btn" disabled={s.busy} onClick={() => void s.act(async () => { const r = await api('/backup', {}); s.toast('备份已保存到：' + r.path); return r; })}><HardDriveDownload size={16} />立即备份</button>
      <p className="muted small">恢复备份需要先关闭工作台，再按 README 里“备份与恢复”的步骤操作，会恢复到一个新目录，不覆盖现有数据。</p>
    </Section>

    <Section title="让 Codex 接入工作台">
      <p>在本项目文件夹里打开 Codex（新开或重启会话），它会自动加载工作台的规划接口，可以读取项目资料、提交计划、生成执行单。详细说明见项目里的 docs/CODEX_PLANNER.md。</p>
      <p className="muted small">没有接入时，也可以把计划内容复制给你，再用下面的“粘贴计划”导入。</p>
    </Section>

    <Section title="手动导入">
      <div className="tool-row">
        <button className="btn small" onClick={() => s.openDialog('import-plan')}><ClipboardPaste size={15} />粘贴 Codex 的计划</button>
        <button className="btn small" onClick={() => s.openDialog('receipt')}><FileInput size={15} />导入执行回执</button>
      </div>
      <p className="muted small">云端 Agent 不能直接写入这台电脑时使用。导入内容一样会被校验，不能越权推进任务。</p>
    </Section>

    <Section title={<><TriangleAlert size={18} />没能读取的回执 {data.file_errors.length > 0 && <span className="count">{data.file_errors.length}</span>}</>} label="没能读取的回执">
      {data.file_errors.length ? <ul className="error-list">{(data.file_errors as R[]).map(e => <li key={e.path}><b>{e.error}</b><code>{e.path}</code><small>{relative(e.observed_at, s.tz)}发现</small></li>)}</ul>
        : <p className="muted small">没有问题。写到一半的回执会在下次检查时重试。</p>}
    </Section>
    </div>
  </div>;
}
