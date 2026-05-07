import type { ReactNode } from 'react';
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
            {st.help ? renderHelp(st.help) : <p className="empty">No description.</p>}
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
      {field.help ? renderHelp(field.help) : <p className="empty">No description.</p>}
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

// Tiny markdown subset for help strings:
//   - blank line → paragraph break
//   - lines starting with `- ` form a contiguous bullet list
//   - `**bold**` → <strong>
//   - `` `code` `` → <code> (styled via help-panel CSS)
// Anything else renders as plain text. Deliberately not a full parser —
// help strings are author-controlled, no need to handle nested or
// adversarial markdown.
function renderHelp(text: string): ReactNode {
  const blocks = splitBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'list') {
          return (
            <ul key={i} className="help-list">
              {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
            </ul>
          );
        }
        return <p key={i}>{renderInline(b.text)}</p>;
      })}
    </>
  );
}

type Block = { kind: 'p'; text: string } | { kind: 'list'; items: string[] };

function splitBlocks(text: string): Block[] {
  const paragraphs = text.split(/\n\s*\n/);
  const out: Block[] = [];
  for (const para of paragraphs) {
    const lines = para.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) continue;
    if (lines.every(l => l.startsWith('- '))) {
      out.push({ kind: 'list', items: lines.map(l => l.slice(2)) });
    } else {
      // Re-join with spaces so single \n inside a paragraph is treated as
      // a soft wrap, not a forced break.
      out.push({ kind: 'p', text: lines.join(' ') });
    }
  }
  return out;
}

// Inline tokens: `code` and **bold**. Non-overlapping, simple scan.
function renderInline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      tokens.push(<code key={key++} className="help-code">{m[1]}</code>);
    } else if (m[2] !== undefined) {
      tokens.push(<strong key={key++}>{m[2]}</strong>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}
