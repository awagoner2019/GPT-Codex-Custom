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

The launcher is safe to run again. If the custom runtime is already initialized,
it offers to launch it instead of overwriting the private upstream snapshot.

## Manual setup

```powershell
npm ci
npm run setup
npm run launch
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

## What setup writes

Only ignored local paths beneath this project are populated:

- `vendor/package/` — pristine private package snapshot.
- `work/upstream-src/` — pristine extracted UI source.
- `work/runtime/` — rebuilt custom runtime.
- `profile/` and `logs/` — isolated custom state and diagnostics.

Setup never writes beneath `C:\Program Files\WindowsApps` and never reuses the
normal ChatGPT/Codex profile.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Node.js or npm is missing | Install Node.js 20+ from `nodejs.org`, reopen the extracted folder, and rerun the installer. |
| Microsoft installer was cancelled | Rerun `Install-GPT-Codex-Custom.cmd` and complete the Microsoft prompt. |
| Package registration timed out | Finish or reopen the Microsoft installer, then rerun setup. Existing completed work is not overwritten. |
| Store access is blocked by policy | Ask the Windows administrator to make the official `OpenAI.Codex` package available, then use `npm run setup:no-bootstrap`. |
| Setup reports an existing isolated snapshot | Use the normal launcher. For an upstream refresh, close the custom app and run `npm run upstream:sync`. |
| Build reports a locked native module | Close the custom runtime and rerun setup/build. The official app may remain open. |
| A compatibility needle changed | The official app changed. Open an Issue with sanitized version and verification output; do not publish private package files. |

No installer can guarantee success across Store outages, organization policy,
unsupported Windows builds, or future upstream changes. This project instead
fails closed with specific recovery guidance and preserves the last verified
runtime.
