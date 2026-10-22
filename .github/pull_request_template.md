## Summary

Describe what changed and why. If this closes an issue, add `Closes #N` so it auto-closes on merge to `trunk`.

## Verification

Run the gates in [AGENTS.md](https://github.com/thomasfosterau/effect-document/blob/trunk/AGENTS.md#verification) and list each command with its final pass/fail. If a gate could not run, say which and why.

## Changeset

Name the changeset(s) under `.changeset/`, or say why none is needed (see [AGENTS.md](https://github.com/thomasfosterau/effect-document/blob/trunk/AGENTS.md#branches-and-pull-requests)).

## Notes

Anything reviewers should pay special attention to: exported signatures, a profile that now admits (or drops) a feature, a change to what a reader emits or a writer accepts, peer ranges, `sideEffects: false` (no top-level statements in `dist/`).
