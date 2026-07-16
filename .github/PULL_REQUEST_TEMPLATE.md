## Summary

Describe the behavior changed and why it belongs in the isolated customization
layer.

## Native behavior and compatibility

- Which shipped desktop state owner, callback, or service does this use?
- Which exact upstream compatibility needle or semantic selector changed?
- How does the control fail closed when that capability is unavailable?

Do not paste extracted upstream source. A short description of the contract is
enough.

## Verification

List the commands run and their results. Use [the testing guide](../docs/TESTING.md)
to select the relevant gates.

- [ ] `npm run build`
- [ ] `npm run verify`
- [ ] `npm run verify:ui-suite` for live UI behavior
- [ ] `npm run verify:update` for packaged-source or updater changes
- [ ] `npm run verify:installer` for setup/bootstrap changes
- [ ] A focused verifier covers the changed behavior
- [ ] Documentation and strict assertions were updated where needed

## Privacy and release boundary

- [ ] No OpenAI binary, copied ASAR, extracted upstream source, chat content,
      account state, cookie, credential, personal file, profile, log, or generated
      runtime is included.
- [ ] The installed Store package and normal profile were not modified.
- [ ] Screenshots and diagnostic output are sanitized.
