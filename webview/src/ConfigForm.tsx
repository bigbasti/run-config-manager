import { useMemo } from 'react';
import type { FormSchema } from '../../src/shared/formSchema';
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

  return (
    <div className="form">
      <section>
        {schema.common.map(f => (
          <Field key={f.key} field={f} {...shared} onPickFolder={onPickFolder} />
        ))}
      </section>
      <section>
        <h3>Run configuration</h3>
        {schema.typeSpecific.map(f => (
          <Field key={f.key} field={f} {...shared} />
        ))}
      </section>
      <section>
        <h3>Advanced</h3>
        {schema.advanced.map(f => (
          <Field key={f.key} field={f} {...shared} />
        ))}
      </section>
      <div className="preview">{preview}</div>
    </div>
  );
}
