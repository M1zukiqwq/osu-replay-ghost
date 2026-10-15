/// <reference lib="webworker" />
import { engineOps } from '../core/engineOps';

interface Request { id: number; op: keyof typeof engineOps; args: unknown[] }

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<Request>) => {
  const { id, op, args } = e.data;
  try {
    let result: unknown;
    if (op === 'hashFiles') {
      result = await engineOps.hashFiles(args[0] as { path: string; file: Blob }[], (done, total) =>
        scope.postMessage({ id, progress: { done, total } }),
      );
    } else {
      result = (engineOps[op] as (...a: unknown[]) => unknown)(...args);
    }
    scope.postMessage({ id, ok: true, result });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
