// 最多一个在途读取和一个合并的后续读取。每个调用绑定固定批次，不追逐未来请求。
// 在途期间的新通知必须等下一次读取，避免用通知前启动的快照冒充最新数据。
export function snapshotRefresh<T>(read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, failed: () => void, timeoutMs = 10000) {
  type Batch = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  let active: Batch | null = null, queued: Batch | null = null;
  const batch = (): Batch => {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const start = (current: Batch) => {
    active = current;
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('读取最新记录超时，正在重试')); controller.abort(); }, timeoutMs);
    });
    void (async () => {
      try {
        const value = await Promise.race([Promise.resolve().then(() => read(controller.signal)), timeout]);
        apply(value); current.resolve();
      } catch (error) {
        failed(); current.reject(error);
      } finally {
        clearTimeout(timer); active = null;
        const next = queued; queued = null;
        if (next) start(next);
      }
    })();
  };
  return () => {
    if (active) { queued ??= batch(); return queued.promise; }
    const current = batch(); start(current); return current.promise;
  };
}
