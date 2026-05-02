export class BridgeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTimeoutError';
  }
}

export class BridgeAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeAbortError';
  }
}

export function isBridgeAbortError(err: unknown): err is BridgeAbortError {
  return err instanceof BridgeAbortError;
}

export function isBridgeTimeoutError(err: unknown): err is BridgeTimeoutError {
  return err instanceof BridgeTimeoutError;
}

export function throwIfAborted(signal: AbortSignal | undefined, label = 'bridge'): void {
  if (signal?.aborted) throw new BridgeAbortError(`${label} aborted`);
}

export function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfAborted(parentSignal, label);

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BridgeTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abort = new Promise<never>((_, reject) => {
    if (!parentSignal) return;
    abortListener = () => {
      controller.abort();
      reject(new BridgeAbortError(`${label} aborted`));
    };
    parentSignal.addEventListener('abort', abortListener, { once: true });
  });

  return Promise.race([
    operation(controller.signal),
    timeout,
    abort,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (parentSignal && abortListener) parentSignal.removeEventListener('abort', abortListener);
  });
}
