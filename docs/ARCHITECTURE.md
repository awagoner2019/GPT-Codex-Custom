# Reverse-engineered application map

## Packaging

The combined GPT/Codex Windows app is distributed as the MSIX package
`OpenAI.Codex`, but its manifest display name and entry executable are still
`ChatGPT` and `app/ChatGPT.exe`. The package registers the `codex://` protocol.

The application payload is a Chromium shell named Owl. Its metadata says it was
packaged from an Electron output directory, and the extracted package declares
Electron 42.1.0.

### First-run acquisition

The repository never carries the MSIX payload. `npm run setup` first looks for
the user's official `OpenAI.Codex` package. When it is absent,
`scripts/Ensure-OfficialPackage.ps1` downloads Microsoft's Store Installer from
the pinned ChatGPT product ID `9PLM9XGG6VKS`, accepts only HTTPS on
`get.microsoft.com`, validates the PE header, size, Microsoft Authenticode
signature, company, and Store Installer product identity, then opens it. Setup
waits for Windows to register `OpenAI.Codex` before it stages the private copy.

`npm run bootstrap:verify` exercises the same download and trust checks, deletes
the temporary file, and never launches the installer. This removes the manual
Store-navigation prerequisite without redistributing or directly registering an
OpenAI package.

## Runtime layers

```text
ChatGPT.exe / Chromium shell
  -> resources/app.asar
       -> .vite/build/early-bootstrap.js       main-process bootstrap
       -> .vite/build/main-*.js                desktop process and IPC
       -> .vite/build/preload.js               renderer bridge
       -> webview/index.html                   main GPT/Codex renderer
       -> webview/assets/app-*.css             compiled global styling
       -> webview/assets/app-main-*.js         compiled React application
  -> resources/codex.exe                       native Codex runtime
  -> resources/codex-code-mode-host.exe        code-mode host
  -> resources/cua_node/                       bundled computer-use runtime
```

## Customization strategy

The hashed Vite assets are compiled and minified, so direct edits would be
brittle across updates. This project instead injects four versioned,
same-origin CSS/module pairs into `webview/index.html`:

- `assets/gpt-codex-custom.css`
- `assets/gpt-codex-custom.js`
- `assets/gpt-codex-token-hud.css`
- `assets/gpt-codex-token-hud.js`
- `assets/gpt-codex-pinboard.css`
- `assets/gpt-codex-pinboard.js`
- `assets/gpt-codex-model-picker.css`
- `assets/gpt-codex-model-picker.js`

The existing content-security policy permits self-hosted styles and module
scripts. The build starts from the pristine extracted tree every time, applies
the maintained override layer, and repacks only the working runtime.

Small exact-match bridges are also applied to pinned compiled components where
CSS/DOM enhancement is insufficient. They expose native product/navigation,
Chat history/session/profile and global conversation search state; register
Chat, Work, and Codex messages; forward server/composer token usage; expose the
filtered Work/Codex model catalog and native composer selection callback; and
support Chat message branching, account-backed conversation deletion, plus the
native image attachment composer. Every bridge
requires exactly one known upstream byte sequence, so an upstream layout change
fails the isolated rebuild instead of patching an uncertain target.

The custom model matrix replaces the visible shipped model trigger in all three
product modes. In Work/Codex, the exact native trigger remains mounted at its
original dimensions but is visually hidden, inert, and removed from the
accessibility tree. The custom trigger is body-mounted and fixed directly over
that preserved anchor, so React and the customization never compete for the
same footer children. This preserves account-backed state and callbacks without
rendering a second picker or causing layout oscillation. If no composer exists,
the shipped trigger is restored.

### Model picker

The renderer mounts one mode-aware picker against Chat's composer form or the
native Work/Codex `.composer-surface-chrome`. Chat uses the account-backed
conversation selector and presents Instant, Medium, High, Extra high, and Pro.
Work and Codex use the filtered native model catalog and composer setter; their
effort columns are generated from real account capabilities and currently read
Low, Medium, High, Extra high, and Max. Max never aliases Ultra: the separate
lever is available only when the catalog contains an explicit `ultra` effort.
The exact native bridge also forwards the account's Fast service-tier option and
setter. The custom switch remains non-optimistic: pending UI is separate from
checked state, and a lightning confirmation effect runs only after a matching
native snapshot. The shipped trigger is visually suppressed in every mode while
the replacement is mounted. Motion remains renderer-local and never becomes a
second source of model or service-tier state: the drag visual follows the pointer continuously,
release resolves to the nearest genuine account-backed stop, the native bridge
remains authoritative, and the next native snapshot animates to the confirmed
selection or rolls back smoothly. Panel
entry/exit is reversible, Ultra uses a short damped activation response plus a
contained moving particle field while engaged, and
the entire motion layer collapses to immediate updates under reduced-motion.

## Renderer data flows

### Token HUD

The build forwards Work/Codex `thread/tokenUsage/updated` events and active
composer token snapshots to the HUD as authoritative cumulative thread totals.
The HUD keys state by mode plus thread ID and displays available input/output
values as **Exact**. It separately preserves `last_token_usage` as exact current
context use, trusts the server-provided `total_tokens` value instead of
recalculating it, exposes cumulative and current `reasoning_output_tokens` as
Thinking without adding that subset to the total again, rejects stale
lower-priority composer regressions, and caches
only numeric Work/Codex snapshots in origin-local storage for restart recovery.
Chat establishes the same per-thread context but has no
equivalent exact usage feed in this integration, so rendered user and assistant
messages produce visibly **Estimated** input/output counts. The estimator stores
only character and token counts; missing telemetry remains unavailable.

The HUD host is a strict 14 px right-edge dock. Collision resolution searches
only vertically around the composer, pinboard, model picker, and modal overlays;
it never relocates into the left navigation or chat content. Expanding the
details card keeps the same right anchor so the panel grows inward. If no safe
vertical slot exists, the host becomes temporarily hidden until layout changes.

### Cross-mode pinboard

The pinned Chat and Work/Codex message renderers register user and assistant
messages with stable conversation, turn, and message IDs. Completed messages
can be copied into one drawer with All, Chat, Work, and Codex filters. Saved text
snapshots live in the renderer origin's IndexedDB database
`gpt-codex-custom-pinboard`, store `pins`, inside the isolated Chromium profile.
There is no network or diagnostics transport; Jump is offered only while a live
source message is mounted.

### Native Chat search

The native Chat search owner exposes the shipped `globalSearch` conversation
source to the custom rail. Queries are debounced, results can include content
snippets, cursor pagination supplies Load more, and selection returns through
the native conversation callback. Loaded-title filtering is only a fallback
when the native search bridge is unavailable.

### Native Chat deletion

The custom rail's saved-chat action menu calls the shipped conversation service's
`delete` method only after an explicit confirmation. The renderer removes the
deleted row and records a short-lived tombstone so a stale query snapshot cannot
immediately reinsert it; the tombstone clears once the authoritative history no
longer contains that conversation. The action suite verifies the full menu,
dialog, and bridge payload through a non-destructive dry-run branch.

### Advanced Voice boundary

The combined desktop package currently exposes native dictation but does not
ship the ChatGPT web product's Advanced Voice controls or transport. The public
developer surface for low-latency speech-to-speech is the Realtime API: a client
connects over WebRTC or WebSocket using a separately created session credential.
That is a new API conversation, not an embeddable handle to a user's ChatGPT
Advanced Voice session, account-selected web voice, or current Chat history
conversation. This project therefore does not present dictation plus local TTS
as "Voice mode" and does not depend on private ChatGPT web endpoints.

### Interactive diagnostics

`npm run launch:diagnostics` launches the isolated runtime with a random
loopback DevTools port recorded beneath `profile/chromium`. With that instance
running, `npm run verify:interactive` accepts only that isolated port file and
the exact `app://-/index.html` target, then performs read-only DOM and diagnostic
probe inspection. It validates custom Chat structure, search, token precision,
the pinboard's local-only contract, selector structure, and obvious geometry
collisions; native composer controls are observations rather than proof of their
end-to-end workflows. It never clicks, sends, uploads, regenerates, or starts
dictation. These checks do not establish Deep Research or full Voice support,
and this project makes no such capability claim.

`npm run verify:motion` is the deliberately interactive companion limited to
the model picker. It dispatches pointer input through the exact renderer,
samples intermediate computed geometry instead of checking only end states,
verifies interruption and reduced-motion semantics, and restores the starting
native choice before it exits.

The separate `npm run self-test` action suite deliberately exercises native
behavior. It opens multiple account conversations, creates a new local chat,
runs a real global-search query, validates the edit form through its real
conversation mapping and branch payload without submitting, visits each native
destination, and switches through Work and Codex while checking live HUD mode
attribution. Its generated-image probe uploads a synthetic PNG through the
native attachment service in temporary mode, requires a ready attachment and
the `picture_v2` hint, then removes the attachment and restores the prior hint.
No chat message is sent.

The copied executable remains byte-identical to upstream. Only the copied
`app.asar` and copied `owl-app.ini` change. The latter assigns the custom build
its own profile name, while the launcher also supplies a workspace-local
Chromium profile and `CODEX_HOME`.

The upstream bootstrap normally enforces one desktop instance. The build makes
that check conditional on `GPT_CODEX_CUSTOM_BUILD=1`, which is set only by the
custom launcher. This lets the copied client run beside the installed client
without changing the installed package or its single-instance behavior.
