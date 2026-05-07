import { useEffect, useRef, type CSSProperties } from 'react';
import { tokenize, type CodeLang, type Token } from './CodeHighlight';

interface Props {
  value: string;
  onChange: (next: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  rows?: number;
  placeholder?: string;
  language: CodeLang;
}

// Syntax-highlighted multiline editor. Uses the classic two-layer
// trick: a transparent <textarea> handles input; a positioned <pre>
// behind it renders the highlighted tokens. Both use the same font
// metrics so the cursor and selection align with the colored text.
//
// Why not Monaco / CodeMirror: the JSON / JS payloads here are
// short (typical request body, a few-line assert script). Bringing in
// a full editor would add hundreds of KB to the webview bundle for a
// minor visual lift.
export function CodeTextarea({ value, onChange, onFocus, onBlur, rows = 6, placeholder, language }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Keep the highlight layer scrolled in lock-step with the textarea.
  // Long content needs this — without it the highlighting drifts off
  // screen as the user scrolls.
  useEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    const onScroll = () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener('scroll', onScroll);
    return () => ta.removeEventListener('scroll', onScroll);
  }, []);

  const tokens = tokenize(value, language);

  return (
    <div style={wrapStyle}>
      <pre ref={preRef} aria-hidden="true" style={preStyle}>
        {tokens.map((t, i) => (
          <span key={i} className={`rcm-tok-${t.kind}`}>{t.text}</span>
        ))}
        {/* Trailing zero-width newline so the highlighted layer
            doesn't collapse one row shorter than the textarea when
            the last char is a newline. */}
        <span>{value.endsWith('\n') ? '​' : ''}</span>
      </pre>
      <textarea
        ref={taRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        // The textarea text is transparent so users see the
        // highlighted <pre> behind it. Caret stays the editor's
        // foreground via `caret-color`.
        style={taStyle}
      />
      {/* Token color rules. We piggyback on VS Code's editor token
          colors so the highlighting follows the active theme. */}
      <style>{tokenStyles}</style>
    </div>
  );
}

const FONT = 'var(--vscode-editor-font-family, monospace)';
const FONT_SIZE = 'var(--vscode-editor-font-size, 13px)';
const LINE_HEIGHT = '1.4em';
const PADDING = '6px 8px';

const wrapStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
};

const sharedTextStyle: CSSProperties = {
  fontFamily: FONT,
  fontSize: FONT_SIZE,
  lineHeight: LINE_HEIGHT,
  padding: PADDING,
  margin: 0,
  whiteSpace: 'pre',
  wordWrap: 'normal',
  overflow: 'auto',
  tabSize: 2,
  border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)))',
  borderRadius: 2,
  boxSizing: 'border-box',
};

const preStyle: CSSProperties = {
  ...sharedTextStyle,
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  background: 'var(--vscode-input-background, transparent)',
  color: 'var(--vscode-editor-foreground, currentColor)',
};

const taStyle: CSSProperties = {
  ...sharedTextStyle,
  position: 'relative',
  width: '100%',
  // Transparent text so the colored <pre> shows through. Caret +
  // selection still render via caret-color / ::selection on the
  // textarea itself — they're owned by the input layer.
  color: 'transparent',
  caretColor: 'var(--vscode-editor-foreground, currentColor)',
  background: 'transparent',
  resize: 'vertical',
};

// Token classes attach to <span>s emitted in the highlighted layer.
// We piggyback on the same vscode CSS variables the editor exposes,
// with sensible fallbacks. Keeping these inline (instead of a
// dedicated stylesheet) so the component is self-contained.
const tokenStyles = `
.rcm-tok-string   { color: var(--vscode-debugTokenExpression-string,  var(--vscode-editor-foreground)); }
.rcm-tok-number   { color: var(--vscode-debugTokenExpression-number,  #b5cea8); }
.rcm-tok-boolean  { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.rcm-tok-null     { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.rcm-tok-keyword  { color: var(--vscode-debugView-valueChangedHighlight, #c586c0); }
.rcm-tok-comment  { color: var(--vscode-editorLineNumber-foreground,  #6a9955); font-style: italic; }
.rcm-tok-property { color: var(--vscode-debugTokenExpression-name,    #9cdcfe); }
.rcm-tok-punctuation { color: var(--vscode-editor-foreground); opacity: 0.85; }
.rcm-tok-regex    { color: #d16969; }
.rcm-tok-plain    { color: var(--vscode-editor-foreground, currentColor); }
`;
