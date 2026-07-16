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
- `scripts/Verify-Custom.ps1` is the static compatibility and release gate.

## Development cycle

1. Close the custom runtime when changing the packed archive.
2. Run `npm run upstream:check` to ensure the installed app has not moved away
   from the current compatibility baseline.
3. Edit maintained files under `custom/` or `scripts/`.
4. Run `npm run build`.
5. Run `npm run verify`.
6. Launch and exercise the exact affected path.
7. Run `npm run self-test` and any focused diagnostic verifier.

`npm run launch:replace` deliberately closes only processes whose executable
path matches this project's copied runtime. It never targets the Store build.

## Native bridges first

The custom controls should call the same state owners and account-backed actions
as the upstream UI. Do not treat a click animation or local DOM change as proof
that a feature works. For each action, verify:

- The native bridge is present before enabling the control.
- The native snapshot confirms model, effort, service tier, route, or account
  state after the action.
- Rejection or missing capability returns the UI to the confirmed state.
- No message, upload, delete, or account mutation occurs in diagnostics unless
  the test explicitly uses a non-destructive dry-run bridge.

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
