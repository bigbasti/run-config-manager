// Helpers for reading / writing nested keys like "typeOptions.scriptName".
export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function setPath<T>(obj: T, path: string, value: any): T {
  const out: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  const parts = path.split('.');
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    cursor[k] = { ...(cursor[k] ?? {}) };
    cursor = cursor[k];
  }
  cursor[parts[parts.length - 1]] = value;
  return out as T;
}
