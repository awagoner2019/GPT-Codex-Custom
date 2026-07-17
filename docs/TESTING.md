# Testing and diagnostics

The project separates source-safe checks, read-only renderer inspection, and
controlled interactive probes. Use the smallest gate that proves the change
while iterating, then run the consolidated suite before handoff or publication.

## Preferred UI gate

After building the isolated runtime:

```powershell
npm run build
npm run verify
npm run verify:ui-suite
```

`verify:ui-suite` performs this sequence:

1. Runs the strict renderer self-test and requires every named outcome.
2. Relaunches only this project's copied executable with a random loopback
   diagnostics port.
3. Transiently opens Chat through the custom bridge without changing the stored
   Chat/native product preference.
4. Waits for the native/custom post-launch remount, then takes one read-only UI
   snapshot from the exact `app://-/index.html` renderer.
5. Validates fresh Chat-action dry-run evidence and account-backed bridge
   readiness.
6. Exercises model-picker motion and token-dock behavior with state restoration.
7. Uses a `finally` path to relaunch the custom app normally without a remote
   debugging argument, whether the suite passes or fails. The strict self-test
   also restores the stored Chat/native preference it observed at startup.

The helper never targets a process by name alone. Replacement is limited to a
process whose executable path exactly equals `work/runtime/ChatGPT.exe`; the
installed Microsoft Store app remains outside its scope.

## Command matrix

| Command | Purpose | Account or UI effect | Requires diagnostics? |
| --- | --- | --- | --- |
| `npm run verify` | Static hashes, native-launcher contract, injection markers, bridge contracts, profile isolation, and sanitized report | No account action; writes `work/verification/release-verification.json` | No |
| `npm run verify:launcher` | PE GUI subsystem, console-free default, explicit console fallback, parent-exit update handoff, native error dialog, and non-launching probe | Does not start the runtime or touch account state | No |
| `npm run verify:installer` | Installer prerequisite plus eight bootstrap/signature scenarios | Downloads Microsoft's signed installer to a temporary path; does not install it | No |
| `npm run verify:update` | ZIP allowlist, hashes, rollback, retired-file cleanup, and private-state preservation | Uses a temporary fixture only | No |
| `npm run self-test:replace` | Strict end-to-end renderer action contract | Navigates the isolated app, opens saved chats, creates an unsent local chat, runs search, uses action dry runs, and stages/removes a synthetic PNG; sends no message and changes no saved conversation/share state | Temporary, managed automatically |
| `npm run launch:diagnostics:replace` | Starts the isolated renderer on a random loopback DevTools port | Replaces only the custom runtime | Starts it |
| `npm run verify:interactive` | Read-only structure, capability, token, pinboard, model-picker, and geometry snapshot | Calls only named synchronous diagnostic probes; no clicks or dispatch | Yes |
| `npm run verify:chat-actions` | Requires live bridge readiness plus current strict self-test evidence for Share, Rename, Pin, Archive, and Delete | Reads evidence; the underlying self-test actions are dry runs | Yes |
| `npm run verify:motion` | Audits exact account-backed Chat/Work/Codex model combinations, then samples full trigger labels, continuous drag, interruption, Ultra-purple/Fast effects, mode switching, and native-selector suppression | Temporarily changes the native model choice and restores the starting choice | Yes |
| `npm run verify:token-dock` | Dock geometry, expansion, precision, and motion behavior | Temporarily changes local HUD/motion state and restores it | Yes |
| `npm run verify:ui-suite` | Runs the complete live sequence and restores normal launch | Combination of the controlled effects above | Managed automatically |

`npm run verify:chat-delete` remains a compatibility-focused check for the
Delete path and its existing self-test evidence. New conversation-menu work
should use `verify:chat-actions` and the full UI suite.

The launcher verifier invokes only `GPT-Codex-Custom.exe --launcher-probe` with
a temporary output path. That internal probe reports the resolved scripts and
runtime path, then exits before starting PowerShell or ChatGPT. The verifier
also reads the PE optional header and requires subsystem 2 (`Windows GUI`), so a
regression to a console executable fails the static gate.

## Focused diagnostic loop

For a single renderer check:

```powershell
npm run launch:diagnostics:replace
npm run verify:interactive
npm run launch:replace
```

The interactive verifier waits three seconds after finding the exact renderer
target. Maintainers who already established readiness can call
`scripts/Verify-Custom-Interactive.ps1 -RendererSettleMilliseconds 0`, but the
default should be retained for normal automation.

Never leave diagnostics enabled after manual inspection. A normal
`npm run launch:replace` removes the stale port file and starts the copied app
without `--remote-debugging-port`.

## Strict self-test boundary

The renderer self-test may navigate between existing conversations and modes,
but its server-affecting menu actions use the explicit
`GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN` branch. Message editing uses its own dry
run: it appends a harmless unique sentinel to the unsent editor, requires that
sentinel in the native edit callback, closes the editor, and leaves the saved
message unchanged. The generated-image test uploads only an in-memory synthetic
PNG in temporary composer mode before removing it. It does not:

- Send or regenerate a message.
- Rename, pin, archive, delete, or publish a conversation.
- Upload a personal file.
- Start dictation or voice mode.
- Attach to the normal Store profile.

Self-test output is private runtime evidence under
`profile/chromium/gpt-codex-custom-self-test-result.json`; never commit or attach
that file to an Issue. Focused JSON and screenshots under `work/verification/`
are also generated artifacts and may contain machine/UI details, so sanitize
them before sharing.

## Failure triage

- A static needle or bridge failure after a Store update means compatibility
  must be reviewed; do not broaden the patch or delete the assertion.
- A stale self-test result after rebuilding is not valid evidence. Run
  `npm run self-test:replace` or the full UI suite again.
- A missing control immediately after diagnostics launch should be rechecked
  with the default settle window. Persistent absence is an app defect, not a
  reason to weaken the required check.
- If a motion test reports an unmounted picker after repeated mode switches,
  relaunch diagnostics once and inspect the mode-switch evidence in
  `work/verification/model-picker-motion.json` before changing selectors.
- Do not use a Chat `versionOptions[].label` as the model identity of every child.
  A group can contain fallback options from another model generation; the
  child's `selectedLabel` and exact callback payload are authoritative.
- If any live gate fails, confirm the final process is a normal custom launch
  and has no `--remote-debugging-port` argument.

## Release evidence

For an owner release, retain these results in the release notes:

- Installer/bootstrap scenario count.
- Strict renderer required-outcome count.
- Read-only interactive required-check count.
- Static runtime and upstream/vendor integrity result.
- Updater/package-boundary result.
- Focused motion, token-dock, and affected-feature results.

Regenerate `release-manifest.json` only after the final maintained-source edit,
then rerun `npm run verify:update`. Never add `vendor/`, `work/`, `profile/`,
`logs/`, `updates/`, `dist/`, or `node_modules/` to release evidence or Git.
