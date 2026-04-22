// POSIX-ish shell-word splitter — supports double and single quotes and backslash escapes.
// Good enough for programArgs/vmArgs user input; not a full shell parser.
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let quote: '"' | "'" | null = null;

  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
    } else if (/\s/.test(c)) {
      if (cur.length) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
    i++;
  }
  if (cur.length) out.push(cur);
  return out;
}
