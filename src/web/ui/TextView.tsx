// 安全文本呈现：Markdown 只解析标题、列表、引用和代码块，全部生成 React 文本节点，不注入 HTML。
import React from 'react';

export function MarkdownText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(<pre key={key++} className="md-code">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const T = (`h${Math.min(h[1].length + 2, 6)}`) as 'h3'; out.push(<T key={key++} className="md-h">{inline(h[2])}</T>); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+[.)]/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      out.push(<L key={key++} className="md-list">{items.map((t, n) => <li key={n}>{inline(t.replace(/^\[ \]\s*/, '☐ ').replace(/^\[[xX]\]\s*/, '☑ '))}</li>)}</L>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(<blockquote key={key++}>{q.join('\n')}</blockquote>);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { const cells = lines[i++].trim().slice(1, -1).split('|').map(c => c.trim()); if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells); }
      out.push(<div key={key++} className="md-table-wrap"><table className="md-table"><tbody>{rows.map((r, n) => <tr key={n}>{r.map((c, m) => n === 0 ? <th key={m}>{inline(c)}</th> : <td key={m}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    // 未被上述块识别的首行必须消费（例如没有行末竖线的表格或单独的 |）。
    // 后续行仍按块边界停止，避免无法前进的空段落循环。
    para.push(lines[i++]);
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={key++}>{inline(para.join('\n'))}</p>);
  }
  return <div className="md">{out}</div>;
}

function inline(s: string): React.ReactNode[] {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code>
    : p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p);
}
