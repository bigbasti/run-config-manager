<p align="center"><img src="media/runconf.png" width="120" alt="Run Configuration Manager"/></p>

# Run Configuration Manager

IntelliJ-style run configurations for VS Code. Save, share, and launch your project's run commands from the Activity Bar — without memorizing terminal flags or digging through scripts.

> **The extension does the heavy lifting for you.** Open the `+` dialog, pick your project — and the extension scans your codebase, finds your scripts, detects your JDKs, locates your main classes, and pre-fills the form. Most configurations are ready to save in just a few clicks, with no manual research required.

*Example — add npm (Angular) Run Config*
![Add npm (Angular) Run Config](media/add_npm_project.gif)

*Example — add Quarkus Run Config*
![Add Quarkus Run Config](media/add_quarkus_project.gif)

## What it does

The extension adds a **Run Configurations** panel to the Activity Bar. Each entry in the panel represents a saved way to start (or debug) your application. Click once to run, click again to stop. No terminal knowledge required.

Configurations are stored in `.vscode/run.json` so you can commit them and share them with your whole team. Everyone gets the same one-click experience.

![Run Configurations panel showing all project types](media/example_menu_run_configs.jpg)

## Supported project types

| Type | What it runs |
|---|---|
| **npm / Node.js** | Any `package.json` script, with your choice of npm, yarn, or pnpm |
| **Spring Boot** | Maven, Gradle, or direct Java launch — auto-detects your project setup |
| **Quarkus** | Maven or Gradle dev mode with Live Coding |
| **Tomcat** | Deploys your WAR or exploded directory to a managed Tomcat instance |
| **Java Application** | Plain Java apps via Maven exec, Gradle run, or direct `java` launch |
| **Maven Goal** | Any Maven phase or plugin goal, saved as a one-click button |
| **Gradle Task** | Any Gradle task from your build, saved as a one-click button |
| **Custom Command** | Any shell command — pipes, globs, environment variables, all supported |

## Key features

**Auto-detection** — Click `+` and the extension scans your project. Main classes, JDK locations, build tools, profiles, and available scripts are all discovered for you. The form opens instantly and fills in as scanning completes in the background.

![Auto-filled Spring Boot form with detected build mode and profiles](media/resolution_spring_boot.jpg)

![JDKs detected on your system](media/resolution_jdk.jpg) ![Gradle installations detected automatically](media/resolution_gradle.jpg) ![Tomcat installations detected automatically](media/resolution_tomcat.jpg)

![Browse all Gradle tasks by category](media/resolution_gradle_task.jpg)

**Live startup status** — The panel shows exactly what your app is doing. Configurations cycle through visual states (Preparing → Starting → Running → Started / Failed) based on real terminal output. You see the actual state of your app, not just whether a process is alive.

![Live run state in the sidebar](media/live_run_state_example.gif)

**One-click debugging** — Every configuration that supports it has a Debug button alongside Run. The extension handles attaching the debugger automatically — no separate launch configuration to maintain.

**Rich terminal output** — The integrated terminal colors log levels, turns file paths and URLs into clickable links, and highlights startup success or failure lines so important output is never buried.

**Environment variables and path tokens** — Set per-configuration environment variables and use `${workspaceFolder}`, `${userHome}`, and other tokens anywhere in your configuration. The on-disk file keeps the tokens; the extension resolves them at launch time.

**Multi-root workspace support** — Works across multi-folder workspaces. Each folder has its own set of configurations. Stop All in the title bar stops every running configuration at once.

**Shareable configs** — Commit `.vscode/run.json` and your teammates open the same sidebar with the same configured run commands, ready to use.

## Getting started

1. Click the **Run Configurations** icon in the Activity Bar.
2. Click **+** to add a configuration — the extension auto-detects your project type.
3. Review the pre-filled form and click **Save**.
4. Press the play button next to your new configuration to run it.

That's it. Edit or delete configurations at any time from the same panel.
