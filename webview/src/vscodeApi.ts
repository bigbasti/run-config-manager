// `acquireVsCodeApi()` may only be called once per webview, so every view
// shares this lazily-acquired, cached instance.
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T;
  setState<T>(s: T): void;
}

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage: () => {}, getState: <T,>() => undefined as T, setState: () => {} };
  }
  return api;
}
