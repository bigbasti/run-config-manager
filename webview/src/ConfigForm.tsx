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
}

export function ConfigForm({ schema, values, onChange, onPickFolder, onFocusField }: Props) {
  const preview = useMemo(() => {
    try { return buildCommandPreview(values as RunConfig); } catch { return ''; }
  }, [values]);

  const change = (next: Record<string, unknown>) => onChange(next as Partial<RunConfig>);

  return (
    <div className="form">
      <section>
        {schema.common.map(f => (
          <Field
            key={f.key}
            field={f}
            values={values as any}
            onChange={change}
            onPickFolder={onPickFolder}
            onFocusField={onFocusField}
          />
        ))}
      </section>
      <section>
        <h3>Run configuration</h3>
        {schema.typeSpecific.map(f => (
          <Field key={f.key} field={f} values={values as any} onChange={change} onFocusField={onFocusField} />
        ))}
      </section>
      <section>
        <h3>Advanced</h3>
        {schema.advanced.map(f => (
          <Field key={f.key} field={f} values={values as any} onChange={change} onFocusField={onFocusField} />
        ))}
      </section>
      <div className="preview">{preview}</div>
    </div>
  );
}
