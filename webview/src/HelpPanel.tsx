import type { FormField, FormSchema } from '../../src/shared/formSchema';

interface Props {
  schema: FormSchema;
  focusedKey: string | null;
}

export function HelpPanel({ schema, focusedKey }: Props) {
  if (!focusedKey) {
    return (
      <aside className="help-panel">
        <p className="empty">Click a field to see help and examples here.</p>
      </aside>
    );
  }

  const all: FormField[] = [...schema.common, ...schema.typeSpecific, ...schema.advanced];
  const field = all.find(f => f.key === focusedKey);
  if (!field) {
    return (
      <aside className="help-panel">
        <p className="empty">(unknown field)</p>
      </aside>
    );
  }

  return (
    <aside className="help-panel">
      <h4>{field.label}</h4>
      {field.help ? <p>{field.help}</p> : <p className="empty">No description.</p>}
      {field.examples && field.examples.length > 0 && (
        <>
          <p style={{ marginBottom: 4, color: 'var(--vscode-descriptionForeground)' }}>Examples:</p>
          <ul className="examples">
            {field.examples.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </>
      )}
    </aside>
  );
}
