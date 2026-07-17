# GPT + Codex Custom agent instructions

This repository contains only the independently maintained customization,
build, verification, and update layers for an isolated copy of the combined
ChatGPT/Codex Windows desktop app.

## Hard boundaries

- Never edit the installed Microsoft Store/MSIX package.
- Never commit or publish `vendor/`, `work/`, `profile/`, `logs/`, `updates/`,
  `node_modules/`, cookies, account state, credentials, or chat content.
- Treat the installed app as a read-only input. Setup may acquire it only through
  the pinned official Microsoft installer and must verify that installer before
  launch; never mirror or redistribute the package payload.
- Keep the copied executable byte-identical to upstream. Customization belongs
  in the copied `app.asar` and project-owned launch/profile configuration.
- Do not replace exact-match upstream bridges with broad, uncertain patches.
  A changed upstream byte sequence must fail closed and be reviewed.
- Other contributors may be working in the tree. Do not revert unrelated work.

## Where to work

- Renderer customization: `custom/`
- Build, launch, verification, setup, and updater logic: `scripts/`
- Public technical explanation: `README.md` and `docs/`
- GitHub automation and issue forms: `.github/`

Do not hand-edit generated files beneath `work/`.

## Verification

For normal UI changes:

```powershell
npm run build
npm run verify
npm run verify:ui-suite
```

For update-system changes:

```powershell
npm run verify:update
```

For native-launcher changes:

```powershell
npm run build:launcher
npm run verify:launcher
```

When a live account-backed UI check is required, use the documented diagnostic
and self-test commands. Tests must not send chat messages, upload personal
files, or perform destructive account actions. Read `docs/TESTING.md` before
adding a verifier or using a diagnostic endpoint directly.
