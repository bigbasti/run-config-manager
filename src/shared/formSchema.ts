// Declarative form description shared between extension and webview.

type BaseFieldMeta = {
  help?: string;
  examples?: string[];
  // Purely cosmetic: shows a red asterisk next to the label and a
  // "Required" tooltip. Actual enforcement is Zod-schema level; this is
  // just to warn the user before they click Save. Any field kind can opt
  // in — not just text/textarea.
  required?: boolean;
  // When set, the webview hides this field unless the value at `key` in the
  // current form state equals `equals` (or is contained in `equals` when an array).
  dependsOn?: { key: string; equals: string | string[] };
  // Renders an inline action button beside the input. The id is passed back
  // to the App via the `onFieldAction` prop so App can map it to a postMessage.
  action?: { id: string; label: string; busyLabel?: string };
  // Adds a small "Inspect" eye-icon button next to the field. When clicked,
  // the webview opens a dialog that splits the current value by whitespace
  // (honouring simple quoting) and displays each token on its own row.
  // Useful for long VM options / program args.
  inspectable?: boolean;
};

export type FormField =
  | ({ kind: 'text'; key: string; label: string; placeholder?: string } & BaseFieldMeta)
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
      // Options may include an optional `group` (for collapsible grouping in
      // the dropdown) and `description` (rendered alongside the label in a
      // dimmer color). When `group` is absent on every option, the widget
      // renders a flat filterable list instead of grouped sections.
      options: Array<{ value: string; label: string; group?: string; description?: string }>;
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
  | ({
      kind: 'folderPath';
      key: string;
      label: string;
      relativeTo?: 'workspaceFolder';
      // When set, the webview posts a `validateProjectPath` on blur with
      // this build tool. The extension responds with a warning + optional
      // parent-folder suggestion the user can apply with one click.
      validateBuildPath?: 'maven' | 'gradle' | 'either';
    } & BaseFieldMeta);

export interface FormSchema {
  common: FormField[];
  typeSpecific: FormField[];
  advanced: FormField[];
}
