import * as cp from 'child_process';
import { log } from '../../utils/logger';

export interface GradleTaskEntry {
  group: string;
  name: string;
  description: string;
}

export interface DiscoverOpts {
  cwd: string;
  gradleBinary: string;  // './gradlew' or '/opt/gradle/bin/gradle' or 'gradle'
  env?: Record<string, string>;
  timeoutMs?: number;    // default 60s
}

// Runs `<gradleBinary> -q --console=plain tasks --all` and parses the output.
//
// The -q switch (quiet) silences Gradle's own progress/daemon messages so
// only the task list reaches stdout. --console=plain avoids ANSI escapes
// that would confuse the parser on Windows terminals.
//
// Returns [] on failure (non-zero exit, timeout, parse error) — callers
// surface a user-facing error message but don't block the editor.
export async function discoverGradleTasks(opts: DiscoverOpts): Promise<GradleTaskEntry[]> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const args = ['-q', '--console=plain', 'tasks', '--all'];

  log.info(`Gradle tasks: running ${opts.gradleBinary} ${args.join(' ')} (cwd=${opts.cwd})`);
  const output = await runAndCollect(opts.gradleBinary, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs,
  });
  if (output === null) return [];

  return parseGradleTasksOutput(output);
}

interface RunOpts { cwd: string; env?: Record<string, string>; timeoutMs: number }

async function runAndCollect(
  command: string,
  args: string[],
  opts: RunOpts,
): Promise<string | null> {
  return new Promise(resolve => {
    const child = cp.spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // ShellExecution-style; also needed on Windows so .bat / .cmd resolve.
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', b => { stdout += b.toString(); });
    child.stderr?.on('data', b => { stderr += b.toString(); });

    const killer = setTimeout(() => {
      log.warn(`Gradle tasks: timed out after ${opts.timeoutMs}ms — killing`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(null);
    }, opts.timeoutMs);

    child.on('error', e => {
      clearTimeout(killer);
      log.warn(`Gradle tasks: spawn failed: ${e.message}`);
      resolve(null);
    });

    child.on('exit', code => {
      clearTimeout(killer);
      if (code !== 0) {
        log.warn(`Gradle tasks: exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

// Parses the canonical `tasks --all` output. Sample:
//
//   > Task :tasks
//
//   ------------------------------------------------------------
//   All tasks runnable from project ':api'
//   ------------------------------------------------------------
//
//   Build tasks
//   -----------
//   assemble - Assembles the outputs of this project.
//   classes - Assembles main classes.
//
//   Liquibase tasks
//   ---------------
//   dropAll - Drop all database objects owned by the user.
//
// Groups are "Title tasks" followed by a line of dashes. Task lines are
// "<name> - <description>" at column 0. Everything else we ignore.
export function parseGradleTasksOutput(output: string): GradleTaskEntry[] {
  const lines = output.split(/\r?\n/);
  const tasks: GradleTaskEntry[] = [];
  let currentGroup: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';

    // Group header: non-empty line followed by at least 3 dashes.
    if (/^[A-Za-z][\w ]*$/.test(line.trim()) && /^-{3,}$/.test(next.trim())) {
      currentGroup = line.trim();
      i++; // skip the dash line
      continue;
    }

    // Blank line → terminates current group.
    if (line.trim() === '') {
      // Don't reset currentGroup — the next group header will overwrite it.
      // Blank lines appear inside groups too (e.g. after "Pattern: ..." lines).
      continue;
    }

    if (!currentGroup) continue;

    // Task line: "name - description" OR "name" (no description).
    // Names may be module-scoped (":api:test"), so allow a leading colon.
    const m = /^(:?[A-Za-z][\w:-]*)\s+-\s+(.*)$/.exec(line);
    if (m) {
      tasks.push({ group: currentGroup, name: m[1], description: m[2].trim() });
      continue;
    }
    const justName = /^(:?[A-Za-z][\w:-]*)\s*$/.exec(line);
    if (justName) {
      tasks.push({ group: currentGroup, name: justName[1], description: '' });
    }
  }

  return tasks;
}
