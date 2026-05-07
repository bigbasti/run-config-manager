import { useMemo, type ReactElement } from 'react';
import type { FormSchema, FormField } from '../../src/shared/formSchema';
import type { RunConfig } from '../../src/shared/types';
import { buildCommandPreview } from '../../src/shared/buildCommandPreview';
import { Field } from './form/Field';
import type { EnvFileStatus } from './form/EnvFileList';

interface Props {
  schema: FormSchema;
  values: Partial<RunConfig>;
  onChange: (next: Partial<RunConfig>) => void;
  onPickFolder: () => void;
  onFocusField: (key: string | null) => void;
  onFieldAction: (actionId: string) => void;
  busyActionId: string | null;
  pending?: Set<string>;
  pathWarnings?: Map<string, { reason: string; suggestion?: string } | null>;
  onValidatePath?: (fieldKey: string, buildTool: 'maven' | 'gradle' | 'either', path: string) => void;
  fieldErrors?: Map<string, string>;
  workspaceFolderPath?: string;
  envFileStatus?: Map<string, EnvFileStatus>;
  onAddEnvFile?: () => void;
}

export function ConfigForm({ schema, values, onChange, onPickFolder, onFocusField, onFieldAction, busyActionId, pending, pathWarnings, onValidatePath, fieldErrors, workspaceFolderPath, envFileStatus, onAddEnvFile }: Props) {
  const preview = useMemo(() => {
    try { return buildCommandPreview(values as RunConfig, workspaceFolderPath); } catch { return ''; }
  }, [values, workspaceFolderPath]);

  const change = (next: Record<string, unknown>) => onChange(next as Partial<RunConfig>);
  const shared = {
    values: values as any, onChange: change, onFocusField, onFieldAction,
    busyActionId, pending, pathWarnings, onValidatePath, fieldErrors,
    envFileStatus, onAddEnvFile,
  };

  // Render a section's fields, grouping any `inlineWith` pairs into a
  // single flex row. The "anchor" field (the one whose partner declared
  // `next` or `previous`) takes flex:1; the partner sits at its natural
  // width on the side it asked for. Doing the grouping at this layer
  // keeps Field.tsx focused on a single field's lifecycle.
  const renderFields = (fields: FormField[], extraProps?: Record<string, unknown>) => {
    const out: ReactElement[] = [];
    for (let i = 0; i < fields.length; i++) {
      const cur = fields[i];
      const next = fields[i + 1];
      // Pair: cur has inlineWith:'next' (cur is the small one, partner expands).
      if (cur.inlineWith === 'next' && next) {
        out.push(
          <div
            key={cur.key + '+' + next.key}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 0 }}
          >
            <div style={{ flexShrink: 0 }}>
              <Field field={cur} {...shared} {...(extraProps ?? {})} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field field={next} {...shared} {...(extraProps ?? {})} />
            </div>
          </div>,
        );
        i++; // consumed both
        continue;
      }
      // Pair: cur has inlineWith:'previous' (out's last entry expands; we sit on the right).
      if (cur.inlineWith === 'previous' && i > 0) {
        const prev = fields[i - 1];
        // Replace the last out entry with a flex pairing.
        out.pop();
        out.push(
          <div
            key={prev.key + '+' + cur.key}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 0 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field field={prev} {...shared} {...(extraProps ?? {})} />
            </div>
            <div style={{ flexShrink: 0 }}>
              <Field field={cur} {...shared} {...(extraProps ?? {})} />
            </div>
          </div>,
        );
        continue;
      }
      out.push(<Field key={cur.key} field={cur} {...shared} {...(extraProps ?? {})} />);
    }
    return out;
  };

  return (
    <div className="form">
      <section>
        {renderFields(schema.common, { onPickFolder })}
      </section>
      <section>
        <h3>Run configuration</h3>
        {renderFields(schema.typeSpecific)}
      </section>
      <section>
        <h3>Advanced</h3>
        {renderFields(schema.advanced)}
      </section>
      <div className="preview">{preview}</div>
    </div>
  );
}
