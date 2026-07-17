# GPT + Codex Custom v0.1.4

This release makes the isolated custom copy behave like a normal Windows app at
startup and updates the reviewed compatibility baseline for the current combined
ChatGPT/Codex desktop package.

## Changes

- Adds a project-owned `GPT-Codex-Custom.exe` compiled with the Windows GUI
  subsystem, so normal startup has no CMD or PowerShell window.
- Adds a custom launcher icon, native startup-failure dialog, UTF-8 launcher log,
  concurrent-start guard, and a parent-exit handoff that allows source updates to
  rebuild the EXE safely.
- Adds a per-user **GPT + Codex Custom** Start Menu shortcut. CMD, visible
  PowerShell, diagnostics, and self-test entry points remain explicit options.
- Adds reproducible launcher build and verification scripts. The generated EXE
  is local build output and is not included in Git or source-update archives.
- Updates the compatibility baseline to package `26.707.9981.0`, app
  `26.707.72221`, with an explicit fail-closed `Pk.useRef` composer bridge.
- Strengthens message-edit verification with a harmless unsent sentinel instead
  of comparing rich-text DOM text to serialized Markdown.
- Makes transient Chat diagnostic preparation retry renderer-evaluation startup
  exceptions while preserving the existing hard readiness timeout.
- Corrects the model-picker opening-motion assertion to recognize intermediate
  transform frames as well as intermediate opacity frames.
- Keeps the composer trigger's complete model and effort label visible in Chat,
  Work, and Codex, and recolors both lightning glyphs purple while Ultra is active.
- Splits mixed Chat catalog groups into their exact public model identities, so
  the `5.5 Instant` fallback remains under GPT-5.5 and cannot appear as a
  fabricated GPT-5.6 Instant option. Unknown combinations now fail closed.

## Verification completed

- Native launcher contract: 10/10 checks passed.
- Real EXE launch: exit code 0, no visible PowerShell window, no project CMD
  process, and the exact isolated `work/runtime/ChatGPT.exe` path started.
- Official installer/bootstrap suite: 8/8 scenarios passed.
- Strict renderer self-test: 69/69 required outcomes passed.
- Consolidated live UI suite: passed, including account-backed Chat actions,
  model motion, Ultra/Fast effects, token docking, and normal-launch restoration.
- Static runtime/upstream hash verification: passed.
- Source updater archive/rollback/private-state suite: passed.

The release contains no OpenAI executable, copied ASAR, account data, cookies,
credentials, conversations, or local Codex profile.
