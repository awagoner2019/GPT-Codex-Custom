# GPT + Codex Custom

An unofficial, isolated UI customization layer for the combined ChatGPT/Codex
Windows desktop app.

This repository contains only the customization source, build scripts, updater,
tests, and documentation. It does **not** redistribute OpenAI binaries, the
installed app's source archive, account data, cookies, conversations, credentials,
or any local Codex profile. Setup makes a private working copy from the app already
installed for your Windows account. If it is missing, setup downloads and verifies
Microsoft's official signed ChatGPT installer, opens it, and resumes automatically
after the package is ready. The official package remains read-only.

> [!IMPORTANT]
> This is an independent community project. It is not an OpenAI release and is
> not supported or endorsed by OpenAI. You are responsible for complying with
> the terms that apply to the official app and service.

## What it adds

- A first-class **Chat** product beside the app's existing Work and Codex modes.
- A ChatGPT-style left rail with New chat, account-backed history, search,
  Library, Projects, Scheduled, Plugins, pinned/recent chats, profile controls,
  and per-chat Share, Rename, Pin/Unpin, Archive, and confirmed Delete actions.
- Persistent Chat/Work/Codex switching after a conversation is open.
- Sent-message editing through the app's native branch/regenerate path.
- A reliable full-screen generated-image viewer with zoom, keyboard/backdrop
  close, focus restoration, and edit handoff through the native attachment and
  `picture_v2` workflow.
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
- Internet access and the Windows App Installer/Store service for first setup.
- Access to the official combined ChatGPT/Codex package as `OpenAI.Codex`.
  You do not need to browse to the Store or install it before running setup;
  setup opens Microsoft's official signed installer automatically when needed.
- PowerShell 5.1 or newer.
- Node.js 20 or newer with npm.
- Enough free disk space for a private copy of the installed app.

## Fresh setup

Recommended release install:

1. Download and extract `gpt-codex-custom-update.zip` from the latest release.
2. Double-click `Install-GPT-Codex-Custom.cmd`.

The setup checks Node.js/npm, installs the pinned build dependency, opens
Microsoft's verified ChatGPT installer only when required, builds the isolated
runtime, runs verification, and offers to launch it. See
[Installation](docs/INSTALLATION.md) for the trust chain and recovery guide.

Manual source setup:

```powershell
git clone https://github.com/awagoner2019/GPT-Codex-Custom.git
cd GPT-Codex-Custom
npm ci
npm run setup
npm run launch
```

`npm run setup` first detects the official package. If it is absent, setup
downloads the installer only from Microsoft's pinned ChatGPT product URL,
requires a valid Microsoft Authenticode signature and Store Installer identity,
opens that installer, and waits for package registration. It then copies the
official app into this repository's ignored `vendor/` and `work/` directories,
verifies the copied hashes, extracts the private upstream snapshot, builds the
custom archive, and runs the static verification gate. It refuses to overwrite
an existing local snapshot.

To test the download and signature gate without installing anything:

```powershell
npm run bootstrap:verify
```

For managed/offline systems where an administrator supplies the official
package separately, `npm run setup:no-bootstrap` disables the automatic
installer and fails if `OpenAI.Codex` is unavailable.

## Why releases contain no standalone OpenAI payload

OpenAI's current terms do not grant this project permission to redistribute a
modified copy of the desktop app or its licensed binaries. Releases therefore
contain only the independently maintained customization and setup code. The
one-command bootstrap is the closest non-redistributing deployment model: each
user obtains the official package from Microsoft under their own account, and
the repository never hosts that payload. See the
[OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) and
[OpenAI Service Terms](https://openai.com/policies/service-terms/).

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
npm run verify:installer
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

The self-test exercises the real custom renderer without sending a message,
publishing a share link, or changing/deleting a chat. It covers product
switching, history/search, New chat, Share/Rename/Pin/Archive/Delete dry-runs,
full-screen image open/close/focus restoration, native image attachment staging,
Library routing, model picker state, token HUD state, and pinboard storage.
Diagnostic endpoints bind only to loopback and exist only for the isolated
custom profile.

See the sanitized [Feature showcase](docs/SHOWCASE.md) for the current model
matrix, token dock, and persistent Chat/Work/Codex selector.

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
