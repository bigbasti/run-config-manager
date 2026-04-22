# Manual Smoke Test — Run Configuration Manager v0.1.0

Run through this list before tagging a release. Mark items PASS / FAIL with notes.

## 0. Setup
- [ ] `npm run build` completes without errors.
- [ ] Press F5 → Extension Development Host opens.

## 1. Sidebar
- [ ] "Run Configurations" icon appears in the Activity Bar.
- [ ] Clicking it opens the view.
- [ ] Empty workspace shows "No run configurations. Click + to add one."

## 2. Add (no package.json)
- [ ] Open a folder with no package.json.
- [ ] Click `+` → pick folder → pick type `npm / Node.js`.
- [ ] Warning toast: "No npm / Node.js project detected".
- [ ] Editor webview opens with blank form (theme matches VS Code theme).

## 3. Add (with package.json)
- [ ] Open an Angular or Node project with scripts.
- [ ] Click `+`, pick project folder, pick npm.
- [ ] Form is pre-filled: script dropdown shows all scripts, package manager matches lockfile.
- [ ] Type a name, click Save.
- [ ] `.vscode/run.json` is created (or updated) with a new entry.
- [ ] Sidebar shows the new configuration immediately.

## 4. Run / Stop
- [ ] Click ▶️ on the configuration.
- [ ] A terminal opens titled with the config name; the script runs.
- [ ] The sidebar entry shows a spinner and the ▶️ action is hidden; ⏹ appears.
- [ ] Click ⏹ → the terminal closes, spinner clears, ▶️ returns.
- [ ] Start again, let it exit naturally (Ctrl+C in terminal or program exit) — sidebar returns to idle.

## 5. Debug
- [ ] Click 🐞. Debug session starts using the Node debugger.
- [ ] Breakpoints hit as expected.
- [ ] Stop the debug session — sidebar returns to idle.

## 6. Edit
- [ ] Click ✏️ (or click the config row).
- [ ] Webview opens pre-filled with existing values.
- [ ] Change the name, Save. Sidebar updates immediately.

## 7. Delete
- [ ] Click 🗑. Confirm dialog appears.
- [ ] Confirming deletes the config from sidebar and from `run.json`.

## 8. External edit
- [ ] Open `.vscode/run.json` in the editor, change a name, save.
- [ ] Sidebar updates within ~200ms.

## 9. Invalid file
- [ ] Corrupt `run.json` (e.g., remove a required field).
- [ ] Error notification appears with the path + field name.
- [ ] In-memory state is preserved — existing sidebar entries remain visible.

## 10. Multi-root workspace
- [ ] Add a second folder to the workspace.
- [ ] Each folder shows as a top-level node with its configs beneath.

## 11. Cross-platform (spot-check)
- [ ] Same flow works on macOS / Linux / Windows.
- [ ] Windows: `npm` resolves via PATH (uses `npm.cmd` implicitly).

## 12. Packaging
- [ ] `npm run package` produces a `.vsix`.
- [ ] Installing the `.vsix` in a clean VS Code and running a config works.

## 13. Help panel
- [ ] Open the editor webview. Panel on the right shows "Click a field to see help and examples here."
- [ ] Click the **Name** field. Panel shows title "Name" with description + examples.
- [ ] Tab through every field. Each one updates the help panel.
- [ ] Blur out of all fields — panel returns to the empty state.

## 14. Invalid configurations
- [ ] Edit `.vscode/run.json` manually to remove `typeOptions` from an entry. Save.
- [ ] Sidebar shows the entry with a warning icon and "(invalid — typeOptions: Required)" description.
- [ ] A toast warns about the invalid entry count.
- [ ] ▶️ Run and 🐞 Debug buttons are hidden on the invalid entry.
- [ ] Click 🔧 Fix. Webview opens with values pre-filled; `typeOptions` has default values.
- [ ] Click Save. Entry moves from invalid → valid. Warning icon disappears.
- [ ] Repeat: corrupt an entry; click ✏️ Edit instead of Fix. Webview opens with recovered data. Save → entry becomes valid.
- [ ] Repeat: corrupt an entry; click 📄 Open run.json. The file opens in the editor.
- [ ] Repeat: corrupt an entry; click 🗑 Delete. Entry is removed from sidebar AND run.json.
