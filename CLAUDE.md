# kennyBot — working notes

## Clip architecture — read before changing anything clip-related

**[`docs/clip-architecture.md`](docs/clip-architecture.md) is authoritative.** Read it
before touching `!clip`, local capture, `!start`, or anything involving
okra-clip-archiver. It exists because this pipeline has been misunderstood
repeatedly, and every error came from contradicting a physical constraint listed
there.

The four that get forgotten most:

1. **A Twitch VOD is the broadcast** — capped at stream resolution. It is *never* a
   higher-quality source, so it can never be "the 4K version".
2. **The OBS canvas is the ceiling.** A 4K camera on a 1080p canvas is downscaled at
   the door; nothing downstream recovers it.
3. **The replay buffer holds only ~60s — there is no retroactive capture.** Reacting
   to viewer-created clips cannot work; the moment is gone before the clip exists.
4. **`!clip` capture and okra-clip-archiver are separate ingest paths** that share a
   processing stage. kennyBot never hands files to the archiver. The only thing it
   produces for it is the `!start` sync anchor, which is *data*, not a file handoff.

Invariants (each has a test): the clip mode defaults to `local` and never silently
falls back to Twitch · capture failure never breaks chat · chat replies leak nothing
about the capture rig · the capture rate limit is channel-wide, not per-user · the
vertical (Aitum Backtrack) capture reports `requested`, **never** `saved` — the
plugin answers `success` on acceptance and gives no way to confirm the write.

The clip mode is a **set of targets** — `horizontal` · `vertical` · `twitch`, combined
freely (`local`/`all`/`off` are aliases) — with **no env var**: it lives in RTDB
(`config/clipMode`), seeded once from `clip.defaultMode`, changed live via `!clipmode`.
`CAPTURE_VERTICAL_OUTPUT` is separate and says only what the vertical output is *named*.

When verifying a capture, **read OBS's own log** (`Wrote replay buffer to '…'`) —
not the vendor API's return value, and not a filesystem listing (WSL serves stale
metadata for `/mnt/c`, which has already caused one wrong diagnosis).

## Repo conventions

- **Public repo.** No real addresses, hostnames, or credentials — placeholders only
  (`ws://<obs-host>:4455`). Private notes go in `.workspace/` (gitignored).
- **The chase monitor's SOURCE ROSTER is private.** Never write an actual outlet name,
  YouTube channel id, handle, on-air personality or source feed URL anywhere in this
  repo — that means **code comments, JSDoc, test fixtures, sim data, docs, commit
  messages and PR titles**, not just config values. Refer to a source by its *class*
  (`chopper` · `newscast` · `episodic`) or an opaque id (`org1`). The real roster lives
  in `.workspace/chase-sources.json` and is loaded into RTDB by `npm run chase:sources`;
  `src/config.js` ships `orgs: []`. The *methodology* stays public — only the roster is
  secret. `test/rules/chase-privacy.test.js` enforces this in CI — it derives the
  forbidden names from the gitignored roster (so the list never enters the repo) and
  scans everything `git add -A` would stage. To check by hand:
  `git ls-files -co --exclude-standard | xargs grep -nE '\bUC[A-Za-z0-9_-]{22}\b'`
  — that must print nothing. Placeholders are kept deliberately SHORT (`UC-org1`) so
  this stays one rule with no exemptions. (A name grep will false-positive on hex in
  `package-lock.json`; the channel-id grep above does not.)
- **Conventional Commits, enforced on PR titles** (`pr-title` check). Merges are
  squash-only, so the PR title becomes the commit release-please parses to pick the
  next version. See the README's "Releasing" section.
- **`main` is protected for everyone including admins.** No direct pushes; everything
  goes through a PR that passed `ci / test`.
- Tests: `npm test` (offline) · `npm run test:emulator` · `npm run test:e2e`.
