// DEFAULT REMINDERS — the seed for config/reminders/<id>. Seeded once, never
// clobbered (src/db/reminders.js), so anything a mod changes from chat or in the
// console survives every deploy. Editing a default here only affects a database
// that has never seen that id.
//
// `channel` is what makes a reminder channel-specific: it fires only on that
// Twitch channel, and `channel: null` fires on whichever channel the bot runs
// in. That keeps "this one is a Nikki thing" a property of the data — no
// per-channel branch anywhere in the code.
//
// Schedule shapes are documented in src/rules/reminders.js; the knobs each kind
// reads are in docs/CONFIG.md.

export const DEFAULT_REMINDERS = [
  {
    id: 'wallpaper',
    enabled: true,
    channel: 'nikkibreanne',
    kind: 'afterLive',
    liveOnly: true,
    afterMs: 30 * 60_000, // half an hour into the stream
    text: '🖥️ Wallpaper Engine check — is it still running? Shut it down if you are done with it.',
  },
  {
    id: 'ghosty',
    enabled: true,
    channel: 'nikkibreanne',
    kind: 'daily',
    liveOnly: true, // no point announcing Ghosty's dinner to an empty channel
    timeZone: 'America/Los_Angeles',
    times: ['08:00', '17:00'],
    leadMs: 20 * 60_000, // heads-up at 07:40 / 16:40
    text: '🐾 Ghosty meal time! Go feed the beast.',
    leadText: '🐾 Heads up — Ghosty eats in 20 minutes.',
  },
  {
    id: 'hydration',
    enabled: true,
    channel: null, // every channel, not just Nikki's
    kind: 'interval',
    liveOnly: true,
    everyMs: 60 * 60_000,
    jitterMs: 10 * 60_000, // ±10 min so it never lands on the same beat twice
    text: '💧 Hydration check — go drink some water. Chat, you too. 🌱',
  },
];
