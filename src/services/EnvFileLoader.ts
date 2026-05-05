import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';

// Loads `.env` files referenced by a run config. Used in two places:
//   - At launch time (ExecutionService merges the loaded vars into the
//     child process env, sandwiched between process.env and the form's
//     env map).
//   - In the editor (EditorPanel asks for a fresh load whenever the form
//     opens or a file is added/removed, so the UI can show the variable
//     count and offer the eye-icon preview dialog).
//
// We deliberately re-load every time. Vars are NOT cached in the saved
// config — the user expects edits to the file to take effect without
// re-saving. The cost (a few KB of disk I/O) is negligible.

export interface DotEnvFileResult {
  // Workspace-relative or absolute path as the user typed it. Round-tripped
  // back to the UI so it can render the file pill exactly as saved.
  path: string;
  // Resolved absolute path the loader actually read.
  resolvedPath: string;
  // True when the file existed on disk and parsed cleanly.
  loaded: boolean;
  // Parsed key/value pairs (empty when not loaded). Order from the file is
  // preserved by Map insertion.
  variables: Record<string, string>;
  // Tagged failure mode so the UI can decide whether to render the row
  // orange ("missing") vs red ("parse error"). Absent when loaded=true.
  error?: 'missing' | 'parse-error' | 'read-error';
  errorDetail?: string;
}

export interface LoadResult {
  // Per-file status, in the same order the caller asked for them. Useful
  // for the dialog row list.
  files: DotEnvFileResult[];
  // Aggregated map: keys from earlier files are overwritten by later ones,
  // matching the documented precedence ("later files win"). The form's
  // `env` map overrides this aggregate at run time — done by the caller
  // (ExecutionService merges in order: process.env, this map, cfg.env,
  // adapter prepared.env).
  merged: Record<string, string>;
}

// Parse a `.env` file body. Subset semantics:
//   - KEY=value
//   - "value" / 'value' (quotes stripped, no escape processing besides \n
//     and \" inside double quotes — matches the common dotenv libs)
//   - leading "export " allowed (mirrors how shell scripts use these files)
//   - lines starting with # ignored
//   - inline comments after an unquoted value are stripped
//   - blank lines ignored
//   - lines without an = are ignored (informational lines / accidental
//     copy-pastes shouldn't poison the load)
//
// We do NOT do ${VAR} expansion or command substitution. The parser is
// intentionally narrow because supporting expansion safely means
// re-implementing a small shell, and the value users get from "this works
// like dotenv-expand" doesn't outweigh the added complexity / surprise.
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^﻿/, ''); // strip BOM
    const stripped = line.replace(/^\s*export\s+/, '').trimStart();
    if (!stripped) continue;
    if (stripped.startsWith('#')) continue;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1);

    value = value.replace(/^\s+/, ''); // leading whitespace after =

    if (value.startsWith('"')) {
      // Double-quoted: support \n, \r, \t, \", \\ escapes inside.
      const closing = findClosingQuote(value, '"');
      if (closing === -1) {
        // Unterminated quote → take the rest of the line verbatim.
        value = value.slice(1);
      } else {
        const inner = value.slice(1, closing);
        value = inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else if (value.startsWith("'")) {
      // Single-quoted: literal, no escape processing (shell-like).
      const closing = findClosingQuote(value, "'");
      value = closing === -1 ? value.slice(1) : value.slice(1, closing);
    } else {
      // Unquoted: trim trailing whitespace and strip inline comments
      // (everything after a ` #` sequence, where the # is preceded by
      // whitespace — `foo#bar` stays intact).
      const commentMatch = value.match(/\s+#.*$/);
      if (commentMatch) value = value.slice(0, commentMatch.index);
      value = value.trimEnd();
    }
    out[key] = value;
  }
  return out;
}

function findClosingQuote(s: string, quote: string): number {
  // Walk from index 1 (skip the opening quote) and respect backslash
  // escapes only for double quotes. Single quotes have no escapes — the
  // first match wins.
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === '\\') { i++; continue; }
    if (c === quote) return i;
  }
  return -1;
}

// Loads every file path in order. Missing or unreadable files are recorded
// in the returned files[] (so the UI can render them orange) but don't
// block the merge — the documented behaviour is "warn and continue".
//
// `workspaceFolder` lets the loader resolve workspace-relative paths the
// same way the rest of the extension does: relative paths are joined to
// the folder, absolute paths used as-is.
export async function loadEnvFiles(
  paths: string[],
  workspaceFolder: string,
): Promise<LoadResult> {
  const files: DotEnvFileResult[] = [];
  const merged: Record<string, string> = {};

  for (const p of paths) {
    if (!p || !p.trim()) continue;
    const resolved = path.isAbsolute(p) ? p : path.join(workspaceFolder, p);
    let exists = false;
    try {
      const stat = await fs.promises.stat(resolved);
      exists = stat.isFile();
    } catch { /* missing */ }

    if (!exists) {
      log.warn(`env file: missing ${resolved}`);
      files.push({
        path: p,
        resolvedPath: resolved,
        loaded: false,
        variables: {},
        error: 'missing',
        errorDetail: `Not found at ${resolved}`,
      });
      continue;
    }

    let text: string;
    try {
      text = await fs.promises.readFile(resolved, 'utf8');
    } catch (e) {
      log.warn(`env file: read error ${resolved}: ${(e as Error).message}`);
      files.push({
        path: p,
        resolvedPath: resolved,
        loaded: false,
        variables: {},
        error: 'read-error',
        errorDetail: (e as Error).message,
      });
      continue;
    }

    let vars: Record<string, string>;
    try {
      vars = parseDotEnv(text);
    } catch (e) {
      log.warn(`env file: parse error ${resolved}: ${(e as Error).message}`);
      files.push({
        path: p,
        resolvedPath: resolved,
        loaded: false,
        variables: {},
        error: 'parse-error',
        errorDetail: (e as Error).message,
      });
      continue;
    }

    log.debug(`env file: loaded ${resolved} (${Object.keys(vars).length} vars)`);
    files.push({
      path: p,
      resolvedPath: resolved,
      loaded: true,
      variables: vars,
    });
    // Later files override earlier ones — matches the documented
    // precedence and what every dotenv library does.
    Object.assign(merged, vars);
  }

  return { files, merged };
}

// Heuristic for the masked-by-default rendering in the eye-icon dialog.
// Keys matching this pattern start hidden; the user can click to reveal.
// Names matter more than values (no value introspection) to keep things
// predictable and keep secret detection cheap.
const SECRET_KEY_RE = /(?:^|_)(PASSWORD|PASSWD|PWD|TOKEN|SECRET|KEY|APIKEY|API_KEY|CREDENTIAL|PRIVATE)(?:_|$)/i;
export function looksLikeSecret(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}
