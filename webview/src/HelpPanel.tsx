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

  // Side-toggle keys (the checkbox rendered next to an action button —
  // see BaseFieldMeta.action.sideToggle) aren't first-class fields, so
  // they won't match `f.key`. Walk every field's `action.sideToggle` and
  // render its help when focused. Otherwise the toggle's own help text
  // would never reach the side panel.
  if (!field) {
    for (const f of all) {
      const st = (f as { action?: { sideToggle?: { key: string; label: string; help?: string } } }).action?.sideToggle;
      if (st && st.key === focusedKey) {
        return (
          <aside className="help-panel">
            <h4>{st.label}</h4>
            {st.help ? <p>{st.help}</p> : <p className="empty">No description.</p>}
          </aside>
        );
      }
    }
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
