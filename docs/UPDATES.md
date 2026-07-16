# Updates and releases

There are two independent update paths:

- **Upstream sync** copies a newer installed OpenAI package into private local
  `vendor/` and `work/` paths and revalidates compatibility.
- **Custom source update** downloads a newer release of this repository's
  maintained CSS, JavaScript, scripts, and documentation.

Neither path modifies the installed Microsoft Store/MSIX package.

## User commands

```powershell
npm run update:check
npm run update:apply
npm run launch:no-update
```

The normal launcher checks at most once per `checkIntervalHours` from
`config/update.json`. A network failure is a warning and never prevents the last
verified custom runtime from opening.

Automatic apply is skipped when tracked Git files differ or a committed release
manifest detects local edits. Manual `-Force` exists for maintainers but should
not be used without a backup. The custom runtime must be closed before source is
applied and rebuilt.

## Package validation

`scripts/New-UpdatePackage.ps1` packages an explicit top-level file list plus
`config/update.json` and the maintained `.github`, `custom`, `docs`, and
`scripts` roots. The
archive contains a generated `release-manifest.json` with a SHA-256 and byte
length for every file.

`scripts/Update-Custom.ps1` requires:

- A stable semantic-version release newer than `package.json`.
- The configured ZIP and checksum assets.
- A matching archive SHA-256.
- Manifest schema/project/version agreement.
- A matching per-file SHA-256 for every entry.
- No duplicate, unlisted, absolute, parent-traversal, or non-allowlisted path.
- A closed custom runtime and unmodified local source unless explicitly forced.

After applying source, it runs `npm ci`, `npm run build`, and `npm run verify`.
Failure restores the prior maintained source and attempts to rebuild it. Private
generated state is never part of the archive or rollback set.
The machine-specific `upstream.json` is also preserved; upstream compatibility
changes are handled only by the separate upstream-sync path.

## Owner release procedure

Only the repository owner should perform these steps:

1. Finish and verify the source change.
2. Set a new semantic version in `package.json` and `package-lock.json`.
3. Run `npm run verify:update`, `npm run build`, and `npm run verify`.
4. Commit and push the reviewed source to `main`.
5. Create and push an annotated or lightweight tag matching the version, such
   as `v0.2.0`.

The `publish-release.yml` workflow runs only for an owner-created version tag,
verifies the tag/version match, reruns the updater tests, creates the allowlisted
archive, and publishes the ZIP plus checksum through GitHub Releases. Pull
requests and non-owner actors cannot invoke the publication job.

## Disabling or redirecting checks locally

Set `enabled` to `false` in ignored `config/update.local.json`:

```json
{
  "enabled": false
}
```

Maintainers can override other update configuration fields in the same ignored
file without changing the repository default. Do not point users at an
untrusted release repository.
