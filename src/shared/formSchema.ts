// Declarative form description shared between extension and webview.

export type FormField =
  | { kind: 'text'; key: string; label: string; placeholder?: string; required?: boolean }
  | { kind: 'number'; key: string; label: string; min?: number; max?: number }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    }
  | { kind: 'kv'; key: string; label: string }
  | { kind: 'folderPath'; key: string; label: string; relativeTo?: 'workspaceFolder' };

export interface FormSchema {
  common: FormField[];
  typeSpecific: FormField[];
  advanced: FormField[];
}
