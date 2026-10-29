# patches/ — replayable snapshot of this fork's changes

These `.patch` files are `git format-patch <baseline>..HEAD` output for this
fork, committed so that a heavily rewritten upstream can be handled with
`git am` instead of a conflict-by-conflict rebase.

- **Baseline:** `0c24350` (upstream v0.5.0). Record the new baseline in the
  README's sync section after every successful sync, and pass it to
  `format-patch` the next time.
- **Not a second source of truth.** HEAD is authoritative; these files are a
  snapshot. `scripts/sync-upstream.sh` regenerates and commits them after every
  successful sync — regenerate by hand if you sync some other way:

  ```sh
  rm -f patches/*.patch
  git format-patch <baseline>..HEAD -o patches
  ```

- **Replay:**

  ```sh
  git fetch upstream main
  git reset --hard upstream/main
  git am patches/*.patch
  ```

  `git am --abort` returns to a clean tree if a hunk stops, so a failed replay
  leaves nothing half-applied.

- **Not published.** `patches/` is not in the npm `files` allowlist, so the
  tarball never ships it; this directory exists for source maintenance only.

See the README section "Staying in sync with upstream (fork maintenance)" for
the full procedure, including the per-file conflict table.
