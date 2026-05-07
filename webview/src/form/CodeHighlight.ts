// Minimal regex-based syntax highlighter for JSON and JavaScript.
// We don't need a full parser — these textareas are short, and a real
// parser (Prism, Shiki, Monaco) would add at least 10-200 KB to the
// webview bundle. The output is a stream of {text, kind} chunks the
// caller renders to <span> with VS Code's editor-token colors.
//
// Tokenizing fields:
//   - kind: which CSS class to attach. We piggyback on VS Code's
//     own token colors so themes Just Work (light/dark/HC).
//   - text: the verbatim source span.

export type TokenKind =
  | 'plain'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'keyword'
  | 'comment'
  | 'punctuation'
  | 'property'
  | 'regex';

export interface Token { kind: TokenKind; text: string; }

export type CodeLang = 'json' | 'javascript';

export function tokenize(source: string, lang: CodeLang): Token[] {
  return lang === 'json' ? tokenizeJson(source) : tokenizeJs(source);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

// Order matters: strings first (so a string containing `null` doesn't get
// re-tokenized), then primitives, then numbers, then punctuation.
const JSON_PATTERNS: Array<[TokenKind, RegExp]> = [
  ['string', /"(?:\\.|[^"\\])*"/y],
  ['boolean', /\btrue\b|\bfalse\b/y],
  ['null', /\bnull\b/y],
  ['number', /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
  ['punctuation', /[{}[\],:]/y],
];

function tokenizeJson(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    // Skip + emit whitespace as plain so the output preserves layout.
    const wsMatch = /\s+/y;
    wsMatch.lastIndex = i;
    const ws = wsMatch.exec(src);
    if (ws && ws.index === i) {
      out.push({ kind: 'plain', text: ws[0] });
      i += ws[0].length;
      continue;
    }

    // String tokens get post-processed: when followed by `:` the string
    // is a property key — give it the property color rather than string.
    let matched = false;
    for (const [kind, re] of JSON_PATTERNS) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i) {
        if (kind === 'string') {
          // Look ahead past whitespace for `:` to know if this is a key.
          let j = i + m[0].length;
          while (j < src.length && /\s/.test(src[j])) j++;
          out.push({ kind: src[j] === ':' ? 'property' : 'string', text: m[0] });
        } else {
          out.push({ kind, text: m[0] });
        }
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Unknown char — emit as plain so render stays lossless.
      out.push({ kind: 'plain', text: src[i] });
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

const JS_KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'default', 'try', 'catch',
  'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'void',
  'delete', 'this', 'class', 'extends', 'super', 'import', 'export',
  'from', 'async', 'await', 'yield', 'static', 'get', 'set',
]);

const JS_PRIMITIVES = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

function tokenizeJs(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      out.push({ kind: 'plain', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // Line comment
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out.push({ kind: 'comment', text: src.slice(i, stop) });
      i = stop;
      continue;
    }

    // Block comment
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out.push({ kind: 'comment', text: src.slice(i, stop) });
      i = stop;
      continue;
    }

    // Strings — single, double, template. Templates don't get
    // expression-aware tokenization; the whole literal is one string.
    if (ch === '"' || ch === '\'' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        j++;
      }
      out.push({ kind: 'string', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers
    const numMatch = /[0-9](?:[0-9.eE+\-_xXbBoOaAfA]|n)*/y;
    numMatch.lastIndex = i;
    const num = numMatch.exec(src);
    if (num && num.index === i && /^[\d.]/.test(num[0])) {
      out.push({ kind: 'number', text: num[0] });
      i += num[0].length;
      continue;
    }

    // Identifier (keyword / primitive / plain)
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let kind: TokenKind = 'plain';
      if (JS_KEYWORDS.has(word)) kind = 'keyword';
      else if (JS_PRIMITIVES.has(word)) kind = 'boolean';
      out.push({ kind, text: word });
      i = j;
      continue;
    }

    // Punctuation / operators — single-char emit. Good enough for
    // visual scanning; we don't try to match multi-char operators
    // because the color is identical anyway.
    if (/[{}()[\];,.:?!=<>+\-*/%&|^~]/.test(ch)) {
      out.push({ kind: 'punctuation', text: ch });
      i++;
      continue;
    }

    out.push({ kind: 'plain', text: ch });
    i++;
  }
  return out;
}
