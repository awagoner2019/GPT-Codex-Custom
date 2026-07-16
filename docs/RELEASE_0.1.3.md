# GPT + Codex Custom v0.1.3

This release completes the native Chat conversation menu and replaces the
combined desktop app's unreliable generated-image click path with a dedicated
full-screen viewer.

## New

- Saved chats now expose Share, Rename, Pin/Unpin, Archive, and confirmed Delete
  actions through the desktop app's account-backed conversation service.
- Unsupported native actions disable individually instead of presenting a local
  control that cannot complete its server-side operation.
- Share clearly confirms that it creates a public anonymous link and copies the
  returned URL after the native service succeeds.
- Generated-image thumbnails now open a full-screen viewer in Chat mode with
  zoom controls, double-click zoom, Escape/backdrop dismissal, focus trapping,
  and focus restoration.
- Edit image from the viewer stages the generated image through the native
  attachment service and restores the `picture_v2` composer hint.
- The copied upstream message editor now guards Cancel and successful Submit
  against an upstream draft callback that could immediately reopen the editor.

## Verification

- Custom renderer strict self-test: 69/69 required outcomes passed.
- Read-only interactive UI suite: 20/20 required checks passed.
- Share, Rename, Pin, Archive, and Delete bridge paths: passed through
  non-mutating dry runs; no account conversation was changed.
- Generated-image full-view open, close, zoom readiness, focus restoration, and
  native temporary attachment staging: passed.
- Static package/runtime integrity, model-picker motion, token dock, and updater
  safety checks: passed.

The release contains no OpenAI executable, copied ASAR, account data, cookies,
credentials, chats, profile, or local package snapshot. The installed Microsoft
Store package remains read-only.
