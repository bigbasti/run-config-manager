# Run Configuration Manager

IntelliJ-style Run Configurations for VS Code. Sub-project 1 supports **npm / Node.js / Angular** projects. Java, Spring Boot, Quarkus, and Tomcat adapters are planned follow-ups.

## Prerequisites

- **Node.js** ≥ 18
- **VS Code** ≥ 1.85
- **npm** (or `yarn` / `pnpm`) on PATH for projects you want to run

## Setup

```bash
git clone <repo-url> run-config-manager
cd run-config-manager
npm install
```

## Develop

Open the project in VS Code and press **F5** — this builds the extension and launches an Extension Development Host with the extension loaded.

For a live rebuild:

```bash
npm run watch
```

Then press F5 separately.

## Package

```bash
npm install -g @vscode/vsce   # once
npm run package               # produces run-config-manager-0.1.0.vsix
```

## Install the .vsix

In VS Code, open the Command Palette → **Extensions: Install from VSIX…** → choose the generated file.

## Usage

1. Open any folder containing a `package.json` (or a multi-root workspace).
2. Click the **Run Configurations** icon in the Activity Bar.
3. Click **+** in the view title.
4. Pick a workspace folder (if multi-root), then a project folder, then a configuration type (`npm / Node.js`).
5. The form is pre-filled from your `package.json` scripts. Adjust as needed and click **Save**.
6. Back in the sidebar, each configuration has inline ▶️ Run, 🐞 Debug, ✏️ Edit, 🗑 Delete actions. While running, the ▶️ switches to ⏹ Stop.

## Where are configurations stored?

`.vscode/run.json` at the root of each workspace folder. You can commit this file to share configurations with your team. **Do not edit it manually** — use the GUI; manual edits are validated on load and rejected with a descriptive error if malformed.

## Debugging the extension

- Output panel → **Run Configurations** channel for structured logs.
- Extension Development Host logs are also in the Debug Console of the first VS Code window (the one that launched the host).
- Common issues:
  - *Webview is blank* → check DevTools (Help → Toggle Developer Tools on the Ext Host). Usually a CSP or asset-path mismatch.
  - *Task doesn't start* → check that the `npm` / `yarn` / `pnpm` executable is on PATH. The terminal that opens shows the real error.
  - *Debug attach fails* → verify the project's `package.json` has the script you selected and that Node debug works manually.

## What's out of scope (planned for later sub-projects)

- Java / Spring Boot / Quarkus / Tomcat adapters.
- Docker project detection.
- Compound configurations (run multiple at once).
- Persistent "last run" state across window reloads.
- `${workspaceFolder}` variable expansion in env values.
