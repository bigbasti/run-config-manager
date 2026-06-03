import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import { inferConfigPortsDetailed } from './PortScanner';
import { resolveProjectUri } from '../utils/paths';
import {
  detectSpringBootPort,
  detectQuarkusPort,
  detectNpmPort,
  safeDetect,
} from './detectProjectPort';

// Best-effort set of ports a config is expected to bind when it runs.
// Combines the explicitly-declared ports (cfg.port, server.port in args/env,
// tomcat httpPort, debugPort) with a project-file probe for the runtimes
// that declare their port outside the run config (Spring Boot
// application.properties, Quarkus application.yml, npm package.json scripts /
// framework conventions).
//
// Used both to record run state (so a reload can match by port) and to detect
// a port conflict before launching. Returns [] when nothing is known — the
// caller treats an empty result as "can't reattach / no conflict to check".
export async function resolveExpectedPorts(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<number[]> {
  const ports = new Set<number>(inferConfigPortsDetailed(cfg).explicit);

  const root = resolveProjectUri(folder, cfg.projectPath);
  let detected: number | null = null;
  if (cfg.type === 'spring-boot') {
    detected = await safeDetect('spring-boot', () =>
      detectSpringBootPort(root, cfg.typeOptions.profiles),
    );
  } else if (cfg.type === 'quarkus') {
    detected = await safeDetect('quarkus', () =>
      detectQuarkusPort(root, cfg.typeOptions.profile),
    );
  } else if (cfg.type === 'npm') {
    detected = await safeDetect('npm', () =>
      detectNpmPort(root, cfg.typeOptions.scriptName),
    );
  }
  if (detected && detected > 0) ports.add(detected);

  return [...ports].filter(p => p > 0);
}
