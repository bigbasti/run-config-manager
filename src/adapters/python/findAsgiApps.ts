import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../../utils/logger';

// Walks the project for ASGI / WSGI app instantiations and returns
// `module:attr` strings that uvicorn / gunicorn / hypercorn accept.
// Matches the same module-naming convention `findEntryPoints` uses
// (relative to project root, dotted form, with an optional `src/`
// source-prefix collapse).
//
// Detection is regex-based and handles the dominant patterns:
//   app = FastAPI(...)
//   app: FastAPI = FastAPI(...)        (with type hint)
//   application = Flask(__name__)
//   app = Starlette()
// Multi-line constructor arguments are fine — we match on the line
// that starts the assignment, not the full statement.

export interface AsgiAppHit {
  // Dotted module path, e.g. 'app.main' or 'main' (relative to project root).
  module: string;
  // Variable name the framework instance is bound to (`app` / `application`).
  attr: string;
  // Convenience: `${module}:${attr}` — the format uvicorn / gunicorn want.
  ref: string;
  // Which framework the line matched (so callers can scope per framework).
  framework: 'fastapi' | 'flask' | 'starlette' | 'celery';
}

// Path-relative location of a Django `manage.py` script at the project
// root, when present. Used to suggest `manage.py runserver` style
// commands which auto-load DJANGO_SETTINGS_MODULE — the standard Django
// invocation idiom.
export interface DjangoProject {
  // Relative path under projectUri, with forward slashes. Almost always
  // 'manage.py' but kept relative-form to support src/-prefixed layouts
  // some teams use.
  managePy: string;
}

const FRAMEWORK_PATTERNS: Array<{ framework: AsgiAppHit['framework']; ctor: RegExp }> = [
  // `name = FastAPI(...)` — captures the variable name.
  { framework: 'fastapi',   ctor: /^(\s*)([A-Za-z_][\w]*)\s*(?::\s*[\w[\].,\s]+)?\s*=\s*FastAPI\s*\(/m },
  { framework: 'flask',     ctor: /^(\s*)([A-Za-z_][\w]*)\s*(?::\s*[\w[\].,\s]+)?\s*=\s*Flask\s*\(/m },
  { framework: 'starlette', ctor: /^(\s*)([A-Za-z_][\w]*)\s*(?::\s*[\w[\].,\s]+)?\s*=\s*Starlette\s*\(/m },
  // Celery: `app = Celery('proj', ...)`. Same structure — used by `-A <module>`.
  { framework: 'celery',    ctor: /^(\s*)([A-Za-z_][\w]*)\s*(?::\s*[\w[\].,\s]+)?\s*=\s*Celery\s*\(/m },
];

export async function findAsgiApps(projectUri: vscode.Uri): Promise<AsgiAppHit[]> {
  const root = projectUri.fsPath;
  const out: AsgiAppHit[] = [];
  const skipDirs = new Set([
    '.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.tox',
    '.nox', '.eggs', 'site-packages', 'tests', 'test',
  ]);

  // Most projects keep the app instantiation in `main.py` /
  // `app/main.py` / `app.py` / similar near the project root. Walk a
  // shallow tree (depth 4) so we don't read every .py file in a large
  // monorepo just to find the entry.
  const sourcePrefixes = await detectSourcePrefix(root);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    if (out.length >= 10) return; // bound the result count
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
      try {
        const text = await fs.promises.readFile(full, 'utf8');
        for (const { framework, ctor } of FRAMEWORK_PATTERNS) {
          const m = text.match(ctor);
          if (!m) continue;
          const attr = m[2];
          const rel = path.relative(root, full).split(path.sep).join('/');
          const prefix = matchPrefix(rel, sourcePrefixes);
          const dotted = relToDotted(rel, prefix);
          if (!dotted) break;
          out.push({
            module: dotted,
            attr,
            ref: `${dotted}:${attr}`,
            framework,
          });
          break; // one hit per file is enough
        }
      } catch (e) {
        log.debug(`findAsgiApps: read ${full} failed: ${(e as Error).message}`);
      }
    }
  }

  await walk(root, 0);
  return out;
}

async function detectSourcePrefix(root: string): Promise<string[]> {
  const candidates = ['src'];
  const out: string[] = [];
  for (const c of candidates) {
    try {
      const stat = await fs.promises.stat(path.join(root, c));
      if (stat.isDirectory()) out.push(c);
    } catch { /* not present */ }
  }
  out.push('');
  return out;
}

function matchPrefix(rel: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (!p) continue;
    if (rel.startsWith(p + '/')) return p;
  }
  return '';
}

function relToDotted(rel: string, prefix: string): string {
  let r = rel.replace(/\\/g, '/');
  if (prefix && r.startsWith(prefix + '/')) r = r.slice(prefix.length + 1);
  if (r.endsWith('.py')) r = r.slice(0, -3);
  // `__init__.py` represents the package itself — collapse to the
  // directory name. (Less common entry point but worth handling.)
  if (r.endsWith('/__init__')) r = r.slice(0, -'/__init__'.length);
  return r.split('/').filter(Boolean).join('.');
}

// Looks for a Django `manage.py` at the project root (or under an
// optional `src/` prefix). Returns the relative path on success.
// Used to pre-fill Django framework commands as `manage.py runserver`
// — which auto-loads DJANGO_SETTINGS_MODULE the way `python -m django`
// does not.
export async function findDjangoProject(projectUri: vscode.Uri): Promise<DjangoProject | null> {
  const root = projectUri.fsPath;
  for (const candidate of ['manage.py', 'src/manage.py']) {
    try {
      const stat = await fs.promises.stat(path.join(root, candidate));
      if (stat.isFile()) return { managePy: candidate };
    } catch { /* not present */ }
  }
  return null;
}
