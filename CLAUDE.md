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

Invariants (each has a test): `CLIP_MODE` defaults to `local` and never silently
falls back to Twitch · capture failure never breaks chat · chat replies leak nothing
about the capture rig · the capture rate limit is channel-wide, not per-user.

## Repo conventions

- **Public repo.** No real addresses, hostnames, or credentials — placeholders only
  (`ws://<obs-host>:4455`). Private notes go in `.workspace/` (gitignored).
- **Conventional Commits, enforced on PR titles** (`pr-title` check). Merges are
  squash-only, so the PR title becomes the commit release-please parses to pick the
  next version. See the README's "Releasing" section.
- **`main` is protected for everyone including admins.** No direct pushes; everything
  goes through a PR that passed `ci / test`.
- Tests: `npm test` (offline) · `npm run test:emulator` · `npm run test:e2e`.
