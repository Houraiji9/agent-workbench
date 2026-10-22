// 本地后台 fetch 封装：同源 cookie 会话 + CSRF 头，错误信息直接来自后台。
let csrf = '';

export function setCsrf(value: string) { csrf = value; }

export async function api(url: string, body?: unknown, signal?: AbortSignal) {
  const res = await fetch('/api' + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-workbench-csrf': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const v = await res.json();
  if (!res.ok) throw new Error(v.error || '请求失败');
  return v;
}
