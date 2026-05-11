import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PythonFramework } from '../../shared/types';
import { log } from '../../utils/logger';

export interface FrameworkHit {
  name: PythonFramework;
  source: string; // relative path of the file the dependency was found in
}

// pyproject is parsed with a tiny line-oriented scanner — we don't pull
// in a real TOML parser. The relevant subset (dependencies arrays and
// [tool.poetry.dependencies] tables) is well-bounded and easy to read
// off without a lexer.
//
// Search order:
//   1. Project root metadata: pyproject.toml, requirements*.txt, setup.cfg.
//   2. Parent-directory walk (up to 4 levels). Many monorepos and example
//      collections keep a single `requirements.txt` at the repo root and
//      individual subprojects underneath. Stops at a `.git` boundary.
//   3. Project source scan: for any framework not yet detected, look for
//      `import <fw>` / `from <fw> import` lines in *.py files at the
//      project root. Cheap final fallback when no metadata exists.
export async function detectFrameworks(projectUri: vscode.Uri): Promise<FrameworkHit[]> {
  const root = projectUri.fsPath;
  const seen = new Map<PythonFramework, string>();

  // 1+2. Walk the project dir + up to 4 parent dirs. Stop on .git boundary.
  const dirsToScan = await collectMetadataDirs(root, 4);
  for (const dir of dirsToScan) {
    const relTag = dir === root ? '' : path.relative(root, dir).split(path.sep).join('/') + '/';

    const pyproject = await readFile(path.join(dir, 'pyproject.toml'));
    if (pyproject) {
      const pep621 = knownFrameworksFromPackages(parsePyprojectDependencies(pyproject));
      for (const f of pep621) if (!seen.has(f)) seen.set(f, `${relTag}pyproject.toml`);
      const poetry = knownFrameworksFromPackages(parsePoetryDependencies(pyproject));
      for (const f of poetry) if (!seen.has(f)) seen.set(f, `${relTag}pyproject.toml`);
    }

    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { entries = []; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/^requirements.*\.txt$/i.test(e.name)) continue;
      const text = await readFile(path.join(dir, e.name));
      if (!text) continue;
      const hits = knownFrameworksFromPackages(parseRequirementsTxt(text));
      for (const f of hits) if (!seen.has(f)) seen.set(f, `${relTag}${e.name}`);
    }

    const setupCfg = await readFile(path.join(dir, 'setup.cfg'));
    if (setupCfg) {
      const hits = knownFrameworksFromPackages(parseSetupCfgInstallRequires(setupCfg));
      for (const f of hits) if (!seen.has(f)) seen.set(f, `${relTag}setup.cfg`);
    }
  }

  // 3. Import-statement scan as a final fallback. Only fires when no
  // metadata was found OR a known framework didn't show up in any file
  // — e.g. an example folder with `app.py` that imports flask but no
  // local pyproject. We only scan top-level *.py at the project root
  // (no recursion) to keep this cheap.
  const importHits = await scanProjectImports(root);
  for (const [name, source] of importHits) {
    if (!seen.has(name)) seen.set(name, source);
  }

  return [...seen].map(([name, source]) => ({ name, source }));
}

// Collect the project dir plus up to `maxParents` ancestor dirs, stopping
// at a `.git` boundary or the filesystem root, whichever comes first.
async function collectMetadataDirs(root: string, maxParents: number): Promise<string[]> {
  const out: string[] = [root];
  let current = root;
  for (let i = 0; i < maxParents; i++) {
    const parent = path.dirname(current);
    if (parent === current) break; // hit FS root
    // Stop crossing a `.git` boundary — beyond a repo root the dependency
    // metadata typically belongs to a different project entirely.
    if (await pathExists(path.join(current, '.git'))) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.stat(p); return true; }
  catch { return false; }
}

// Walks top-level `*.py` files in the project root and matches `import X`
// / `from X import` for known frameworks. Returns hits as `[framework, source]`.
async function scanProjectImports(root: string): Promise<Array<[PythonFramework, string]>> {
  const out: Array<[PythonFramework, string]> = [];
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.py')) continue;
    const text = await readFile(path.join(root, e.name));
    if (!text) continue;
    const found = parseImportStatements(text);
    for (const fw of found) out.push([fw, e.name]);
  }
  return out;
}

// Lightweight import scanner. Matches `import <fw>` and `from <fw>` /
// `from <fw>.…` at line start (after optional whitespace). Doesn't try
// to handle `try/except ImportError` blocks or string-eval'd imports —
// false positives are rare and cheap.
export function parseImportStatements(text: string): PythonFramework[] {
  const found = new Set<PythonFramework>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:from|import)\s+([\w.]+)/);
    if (!m) continue;
    const top = m[1].split('.')[0].toLowerCase();
    const fw = KNOWN_FRAMEWORKS[top];
    if (fw) found.add(fw);
  }
  return [...found];
}

// PEP 621: [project] dependencies = ["foo", "bar>=1.0", ...]
export function parsePyprojectDependencies(toml: string): string[] {
  const projectSection = sliceSection(toml, '[project]');
  if (!projectSection) return [];
  const dependenciesIdx = projectSection.indexOf('dependencies');
  if (dependenciesIdx < 0) return [];
  const arrayStart = projectSection.indexOf('[', dependenciesIdx);
  if (arrayStart < 0) return [];
  // Find the matching closing bracket, accounting for nested brackets
  // inside string entries (e.g. `"uvicorn[standard]>=0.27"`).
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < projectSection.length; i++) {
    const ch = projectSection[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { arrayEnd = i; break; }
    }
  }
  if (arrayEnd < 0) return [];
  const body = projectSection.slice(arrayStart + 1, arrayEnd);
  return body
    .split(/[,\n]/)
    .map(s => s.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(s => s.replace(/^["']|["']$/g, ''))
    .map(stripVersionAndExtras)
    .filter(Boolean);
}

// Poetry: [tool.poetry.dependencies] foo = "..."  (table of key=value).
export function parsePoetryDependencies(toml: string): string[] {
  const section = sliceSection(toml, '[tool.poetry.dependencies]');
  if (!section) return [];
  const out: string[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === 'python' || !key) continue;
    out.push(key);
  }
  return out;
}

// requirements.txt — strip version pins, extras, comments, hash markers.
export function parseRequirementsTxt(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-')) continue; // -r, -e, etc.
    // Drop continuation backslashes.
    line = line.replace(/\s*\\\s*$/, '');
    const pkg = stripVersionAndExtras(line);
    if (pkg) out.push(pkg);
  }
  return out;
}

// setup.cfg [options] install_requires = django\n  fastapi
export function parseSetupCfgInstallRequires(cfg: string): string[] {
  const section = sliceSection(cfg, '[options]');
  if (!section) return [];
  const idx = section.indexOf('install_requires');
  if (idx < 0) return [];
  const body = section.slice(idx).split('\n').slice(1)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('['));
  const items: string[] = [];
  for (const l of body) {
    if (l.includes('=')) break; // hit the next key
    items.push(stripVersionAndExtras(l));
  }
  return items.filter(Boolean);
}

const KNOWN_FRAMEWORKS: Record<string, PythonFramework> = {
  django: 'django',
  fastapi: 'fastapi',
  flask: 'flask',
  uvicorn: 'uvicorn',
  gunicorn: 'gunicorn',
  celery: 'celery',
  typer: 'typer',
  starlette: 'starlette',
  click: 'click',
};

export function knownFrameworksFromPackages(packages: string[]): PythonFramework[] {
  const out: PythonFramework[] = [];
  const seen = new Set<PythonFramework>();
  for (const p of packages) {
    const normalized = p.toLowerCase().replace(/_/g, '-');
    const fw = KNOWN_FRAMEWORKS[normalized];
    if (fw && !seen.has(fw)) { seen.add(fw); out.push(fw); }
  }
  return out;
}

function stripVersionAndExtras(s: string): string {
  // Strip [extras], version specifiers (>=, ==, ~, <), and trailing whitespace.
  return s.replace(/\[.*?\]/, '').replace(/[<>=!~].*$/, '').trim();
}

function sliceSection(toml: string, header: string): string | null {
  const start = toml.indexOf(header);
  if (start < 0) return null;
  const after = toml.indexOf('\n', start) + 1;
  const next = toml.slice(after).search(/^\[/m);
  return next < 0 ? toml.slice(after) : toml.slice(after, after + next);
}

async function readFile(p: string): Promise<string | null> {
  try { return await fs.promises.readFile(p, 'utf8'); }
  catch (e) {
    log.debug(`detectFrameworks: read ${p} failed: ${(e as Error).message}`);
    return null;
  }
}
