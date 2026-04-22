import { useMemo } from 'react';
import type { FormSchema } from '../../src/shared/formSchema';
import type { RunConfig } from '../../src/shared/types';
import { buildCommandPreview } from '../../src/shared/buildCommandPreview';
import { Field } from './form/Field';

interface Props {
  schema: FormSchema;
  values: Partial<RunConfig>;
  onChange: (next: Partial<RunConfig>) => void;
  onPickFolder: () => void;
  onFocusField: (key: string | null) => void;
  onFieldAction: (actionId: string) => void;
  busyActionId: string | null;
}

export function ConfigForm({ schema, values, onChange, onPickFolder, onFocusField, onFieldAction, busyActionId }: Props) {
  const preview = useMemo(() => {
    try { return buildCommandPreview(values as RunConfig); } catch { return ''; }
  }, [values]);

  const change = (next: Record<string, unknown>) => onChange(next as Partial<RunConfig>);
  const shared = { values: values as any, onChange: change, onFocusField, onFieldAction, busyActionId };

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
