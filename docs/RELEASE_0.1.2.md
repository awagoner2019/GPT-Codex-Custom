# GPT + Codex Custom v0.1.2

This release removes the manual Microsoft Store prerequisite from first setup
without redistributing OpenAI binaries.

## New

- `Install-GPT-Codex-Custom.cmd` provides a double-click setup and launch flow.
- Missing `OpenAI.Codex` packages automatically open Microsoft's official signed
  ChatGPT installer for product `9PLM9XGG6VKS`.
- The bootstrap pins the Microsoft host/product path and validates PE structure,
  Authenticode signer, company, and Store Installer identity before launch.
- Downloads retry safely; cancellation, failed registration, and timeout paths
  now have bounded waits and actionable recovery messages.
- `npm run verify:installer` runs eight live/simulated installer checks and is
  enforced by GitHub Actions.
- Installation and feature-showcase documentation now covers setup, privacy,
  recovery, screenshots, and the no-binary release boundary.

## Verification

- Official signed installer download: passed.
- Installer bootstrap scenarios: 8/8 passed.
- Extracted release ZIP first-run setup in an empty temporary directory: passed.
- Custom renderer self-test: 60/60 required outcomes passed.
- Static package/runtime integrity: passed.
- Update archive, rollback, and private-state preservation: passed.
- Workspace health: 100/100.

The release still contains no OpenAI executable, copied ASAR, account data,
cookies, credentials, chats, profile, or local package snapshot.
