import type { RunConfig } from '../shared/types';
import { readyPatternsFor, failurePatternsFor } from './readyPatterns';

// Transforms child-process output before it hits the terminal. Non-destructive
// by design — already-colored lines (Spring Boot with colorOutput, Angular,
// webpack) pass through body-untouched; only plain monochrome output gets the
// timestamp/level coloring. Hyperlinks + ready/fail markers are always applied.
//
// Line-buffered: if a chunk cuts mid-line, the tail is held until the next
// chunk arrives, so patterns aren't missed on chunk boundaries. Callers must
// invoke flush() when the stream closes to emit any trailing partial line.

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD_GREEN = `${ESC}[1;92m`;
const BOLD_RED = `${ESC}[1;91m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[91m`;
const YELLOW = `${ESC}[93m`;
const BLUE = `${ESC}[94m`;
const GRAY = `${ESC}[90m`;

// VT100 SGR escape. Presence signals the line is already styled by the app.
const HAS_ANSI = /\x1b\[[0-9;]*m/;

// YYYY-MM-DD[ T]HH:MM:SS(.mmm | ,mmm) — Logback, Spring Boot, SLF4J default.
const TS_ISO = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)/;
// HH:MM:SS(.mmm) at line start — Angular CLI, Webpack dev server.
const TS_HMS = /^(\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)/;

const LEVEL_TOKEN = /\b(FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;

// URLs. Stops before common trailing punctuation that's rarely part of the URL.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

// Path with optional :line[:col]. Allows absolute Unix/Windows or obvious
// relative forms with an extension. Deliberately conservative — we'd rather
// miss a link than turn ordinary prose into one.
const PATH_RE = /(?:(?:[A-Za-z]:[\\/])|(?:\.{1,2}[\\/])|(?:\/))[\w.\-/\\]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?/g;

const OSC = '\x1b]';
const BEL = '\x07';

function link(uri: string, label: string): string {
  // OSC 8 ; params ; URI BEL <label> OSC 8 ; ; BEL — VS Code renders these as
  // ctrl+clickable links in the integrated terminal.
  return `${OSC}8;;${uri}${BEL}${label}${OSC}8;;${BEL}`;
}

export interface Prettifier {
  process(chunk: string): string;
  flush(): string;
}

export interface PrettifierContext {
  cwd: string;
}

export function makePrettifier(cfg: RunConfig, ctx: PrettifierContext): Prettifier {
  const ready = readyPatternsFor(cfg);
  const fail = failurePatternsFor(cfg);
  let carry = '';

  const hyperlinkLine = (line: string): string => {
    // Run URL + path regexes in a single left-to-right pass, picking whichever
    // match starts earliest. Two-pass would double-wrap: PATH_RE matches the
    // path portion of an URL we just wrapped (e.g. `//example.com/foo`).
    URL_RE.lastIndex = 0;
    PATH_RE.lastIndex = 0;
    let out = '';
    let cursor = 0;
    while (cursor < line.length) {
      URL_RE.lastIndex = cursor;
      PATH_RE.lastIndex = cursor;
      const urlMatch = URL_RE.exec(line);
      const pathMatch = PATH_RE.exec(line);
      // Both regexes use `g`; exec advances past the match from lastIndex, but
      // may match at or after it. Pick the earliest non-null.
      const pick =
        !urlMatch ? pathMatch :
        !pathMatch ? urlMatch :
        urlMatch.index <= pathMatch.index ? urlMatch : pathMatch;
      if (!pick) {
        out += line.slice(cursor);
        break;
      }
      out += line.slice(cursor, pick.index);
      if (pick === urlMatch) {
        out += link(pick[0], pick[0]);
      } else {
        const uri = fileUriFor(pick[0], ctx.cwd);
        out += uri ? link(uri, pick[0]) : pick[0];
      }
      cursor = pick.index + pick[0].length;
    }
    return out;
  };

  const processLine = (line: string): string => {
    // Markers win over styling — if failure fires, we skip ready/level work
    // entirely so the red banner is the dominant visual.
    if (fail.some(p => p.test(line))) {
      return `${BOLD_RED}✗${RESET} ${hyperlinkLine(line)}`;
    }
    if (ready.some(p => p.test(line))) {
      return `${BOLD_GREEN}✓${RESET} ${hyperlinkLine(line)}`;
    }
    if (HAS_ANSI.test(line)) {
      // App styled the body itself — we still add hyperlinks (OSC 8 composes
      // cleanly with inline SGR) but leave coloring alone.
      return hyperlinkLine(line);
    }

    let out = line;
    const ts = TS_ISO.exec(out) ?? TS_HMS.exec(out);
    if (ts) {
      out = `${DIM}${ts[1]}${RESET}${out.slice(ts[1].length)}`;
    }
    const lvl = LEVEL_TOKEN.exec(out);
    if (lvl) {
      const color = levelColor(lvl[1]);
      if (color) {
        out =
          out.slice(0, lvl.index) +
          color + lvl[1] + RESET +
          out.slice(lvl.index + lvl[1].length);
      }
    }
    return hyperlinkLine(out);
  };

  return {
    process(chunk: string): string {
      const text = carry + chunk;
      // Keep separators at odd indices by using a capture group.
      const parts = text.split(/(\r?\n)/);
      const last = parts.length - 1;
      let out = '';
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          out += parts[i];
          continue;
        }
        if (i === last) {
          carry = parts[i];
        } else {
          out += processLine(parts[i]);
        }
      }
      return out;
    },
    flush(): string {
      if (!carry) return '';
      const tail = processLine(carry);
      carry = '';
      return tail;
    },
  };
}

function levelColor(level: string): string {
  switch (level) {
    case 'FATAL':
    case 'ERROR': return RED;
    case 'WARN':
    case 'WARNING': return YELLOW;
    case 'INFO': return BLUE;
    case 'DEBUG':
    case 'TRACE': return GRAY;
    default: return '';
  }
}

// Builds a file:// URI for a matched path. Strips the optional :line[:col]
// suffix from the file portion (VS Code carries line/col via the #L<N> hash).
// Returns null for paths we can't confidently anchor (relative with no cwd).
function fileUriFor(match: string, cwd: string): string | null {
  const locMatch = /:(\d+)(?::(\d+))?$/.exec(match);
  const loc = locMatch
    ? { path: match.slice(0, locMatch.index), hash: `#L${locMatch[1]}${locMatch[2] ? `:${locMatch[2]}` : ''}` }
    : { path: match, hash: '' };
  const absolute = isAbsolute(loc.path)
    ? loc.path
    : cwd
    ? joinPath(cwd, loc.path)
    : null;
  if (!absolute) return null;
  return `file://${toFileUriPath(absolute)}${loc.hash}`;
}

function isAbsolute(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(p);
}

function joinPath(a: string, b: string): string {
  const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/';
  const trimmedA = a.replace(/[\\/]+$/, '');
  const trimmedB = b.replace(/^(\.\/|\.\\)+/, '');
  return `${trimmedA}${sep}${trimmedB}`;
}

function toFileUriPath(absolute: string): string {
  // Windows drive letter paths need a leading slash and forward slashes in
  // the URI; Unix paths are already in good shape.
  if (/^[A-Za-z]:/.test(absolute)) {
    return '/' + absolute.replace(/\\/g, '/');
  }
  return absolute;
}
