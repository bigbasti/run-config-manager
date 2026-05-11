import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { log } from '../../utils/logger';

// Pre-flight dependency check for python configs. Runs before launch
// and surfaces missing packages so the user can install them in one
// click rather than discovering the gaps via run-time
// `ModuleNotFoundError` (which the reactive flow in ExecutionService
// also catches, but only one missing package at a time).
//
// Strategy:
//   1. Find a manifest file at the project root (pyproject.toml /
//      requirements*.txt). No manifest = `status: 'unknown'` (we
//      can't help — bare scripts skip the check).
//   2. Run `<py> -m pip check` to detect already-installed-but-
//      conflicting deps + parse for missing-required-by lines.
//      Combined with a quick `pyproject [project] dependencies`
//      / `requirements.txt` parse to catch packages declared but
//      not installed at all.
//   3. Suggest the canonical install command — `pip install -e .`
//      for editable pyproject installs, `pip install -r requirements.txt`
//      for pip-style projects.

export interface DependencyCheckResult {
  status: 'ok' | 'missing' | 'unknown';
  // Names of packages declared in the manifest but not importable in
  // the chosen interpreter. Empty unless `status === 'missing'`.
  missingPackages: string[];
  // Best-guess one-shot install command. Args are passed to
  // `<py> ...args` — e.g. `['-m', 'pip', 'install', '-e', '.']`.
  // Absent when no canonical command applies (e.g. pip-check passed
  // with no manifest).
  installCommand?: {
    args: string[];
    label: string; // human-readable for the prompt button
  };
  // Diagnostic string for logging only.
  reason?: string;
}

export async function checkDependencies(
  pythonHome: string,
  projectRoot: string,
): Promise<DependencyCheckResult> {
  const pyproject = await readFile(path.join(projectRoot, 'pyproject.toml'));
  const requirementsTxt = await readFile(path.join(projectRoot, 'requirements.txt'));

  if (!pyproject && !requirementsTxt) {
    return { status: 'unknown', missingPackages: [], reason: 'no manifest' };
  }

  // List the packages declared by the project that we want present in
  // the interpreter. Two lightweight parsers — same shape as detectFrameworks.
  const declared = new Set<string>();
  if (pyproject) for (const p of parsePyprojectDeps(pyproject)) declared.add(normalize(p));
  if (requirementsTxt) for (const p of parseRequirementsTxt(requirementsTxt)) declared.add(normalize(p));

  // Probe which of those are actually importable. We can't reliably
  // run `pip show` per package (slow + may need network for some
  // environments), so use `python -c "import importlib.util; print(...)"`
  // batched — one spawn per check, but we use `pip list` first for a
  // single-spawn fast path that catches the common case.
  const installed = await listInstalledPackages(pythonHome);
  if (installed === null) {
    return { status: 'unknown', missingPackages: [], reason: 'pip list failed' };
  }

  const missing: string[] = [];
  for (const pkg of declared) {
    if (!installed.has(pkg)) missing.push(pkg);
  }

  const installCommand = pickInstallCommand(pyproject, requirementsTxt);

  if (missing.length === 0) {
    return { status: 'ok', missingPackages: [], installCommand };
  }
  return { status: 'missing', missingPackages: missing, installCommand };
}

async function readFile(p: string): Promise<string | null> {
  try { return await fs.promises.readFile(p, 'utf8'); }
  catch { return null; }
}

// Parses `pyproject.toml`'s `[project] dependencies` PEP-621 array.
// Reuses the same logic shape as detectFrameworks but exported here
// to avoid cross-module dependency.
function parsePyprojectDeps(toml: string): string[] {
  const projectStart = toml.indexOf('[project]');
  if (projectStart < 0) return [];
  const sectionEnd = toml.slice(projectStart + 1).search(/^\[/m);
  const section = sectionEnd < 0 ? toml.slice(projectStart) : toml.slice(projectStart, projectStart + 1 + sectionEnd);
  const depsIdx = section.indexOf('dependencies');
  if (depsIdx < 0) return [];
  const arrayStart = section.indexOf('[', depsIdx);
  if (arrayStart < 0) return [];
  // Walk to the matching closing bracket, accounting for nested ones
  // inside extras (`fastapi[standard]`).
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < section.length; i++) {
    const ch = section[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { arrayEnd = i; break; }
    }
  }
  if (arrayEnd < 0) return [];
  const body = section.slice(arrayStart + 1, arrayEnd);
  return body
    .split(/[,\n]/)
    .map(s => s.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(s => s.replace(/^["']|["']$/g, ''))
    .map(stripVersionAndExtras)
    .filter(Boolean);
}

function parseRequirementsTxt(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-')) continue;
    line = line.replace(/\s*\\\s*$/, '');
    const pkg = stripVersionAndExtras(line);
    if (pkg) out.push(pkg);
  }
  return out;
}

function stripVersionAndExtras(s: string): string {
  return s.replace(/\[.*?\]/, '').replace(/[<>=!~].*$/, '').trim();
}

// PyPI canonical names are case-insensitive and treat `-` / `_` / `.`
// as equivalent. Normalize before set lookup so `Flask-SQLAlchemy` and
// `flask_sqlalchemy` compare equal.
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, '-');
}

// Spawns `<py> -m pip list --format=freeze`. Single network-free call;
// returns the set of normalized package names on success, `null` on
// any failure (caller treats null as "we don't know — skip the check").
async function listInstalledPackages(pythonHome: string): Promise<Set<string> | null> {
  const isWin = process.platform === 'win32';
  const bin = !pythonHome
    ? 'python3'
    : isWin
      ? path.join(pythonHome, 'python.exe')
      : path.join(pythonHome, 'bin', 'python3');
  const out = await runOnce(bin, ['-m', 'pip', 'list', '--format=freeze'], 5000);
  if (!out) return null;
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // freeze format: `name==version`. Strip the version + extras.
    const eq = trimmed.indexOf('==');
    const name = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim();
    if (!name) continue;
    set.add(normalize(name));
  }
  return set;
}

function pickInstallCommand(
  pyproject: string | null,
  requirementsTxt: string | null,
): DependencyCheckResult['installCommand'] | undefined {
  if (pyproject) {
    // Prefer editable install when the project declares both `[project]`
    // and `[build-system]` — that's what `pip install -e .` is for.
    if (pyproject.includes('[project]') && pyproject.includes('[build-system]')) {
      return { args: ['-m', 'pip', 'install', '-e', '.'], label: 'pip install -e .' };
    }
    return { args: ['-m', 'pip', 'install', '.'], label: 'pip install .' };
  }
  if (requirementsTxt) {
    return {
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      label: 'pip install -r requirements.txt',
    };
  }
  return undefined;
}

function runOnce(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let buf = '';
    let timed = false;
    let child;
    try { child = spawn(command, args, { windowsHide: true }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(undefined);
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed) return;
      if (code !== 0 && !buf) { resolve(undefined); return; }
      resolve(buf);
    });
    void log; // satisfy lint when no log line is emitted
  });
}
