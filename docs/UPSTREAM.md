# Upstream fingerprint

The private source package is the installed combined ChatGPT/Codex Windows app:

```text
Package family: OpenAI.Codex_2p2nqsd0c76g0
Package full name: OpenAI.Codex_26.707.9564.0_x64__2p2nqsd0c76g0
Package version: 26.707.9564.0
App version: 26.707.71524
Declared display name: ChatGPT
Entry executable: app/ChatGPT.exe
Protocol: codex://
UI bundle: app/resources/app.asar
```

The package manifest exposes the ChatGPT-branded shell and Codex protocol. The
desktop process runs as `ChatGPT.exe`, while Codex native runtimes live under
`app/resources/`.

`upstream.json` is the machine-readable fingerprint used by build and
verification scripts. A fresh `npm run setup` automatically opens Microsoft's
official signed ChatGPT installer if this package is not already available;
`npm run bootstrap:verify` validates that download without installing it. Run
`npm run upstream:check` to detect an installed Store update. After reviewing a
new package, close the custom copy and run
`npm run upstream:sync`; it stages a fresh isolated copy, requires every
compatibility needle to match, verifies the candidate, and rolls back the custom
snapshot if any step fails.

The repository never contains the copied package or extracted archive. Each user
creates those private files from their own official package with `npm run setup`.
