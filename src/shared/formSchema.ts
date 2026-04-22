// Declarative form description shared between extension and webview.

type BaseFieldMeta = { help?: string; examples?: string[] };

export type FormField =
  | ({ kind: 'text'; key: string; label: string; placeholder?: string; required?: boolean } & BaseFieldMeta)
  | ({ kind: 'number'; key: string; label: string; min?: number; max?: number } & BaseFieldMeta)
  | ({
      kind: 'select';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    } & BaseFieldMeta)
  | ({ kind: 'kv'; key: string; label: string } & BaseFieldMeta)
  | ({ kind: 'folderPath'; key: string; label: string; relativeTo?: 'workspaceFolder' } & BaseFieldMeta);

export interface FormSchema {
  common: FormField[];
  typeSpecific: FormField[];
  advanced: FormField[];
}
