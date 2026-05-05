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
  // Renders an action button alongside the input. The id is passed back
  // to the App via the `onFieldAction` prop so App can map it to a postMessage.
  // `inline: true` places the button on the same row as the input (the JDK
  // download button works this way so it lives next to the dropdown rather
  // than hanging below); the input shrinks to make room. Without `inline`
  // the button renders on its own line under the field.
  // `title` is the button's hover tooltip.
  action?: {
    id: string;
    label: string;
    busyLabel?: string;
    inline?: boolean;
    title?: string;
  };
  // Adds a small "Inspect" eye-icon button next to the field. When clicked,
  // the webview opens a dialog that splits the current value by whitespace
  // (honouring simple quoting) and displays each token on its own row.
  // Useful for long VM options / program args.
  inspectable?: boolean;
  // Informational warning banner under the field. Distinct from
  // `fieldErrors` (red, save-blocking) — this is yellow, non-blocking, and
  // carries advisory text like "DevTools not found in build.gradle". The
  // adapter sets it during getFormSchema based on context probes.
  warning?: string;
  // Gates when the warning renders. Two forms:
  //   - Single condition (same shape as `dependsOn` plus boolean support):
  //         { key: 'foo', equals: true }
  //   - AND-of-many — every entry must match before the warning shows:
  //         { all: [{ key: 'foo', equals: true }, { key: 'bar', equals: 'war' }] }
  // Used by Tomcat's reloadable-vs-war cross-field check where neither
  // condition alone is problematic — only the combination of
  // reloadable=true AND artifactKind='war' is worth flagging.
  warningDependsOn?:
    | { key: string; equals: string | string[] | boolean }
    | { all: Array<{ key: string; equals: string | string[] | boolean }> };
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
    } & BaseFieldMeta)
  | ({
      // Read-only informational panel — renders whatever the `content`
      // payload contains. Used by the Docker form to show image / ports /
      // volumes / env of the selected container so the user can verify
      // before saving. `key` is nominal (not read from values) but kept for
      // consistency with the other field kinds.
      kind: 'info';
      key: string;
      label: string;
      // Freeform content the webview renders. Kept as an array of labelled
      // sections rather than free text so the layout can be styled, and so
      // long lists of ports/volumes stay readable.
      content: InfoContent;
    } & BaseFieldMeta)
  | ({
      // Purpose-built dependency picker: an ordered list of {ref, delaySeconds}
      // entries backed by a pool of candidate refs (other run configs, launch
      // configs, native tasks). The user adds entries from a dropdown and
      // sets a per-entry delay. Not generic — this shape is exactly what the
      // DependencyOrchestrator consumes.
      kind: 'dependencyList';
      key: string;
      label: string;
      // Candidates the user can pick from. `value` is the stable ref
      // ("rcm:<id>", "launch:<name>", "task:<source>::<name>"), `label` is
      // human-readable. `group` collects them visually (e.g. "This folder",
      // "Launch configs", "Tasks").
      options: Array<{ value: string; label: string; group?: string; description?: string }>;
    } & BaseFieldMeta)
  | ({
      // List of .env file paths feeding into the env merge at run time.
      // Stores `string[]` on the config (`envFiles`); the per-file parsed
      // variables come from the extension's `envFilesLoaded` reply, not
      // from the saved config. Renders as a stack of file pills with
      // count + missing-file warning + eye-icon preview.
      kind: 'envFileList';
      key: string;
      label: string;
    } & BaseFieldMeta);

export type InfoContent = {
  // When set, rendered as the first line in a distinct style (e.g. a
  // pale banner). Useful for "Container running" / "Pick a container
  // to see details" states.
  banner?: { kind: 'muted' | 'running' | 'stopped' | 'warning'; text: string };
  // Key/value pairs rendered as a two-column list (image: nginx, state:
  // running, …). Values wrap; no interpretation of the strings.
  rows?: Array<{ label: string; value: string }>;
  // Optional list of arbitrary strings rendered as a bullet list. Used
  // for ports and volumes where each entry already has internal structure.
  lists?: Array<{ label: string; items: string[] }>;
};

export interface FormSchema {
  common: FormField[];
  typeSpecific: FormField[];
  advanced: FormField[];
}
