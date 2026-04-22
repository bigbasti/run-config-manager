// Declarative form description shared between extension and webview.

type BaseFieldMeta = {
  help?: string;
  examples?: string[];
  // When set, the webview hides this field unless the value at `key` in the
  // current form state equals `equals` (or is contained in `equals` when an array).
  dependsOn?: { key: string; equals: string | string[] };
  // Renders an inline action button beside the input. The id is passed back
  // to the App via the `onFieldAction` prop so App can map it to a postMessage.
  action?: { id: string; label: string; busyLabel?: string };
};

export type FormField =
  | ({ kind: 'text'; key: string; label: string; placeholder?: string; required?: boolean } & BaseFieldMeta)
  | ({ kind: 'textarea'; key: string; label: string; placeholder?: string; rows?: number } & BaseFieldMeta)
  | ({ kind: 'number'; key: string; label: string; min?: number; max?: number } & BaseFieldMeta)
  | ({
      kind: 'select';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    } & BaseFieldMeta)
  | ({
      kind: 'selectOrCustom';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
    } & BaseFieldMeta)
  | ({
      kind: 'csvChecklist';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
    } & BaseFieldMeta)
  | ({ kind: 'boolean'; key: string; label: string } & BaseFieldMeta)
  | ({ kind: 'kv'; key: string; label: string } & BaseFieldMeta)
  | ({ kind: 'folderPath'; key: string; label: string; relativeTo?: 'workspaceFolder' } & BaseFieldMeta);

export interface FormSchema {
  common: FormField[];
  typeSpecific: FormField[];
  advanced: FormField[];
}
