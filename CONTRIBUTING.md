# Contributing

Issues and pull requests are welcome. This project modifies an isolated local
copy of the combined ChatGPT/Codex Windows app; it must never publish OpenAI
binaries, extracted upstream source, or user data.

## Before filing an issue

Search existing Issues, then include:

- The custom project version from `package.json`.
- The installed package and app versions from `upstream.json`.
- The selected product mode: Chat, Work, or Codex.
- Reproduction steps and the expected/actual result.
- Static verifier output from `npm run verify` when relevant.

Redact chat text, account details, filesystem usernames, tokens, cookies, and
other private data. Do not upload `profile/`, `logs/`, `work/`, or `vendor/`.

## Pull-request workflow

1. Fork the repository and create a focused branch.
2. Run `npm ci`.
3. Make changes only in maintained source such as `custom/`, `scripts/`,
   `docs/`, or `.github/`.
4. Run `npm run verify:installer` and `npm run verify:update` in a clean source
   checkout.
5. If you have initialized a private runtime, also run `npm run build` and
   `npm run verify`. Run the relevant interactive checks for UI behavior.
6. Explain the native behavior used, the compatibility assumptions, and the
   checks you ran.

Do not commit generated or private directories. The repository intentionally
ignores `vendor/`, `work/`, `profile/`, `logs/`, `updates/`, `dist/`,
`node_modules/`, and local workspace context.

## UI compatibility

The upstream renderer is minified and changes frequently. Prefer semantic
attributes, native state/action bridges, and narrow compatibility needles over
broad DOM replacements. A fallback must fail closed: if the expected native
bridge is unavailable, disable the control instead of simulating a successful
account action.

When adding or changing a feature, update the strict checks in
`scripts/Verify-Custom.ps1` and, where appropriate, the runtime self-test. A
visual match without a working native action is not considered complete.

## Releases

Only `@awagoner2019` publishes releases. Version tags must match
`package.json` exactly (`vX.Y.Z`). The owner-only release workflow packages the
maintained allowlist and publishes the ZIP plus its SHA-256 file. Pull requests
cannot publish an update.
