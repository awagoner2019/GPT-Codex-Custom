# Installation

GPT + Codex Custom is distributed as maintained source, not as a modified copy
of OpenAI's desktop binaries. Setup obtains the official package through
Microsoft, creates private local working copies, builds the customization, and
verifies the result.

## Recommended: one-click setup

1. Download and extract the latest `gpt-codex-custom-update.zip` release asset.
2. Install [Node.js 20 or newer](https://nodejs.org/) if it is not already
   available.
3. Double-click `Install-GPT-Codex-Custom.cmd`.
4. If Microsoft's ChatGPT installer opens, select **Install** and leave the
   setup window open. Setup detects package registration and continues.
5. Choose whether to launch the verified custom runtime.

Setup creates `GPT-Codex-Custom.exe` in the extracted project and a per-user
**GPT + Codex Custom** Start Menu shortcut. Those are the normal, console-free
launch paths. The CMD installer is safe to run again; if the custom runtime is
already initialized, it repairs the launcher/shortcut if needed and offers to
open the existing copy instead of overwriting the private upstream snapshot.

## Manual setup

```powershell
npm ci
npm run setup
./GPT-Codex-Custom.exe
```

Use `npm run setup:no-bootstrap` on managed systems where an administrator has
already supplied `OpenAI.Codex` and automatic installer launch is unwanted.

## Installer trust chain

The bootstrap accepts only the pinned ChatGPT product URL on HTTPS
`get.microsoft.com` for Microsoft Store product `9PLM9XGG6VKS`. Before launch,
it requires all of the following:

- A bounded Windows PE executable rather than an HTML/error response.
- A valid Windows Authenticode signature.
- Signer and company identity `Microsoft Corporation`.
- Product identity `Store Installer`.

Downloads retry up to three times. A nonzero installer exit receives a short
registration grace period, registration has a bounded timeout, and every failure
leaves the official package untouched. Run the complete release gate with:

```powershell
npm run verify:installer
```

That command downloads and verifies the current official installer without
launching it, then simulates existing-package, fresh-install, cancellation,
timeout, untrusted-host, unsigned-payload, and transient-network paths.

## Normal launch

Use the Start Menu entry or double-click `GPT-Codex-Custom.exe`. The executable
is compiled as a Windows GUI application, starts the maintained launch pipeline
without a visible CMD/PowerShell window, and shows a native error dialog if
startup fails. Detailed output goes to `logs/launcher.log`.

Console output remains opt-in:

```powershell
./GPT-Codex-Custom.exe --console
./Start-GPT-Codex-Custom.cmd
npm run launch
```

Useful native-launcher arguments are `--replace`, `--no-update`,
`--diagnostics`, and `--self-test`. Run `GPT-Codex-Custom.exe --help` for the
complete list.

## What setup writes

Setup populates ignored local paths beneath this project:

- `vendor/package/` - pristine private package snapshot.
- `work/upstream-src/` - pristine extracted UI source.
- `work/runtime/` - rebuilt custom runtime.
- `GPT-Codex-Custom.exe` - locally compiled project-owned GUI launcher.
- `profile/` and `logs/` - isolated custom state and diagnostics.

It also creates
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\GPT + Codex Custom.lnk` for
the current user. Run `npm run shortcut` to repair it or
`npm run shortcut:remove` to remove only that shortcut.

Setup never writes beneath `C:\Program Files\WindowsApps` and never reuses the
normal ChatGPT/Codex profile.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Node.js or npm is missing | Install Node.js 20+ from `nodejs.org`, reopen the extracted folder, and rerun the installer. |
| Native launcher prerequisites are unavailable | Enable or repair Windows .NET Framework 4.8, then rerun setup. |
| Microsoft installer was cancelled | Rerun `Install-GPT-Codex-Custom.cmd` and complete the Microsoft prompt. |
| Package registration timed out | Finish or reopen the Microsoft installer, then rerun setup. Existing completed work is not overwritten. |
| Store access is blocked by policy | Ask the Windows administrator to make the official `OpenAI.Codex` package available, then use `npm run setup:no-bootstrap`. |
| Setup reports an existing isolated snapshot | Use the normal launcher. For an upstream refresh, close the custom app and run `npm run upstream:sync`. |
| Build reports a locked native module | Close the custom runtime and rerun setup/build. The official app may remain open. |
| Start Menu entry points to an old folder | Run `npm run shortcut` from the current project folder. |
| GUI launch fails without a console | Read `logs/launcher.log`, then use `GPT-Codex-Custom.exe --console` or `Start-GPT-Codex-Custom.cmd` for visible diagnostics. |
| A compatibility needle changed | The official app changed. Open an Issue with sanitized version and verification output; do not publish private package files. |

No installer can guarantee success across Store outages, organization policy,
unsupported Windows builds, or future upstream changes. This project instead
fails closed with specific recovery guidance and preserves the last verified
runtime.
