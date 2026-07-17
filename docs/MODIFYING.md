# Modifying the UI

## Source map

- `custom/gpt-codex-custom.*` owns Chat product integration, navigation,
  conversation actions, message/image controls, native route bridges, and the
  runtime self-test.
- `custom/gpt-codex-model-picker.*` owns the model/effort matrix, continuous
  drag motion, Ultra lever/particles, and Fast-tier effect.
- `custom/gpt-codex-token-hud.*` owns token-source normalization, exact versus
  estimated labels, thinking-token accounting, collision-aware docking, and the
  expanded details card.
- `custom/gpt-codex-pinboard.*` owns local message pinning and its IndexedDB
  store.
- `scripts/Build-Custom.ps1` validates the pinned upstream fingerprint, copies
  maintained assets into the isolated runtime, injects their tags, and applies
  narrow native bridge patches.
- `scripts/launcher/GPTCodexCustomLauncher.cs`, `scripts/Build-Launcher.ps1`,
  and `scripts/Launch-Custom-Gui.ps1` own the project-built Windows GUI launcher,
  hidden launch transport, error dialog, and log handoff.
- `scripts/Verify-Custom.ps1` is the static compatibility and release gate.

## Development cycle

1. Close the custom runtime when changing the packed archive.
2. Run `npm run upstream:check` to ensure the installed app has not moved away
   from the current compatibility baseline.
3. Edit maintained files under `custom/` or `scripts/`.
4. Run `npm run build`.
5. Run `npm run verify`.
6. Launch and exercise the exact affected path.
7. Run `npm run verify:ui-suite` before handoff or publication.

For launcher-only changes, run `npm run build:launcher` followed by
`npm run verify:launcher`; the full `npm run build` and `npm run verify` paths
also include the launcher.

`npm run launch:replace` deliberately closes only processes whose executable
path matches this project's copied runtime. It never targets the Store build.
The consolidated UI suite uses that same exact-path guard, waits for the
post-launch renderer remount, and restores a normal non-diagnostic launch in a
`finally` path even when a verifier fails. Use the focused commands in
[Testing](TESTING.md) while iterating.

## Native bridges first

The custom controls should call the same state owners and account-backed actions
as the upstream UI. Do not treat a click animation or local DOM change as proof
that a feature works. For each action, verify:

- The native bridge is present before enabling the control.
- The native snapshot confirms model, effort, service tier, route, or account
  state after the action.
- For Chat models, derive a row from each option's exact `selectedLabel` or slug,
  never from its enclosing version-group label; do not synthesize unsupported
  row/column intersections.
- Rejection or missing capability returns the UI to the confirmed state.
- No message, upload, delete, or account mutation occurs in diagnostics unless
  the test explicitly uses a non-destructive dry-run bridge.

The saved-conversation menu uses the single
`GPT_CODEX_CUSTOM_CHAT_ACTIONS` bridge injected by `scripts/Build-Custom.ps1`.
When adding or changing an action, keep its capability check independent so an
unsupported upstream method disables only that menu item. Extend the shared
dry-run branch and strict runtime outcomes before exercising any account-backed
mutation.

Generated-image thumbnails are intercepted only in Chat mode. Viewer changes
must preserve Escape/backdrop dismissal, keyboard focus trapping and restoration,
zoom reset, and the native attachment handoff used by Edit image. Work and Codex
must retain their upstream image-click behavior.

## Native launcher boundary

Keep startup policy in `scripts/Launch-Custom.ps1`; the C# EXE is deliberately a
small transport rather than a second implementation of profile isolation,
updates, diagnostics, or process matching. Its normal path must remain a
Windows GUI subsystem executable with `CreateNoWindow` enabled. Any visible
console must require `--console`, the legacy CMD file, or an npm developer
command. Generated `GPT-Codex-Custom.exe` files are build output and must not be
committed; maintain and review the source under `scripts/launcher/` instead.

## Adding a maintained module

Adding a CSS or JavaScript file to `custom/` is not enough. Update all of these:

1. The required-source list and asset names in `scripts/Build-Custom.ps1`.
2. The HTML injection block in the same script.
3. Version/hash assertions and required markers in
   `scripts/Verify-Custom.ps1`.
4. Architecture and feature documentation.
5. Runtime self-tests when the module exposes interactive behavior.

The update packager includes the entire maintained `custom/` tree, but a module
will not run until the build script injects it.

## Handling an upstream update

Run `npm run upstream:check`. If drift is reported, close the custom app and run
`npm run upstream:sync`. Sync stages a new snapshot and fails before replacing
the working custom runtime when a required minified needle is missing.

When compatibility fails:

1. Inspect the new private `work/upstream-src/` only on your machine.
2. Find the renamed native component/state owner.
3. Add a narrowly scoped compatibility variant rather than deleting an old
   supported variant immediately.
4. Extend the verifier to prove exactly one known variant matched.
5. Rebuild, verify, and run interaction tests.

Never copy the extracted upstream archive into an Issue, pull request, release,
or documentation example.
