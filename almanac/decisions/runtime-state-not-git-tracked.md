---
title: "Runtime state must not write git-tracked files"
topics: [decisions]
sources:
  - id: voice-pin-incident
    type: file
    path: src/voice/voice-pin.js
  - id: voice-models-overlay
    type: file
    path: src/voice/voice-models.js
  - id: voice-pin-test
    type: file
    path: tests/voice-pin-overlay.test.mjs
  - id: gitignore
    type: file
    path: .gitignore
---

# Runtime state must not write git-tracked files

An application must never write a git-tracked file at runtime.

## Context

State that the application discovers or the user generates at runtime belongs in a git-ignored location, never in a file the repo also ships and updates through deliberate commits. If both the repo and the application modify the same file, they collide at `git pull`: the user encounters "Your local changes to [file] would be overwritten by merge" — a file they never knowingly edited. The user is blocked, often on a file they have no idea how it changed. The blockage appears random to them and is dangerous to unblock without understanding it.

This happened with the voice subsystem's optional speaker model installs. `voice-pin.js`'s `pinAndInstallModel()` function, called when a ward installs a speaker model like CAM++ or TitaNet in-UI, recorded its trust-on-first-install pin by writing into the git-tracked `voice-model-pins.json`. Every machine that did an in-UI speaker install silently dirtied its working copy. The next `git pull` that touched the pins file aborted, blocking the user entirely from pulling updates. It was latent for any user who had installed a model in-UI — not obvious until they tried to update and the command failed.

## Decision

Separate shipped state from runtime state into different files. Ship the application's default state in a git-tracked file, updated only through deliberate commits. When the application discovers or the user generates state at runtime, write it to a git-ignored file. Merge both at runtime so the application sees the complete picture, with runtime state winning in case of conflict per id or key.

The shipped file is the maintainer's authority for what the application ships with. The git-ignored file is the ward's authority for what they have chosen or installed locally. Absence of either file is normal.

## Consequences

**Positive:**

- The ward's working copy never becomes dirty due to in-app actions, so `git pull` stays available as an update path
- The user remains unblocked from pulling critical security or stability updates
- The distinction between what ships and what's local is clear in the codebase: two files, two git states, one merge point
- The pattern is reusable for any state the app discovers at runtime

**Negative or deferred:**

- The application must implement a merge strategy (even a simple one) at the loading seam
- If either file is missing it is normal, not an error — defensive code is required to handle absence gracefully
- The ward cannot commit or share their local customizations through git
- If the overlay file is accidentally committed (through a `.gitignore` miss), it will shadow the shipped file for that repository clone until removed

**Neutral:**

- Runtime state is not automatically backed up or synced — only the shipped state is version-controlled. This is intentional: the shipped state is the ward's recovery point, and runtime state is local-only by design.

The voice subsystem's `voice-models.js`'s `mergePinTables()` function [@voice-models-overlay] is an example of the merge strategy: a pure function that accepts multiple tables and returns a merged object with later tables winning per key [@voice-models-overlay]. `voice-pin.js` writes only to the git-ignored overlay and never touches the tracked file at runtime [@voice-pin-incident]. Tests assert both the merge behavior and that the overlay is properly git-ignored [@voice-pin-test] (`.gitignore` covers both `voice-model-pins.local.json` and its `.tmp` rename target [@gitignore]).
