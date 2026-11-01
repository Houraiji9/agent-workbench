// 本地后台 fetch 封装：同源 cookie 会话 + CSRF；只重试在业务处理前被拒绝的 401。
export function createPageApi(fetcher: typeof fetch, bootstrapTimeoutMs = 10000) {
  let csrf = '', generation = 0;
  let renewing: Promise<any> | null = null;
  const setCsrf = (value: string) => { csrf = value; generation++; };
  const bootstrap = () => {
    if (renewing) return renewing;
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('连接后台超时，正在重试')); controller.abort(); }, bootstrapTimeoutMs);
    });
    const read = async () => {
      const res = await fetcher('/api/bootstrap', {signal: controller.signal});
      const value = await res.json();
      if (!res.ok) throw new Error(value.error || '连接后台失败');
      return value;
    };
    renewing = Promise.race([read(), timeout]).then(value => { setCsrf(value.csrf); return value; }).finally(() => {
      clearTimeout(timer); renewing = null;
    });
    return renewing;
  };
  const api = async (url: string, body?: unknown, signal?: AbortSignal): Promise<any> => {
    signal?.throwIfAborted();
    if (url === '/bootstrap') return bootstrap();
    const send = () => fetcher('/api' + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : {'content-type': 'application/json', 'x-workbench-csrf': csrf},
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
    const startedAt = generation;
    let res = await send();
    if (res.status === 401) {
      // 并发失败共享续期；迟到的旧会话 401 不再创建下一份 cookie。
      if (startedAt === generation) await bootstrap();
      signal?.throwIfAborted();
      res = await send();
    }
    const value = await res.json();
    if (!res.ok) throw new Error(value.error || '请求失败');
    return value;
  };
  return {api, setCsrf};
}

export const {api, setCsrf} = createPageApi((...args) => fetch(...args));
