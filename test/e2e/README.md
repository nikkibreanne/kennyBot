# End-to-end command tests

These tests drive **every chat command through the real dispatcher**
(`src/events/chat.js`) against the Firebase emulator — the same path a live
Twitch message takes: parsing → mod/sub/mute gates → `def.run` → DB writes. If a
command breaks anywhere in that path, a test fails.

## Run it

```bash
npm run test:e2e            # emulator + the suite, then exit
npm run dev:all -- test     # same thing, via the dev harness
```

Requires the Firebase emulator deps (JDK 21+, `firebase-tools`), same as
`npm run test:emulator`. CI runs it on every release tag.

## Files

- **`harness.js`** — the fake `chat` driver. `makeBot()` gives you `send(user, text)`
  which runs one chat line through a real handler and returns the captured reply
  text. `user(id, opts)` builds a chat user (flags: `mod`, `broadcaster`, `sub`).
- **`scenarios.js`** — the `fixtures` (set up game state) and the `SCENARIOS` array
  (one entry per command).
- **`commands.e2e.test.js`** — the runner (`before`/`beforeEach` reset a clean
  emulator slate) + the **coverage** test.

## Adding a test when you add a command

The registry↔test sync is **automated**: `commands.e2e.test.js` has a coverage
test that reads `listCommands()` and fails if any command's primary name has no
scenario. So you can't forget — a new command without a scenario breaks the build.

To add one, append an entry to `SCENARIOS` in `scenarios.js`, keyed by your
command's **primary** name (`def.names[0]`):

```js
{
  command: 'mycmd',                       // must equal def.names[0]
  title: 'does the thing',
  run: async ({ bot, u, fx }) => {
    const alice = u('e2e_mycmd', { login: 'alice', name: 'Alice' });
    await fx.player(alice);               // set up any needed state via fixtures
    const reply = await bot.send(alice, '!mycmd arg');
    assert.match(reply, /expected reply/i);
    // ...and/or assert on DB state via the db helpers.
  },
}
```

### Fixtures (`fx.*`)

`player(u, class?)`, `loot(u, itemId)`, `wallet(u)`, `market(question?)` → id,
`drop(itemId?)`, `facts()`, `leaderboard(u, damage)`, `raidWeek({ bossName?, enlistUsers? })`.
Add more as new commands need new state — keep them in `scenarios.js`.

### Notes

- A **fresh handler is built per `send`**, so the per-user/per-command cooldown
  never trips across a multi-step scenario (e.g. a trade's open→counter→accept).
- `beforeEach` resets config to a clean slate (season `e2e`, passive EXP off, not
  muted, no active raid) and waits for the async config mirror to settle.
- Mod-only commands need `{ mod: true }` on the user; sub-only commands need
  `{ sub: true }` (the default).
