// 表单提交：错误显示在表单里，成功后刷新账本并给出明确提示。
import { useState } from 'react';
import { useStore } from '../../app/store.js';

export function useSubmit() {
  const s = useStore();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function run<T>(fn: () => Promise<T>, ok?: string, close = true): Promise<T | null> {
    setError(''); setSaving(true);
    try {
      const r = await fn();
      try { await s.refresh(); if (ok) s.toast(ok); }
      catch { s.toast('操作已保存，但页面暂未更新，正在重试同步。请不要重复提交。', 'error'); }
      if (close) s.closeDialog();
      return r;
    } catch (e) {
      setError((e as Error).message || '没有保存成功');
      return null;
    } finally { setSaving(false); }
  }
  return { error, setError, saving, run };
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error('粘贴的内容不是完整的 JSON，请确认从 { 开始、以 } 结束，并且没有多余文字'); }
}
