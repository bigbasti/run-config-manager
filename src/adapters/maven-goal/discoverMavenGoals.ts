import * as vscode from 'vscode';
import { log } from '../../utils/logger';

export interface MavenGoalEntry {
  // Either a lifecycle phase ("clean"), a plugin prefix ("liquibase:"),
  // or a plugin-qualified goal ("liquibase:dropAll"). Prefixes invite the
  // user to complete the goal in the text input.
  value: string;
  description: string;
}

// Standard Maven lifecycle phases in execution order. Covers the happy
// path — users who want less common phases (pre-integration-test,
// post-integration-test, initialize, etc.) type them manually.
const LIFECYCLE_PHASES: Array<{ value: string; description: string }> = [
  { value: 'clean', description: 'Remove build artifacts (target/).' },
  { value: 'validate', description: 'Validate project structure and required info.' },
  { value: 'compile', description: 'Compile source code.' },
  { value: 'test', description: 'Run tests.' },
  { value: 'package', description: 'Package compiled code (JAR/WAR).' },
  { value: 'verify', description: 'Run integration tests + quality checks.' },
  { value: 'install', description: 'Install package in the local repository.' },
  { value: 'site', description: 'Generate project site.' },
  { value: 'deploy', description: 'Deploy package to a remote repository.' },
];

// Reads pom.xml and extracts <plugin> declarations to offer as goal
// prefixes. Much cheaper than running `mvn help:describe` per plugin
// (which requires a network-capable Maven install), and gives the user
// discoverability without the cost.
export async function discoverMavenGoals(folder: vscode.Uri): Promise<MavenGoalEntry[]> {
  const entries: MavenGoalEntry[] = [...LIFECYCLE_PHASES];

  const pom = await readPom(folder);
  if (pom) {
    const plugins = extractPluginArtifacts(pom);
    for (const artifact of plugins) {
      // Strip the -maven-plugin / maven--plugin suffix Maven uses as its
      // default prefix derivation: `liquibase-maven-plugin` → `liquibase:`.
      const prefix = stripPluginSuffix(artifact);
      if (entries.some(e => e.value === `${prefix}:`)) continue;
      entries.push({
        value: `${prefix}:`,
        description: `Plugin "${artifact}" — type the goal after the colon (e.g. ${prefix}:help)`,
      });
    }
    log.debug(`Maven goals: discovered ${plugins.length} plugin prefix(es)`);
  }

  return entries;
}

async function readPom(folder: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'pom.xml'));
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

// Minimal XML scraper — regex is good enough for Maven's tame pom syntax
// and avoids pulling in an XML parser dependency.
function extractPluginArtifacts(pom: string): string[] {
  const seen = new Set<string>();
  const re = /<plugin>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/plugin>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pom)) !== null) {
    seen.add(m[1].trim());
  }
  return Array.from(seen);
}

function stripPluginSuffix(artifact: string): string {
  // Maven's default prefix rules:
  //   maven-<name>-plugin  → <name>
  //   <name>-maven-plugin  → <name>
  //   <name>-plugin        → <name>
  //   otherwise            → <artifact> unchanged
  let s = artifact;
  s = s.replace(/^maven-/, '').replace(/-maven-plugin$/, '').replace(/-plugin$/, '');
  return s;
}
