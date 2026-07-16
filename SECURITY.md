# Security policy

## Scope

Security reports are useful for the maintained customization source, launcher,
update path, diagnostics bridge, and local-data handling. The official OpenAI
app and service are upstream products and should be reported through OpenAI's
official security process.

## Reporting

Do not put credentials, cookies, conversation content, profile archives, or an
exploitable proof containing private data in a public Issue.

Use GitHub's private **Report a vulnerability** flow when it is available in the
repository Security tab. If it is unavailable, open a minimal Issue asking the
owner for a private reporting channel without including sensitive details.

Include the project version, installed upstream version, affected component,
impact, reproduction conditions, and a safe proof of concept.

## Updater trust model

The updater accepts only stable releases from the repository configured in
`config/update.json`. It validates the release ZIP against a separately
published SHA-256 value, validates every file against `release-manifest.json`,
and rejects paths outside the maintained-source allowlist. It also refuses to
overwrite local source changes or update a running custom runtime by default.

The GitHub repository owner account and its release workflow remain the root of
trust. A checksum hosted by the same compromised account is not a substitute
for an independent code-signing key. Protect the owner account with strong
multi-factor authentication and review release workflow changes carefully.
