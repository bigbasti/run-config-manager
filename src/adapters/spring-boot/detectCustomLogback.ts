import * as vscode from 'vscode';

// Looks for a project-local logging config that would override our
// JAVA_TOOL_OPTIONS-injected `-Dlogging.pattern.console=…`. When such a
// file is present, the colorOutput checkbox won't actually colour the
// app's console output, and we warn the user accordingly.
//
// Covers three cases:
//   - logback-spring.xml / logback.xml — Spring Boot's Logback configs.
//     Any hardcoded `<pattern>…</pattern>` inside a ConsoleAppender
//     wins over our injected property.
//   - log4j2.xml / log4j2-spring.xml — same story for Log4j2 projects.
//
// Returns true when ANY file exists that likely overrides our output
// formatting. We don't try to be surgical (e.g. checking whether the
// pattern references the property placeholder) — the presence of a
// custom logging config is itself the signal worth surfacing.
export async function hasCustomLogback(folder: vscode.Uri): Promise<boolean> {
  const candidates = [
    'src/main/resources/logback-spring.xml',
    'src/main/resources/logback.xml',
    'src/main/resources/log4j2.xml',
    'src/main/resources/log4j2-spring.xml',
  ];
  for (const rel of candidates) {
    const text = await readFile(vscode.Uri.joinPath(folder, rel));
    if (!text) continue;
    if (fileDeclaresConsolePattern(text)) return true;
  }
  return false;
}

function fileDeclaresConsolePattern(text: string): boolean {
  // Pattern we look for: any `<pattern>` element anywhere in the file.
  // Spring Boot's default behaviour is to NOT ship a user-authored
  // logback file — so the mere presence of one already signals override
  // risk, and a <pattern> makes it certain.
  // Matches both logback (`<pattern>`) and log4j2 (`<PatternLayout pattern=…/>`).
  if (/<pattern\b[^>]*>[\s\S]*?<\/pattern>/i.test(text)) return true;
  if (/<PatternLayout\b[^>]*\bpattern\s*=/i.test(text)) return true;
  return false;
}

async function readFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}
