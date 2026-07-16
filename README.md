# GPT + Codex Custom

An unofficial, isolated UI customization layer for the combined ChatGPT/Codex
Windows desktop app.

This repository contains only the customization source, build scripts, updater,
tests, and documentation. It does **not** redistribute OpenAI binaries, the
installed app's source archive, account data, cookies, conversations, credentials,
or any local Codex profile. Setup makes a private working copy from the app already
installed on your own PC. The Microsoft Store/MSIX installation remains read-only.

> [!IMPORTANT]
> This is an independent community project. It is not an OpenAI release and is
> not supported or endorsed by OpenAI. You are responsible for complying with
> the terms that apply to the official app and service.

## What it adds

- A first-class **Chat** product beside the app's existing Work and Codex modes.
- A ChatGPT-style left rail with New chat, account-backed history, search,
  Library, Projects, Scheduled, Plugins, pinned/recent chats, profile controls,
  and per-chat delete confirmation.
- Persistent Chat/Work/Codex switching after a conversation is open.
- Sent-message editing through the app's native branch/regenerate path.
- Generated-image edit handoff through the native attachment and `picture_v2`
  workflow, while preserving the app's full-screen image viewer.
- A fluid account-backed model/effort matrix, a separate Ultra lever with moving
  particles, and the native Fast tier with a lightning activation effect.
- A right-edge token dock for input, output, thinking, total, source precision,
  and context-window use. Server values are shown as exact when the app exposes
  them; Chat-only estimates are labeled estimated.
- A cross-mode pinboard stored only in the custom copy's isolated Chromium
  profile.
- An opt-in-safe source updater with release checks, SHA-256 and per-file
  verification, a strict path allowlist, local-change protection, backup,
  rebuild/verification, and rollback.

The current desktop package exposes dictation, but not the newest ChatGPT voice
session transport. This project intentionally does not present a substitute as
advanced/live voice. Deep Research and every web-only ChatGPT integration are
also outside the current desktop bridge.

## Safety boundary

The project never edits the installed package under `WindowsApps` and never uses
the normal app profile. Generated/private paths are deliberately excluded from
Git and release packages:

| Path | Purpose | Published? |
| --- | --- | --- |
| `custom/` | Maintained CSS/JavaScript UI modules | Yes |
| `scripts/` | Build, launch, update, and verification tools | Yes |
| `docs/` | Architecture and modification guidance | Yes |
| `vendor/package/` | Private copy of the installed package | No |
| `work/upstream-src/` | Private extracted upstream archive | No |
| `work/runtime/` | Independently launchable custom copy | No |
| `profile/` | Isolated account and Codex profile state | No |
| `logs/`, `updates/`, `dist/` | Local generated state | No |

## Requirements

- Windows 10 or 11.
- The current official combined ChatGPT/Codex Microsoft Store app installed as
  package `OpenAI.Codex`.
- PowerShell 5.1 or newer.
- Node.js 20 or newer with npm.
- Enough free disk space for a private copy of the installed app.

## Fresh setup

```powershell
git clone https://github.com/awagoner2019/GPT-Codex-Custom.git
cd GPT-Codex-Custom
npm ci
npm run setup
npm run launch
```

`npm run setup` copies the installed app into this repository's ignored
`vendor/` and `work/` directories, verifies the copied hashes, extracts the
private upstream snapshot, builds the custom archive, and runs the static
verification gate. It refuses to overwrite an existing local snapshot.

After a successful setup, `Start-GPT-Codex-Custom.cmd` launches the custom copy.
The normal launcher checks for a custom-source update at most once every 24
hours. `npm run launch:no-update` skips that check.

## Normal development loop

```powershell
npm run upstream:check
npm run build
npm run verify
npm run launch:replace
```

Edit the maintained modules under `custom/`, then rebuild. The build patches only
the private runtime under `work/runtime/`. Read [Modifying the UI](docs/MODIFYING.md)
before changing selectors or adding a module, and see [Architecture](docs/ARCHITECTURE.md)
for the native bridge design.

When the Store app changes, close the custom copy and run:

```powershell
npm run upstream:check
npm run upstream:sync
```

The sync command stages a new private copy, checks every compatibility needle,
builds it, verifies it, and rolls back the isolated snapshot if compatibility
fails. It never writes to the Store installation.

## Verification

Static and release-safe checks:

```powershell
npm run verify
npm run verify:update
npm run verify:motion
npm run verify:token-dock
```

Runtime checks:

```powershell
npm run self-test
npm run launch:diagnostics
npm run verify:interactive
```

The self-test exercises the real custom renderer without sending a message or
deleting a chat. It covers product switching, history/search, New chat, edit and
delete dry-runs, image attachment staging, Library routing, model picker state,
token HUD state, and pinboard storage. Diagnostic endpoints bind only to
loopback and exist only for the isolated custom profile.

## Custom source updates

```powershell
npm run update:check
npm run update:apply
```

Normal launches use `Auto` mode. An update is applied only when all of these are
true:

1. A newer stable GitHub release exists.
2. The custom runtime is closed.
3. Tracked source has no local changes (unless a manual maintainer deliberately
   uses `-Force`).
4. The archive matches its published SHA-256 checksum.
5. Every archived file is present in the release manifest, has the expected
   per-file hash, and belongs to the maintained-source allowlist.
6. `npm ci`, the custom build, and static verification all pass.

The updater backs up the previous maintained source beneath ignored `updates/`
and restores it if the build or verification fails. It never replaces
`vendor/`, `work/`, `profile/`, or `logs/`. See [Updates and releases](docs/UPDATES.md)
for the complete trust model and release procedure.

## Current upstream fingerprint

- Package: `OpenAI.Codex_26.707.9564.0_x64__2p2nqsd0c76g0`
- Package version: `26.707.9564.0`
- App version: `26.707.71524`
- UI archive SHA-256: `7F276BD33EC415B075038D4FC5B019045E20207716F919710E9A3CAD02A7A776`
- Launcher SHA-256: `28C3E8B6C55FFF39ECB12A5EB27F493ABF997804247517AA7A46C277CA5D9E93`

`upstream.json` is the machine-readable source of truth. These values identify
the maintainer's compatibility baseline; each user still creates their own local
copy from their installed package.

## Repository governance

Only the repository owner can push source or publish releases. Everyone else may
open Issues and propose pull requests from forks; neither action grants direct
write access. `CODEOWNERS` routes changes to `@awagoner2019`, and the release
workflow accepts owner-created version tags only.

See [Contributing](CONTRIBUTING.md) before opening a pull request and
[Security](SECURITY.md) before reporting sensitive behavior.
