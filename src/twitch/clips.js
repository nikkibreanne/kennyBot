// Twitch clip creation (Helix Create Clip). A small init-once service so command
// modules can make a clip without threading the ApiClient through the chat
// handler — the same shape as the db/* stores and configStore (infra is imported,
// not passed via ctx).
//
// Create Clip needs a USER token carrying the `clips:edit` scope, and the channel
// must be LIVE (Twitch rejects the call otherwise). We clip in the BOT user's
// context (apiClient.asUser) so the bot's own grant is used — the bot only has to
// be a normal user with clips:edit, no broadcaster involvement. The clip needs a
// few seconds to finish processing, but the returned URL is valid immediately.
//
// NOTE: a Twitch clip is capped at the STREAM resolution (≤1080p here). A full
// -quality local copy comes from a different mechanism entirely — see the README's
// "Two clip workflows" section; they are separate and neither feeds the other.

let createFn = null;

/**
 * @param {{ apiClient: import('@twurple/api').ApiClient, broadcasterId: string, botUserId: string }} deps
 */
export function initClips({ apiClient, broadcasterId, botUserId }) {
  createFn = () => apiClient.asUser(botUserId, (ctx) => ctx.clips.createClip({ channel: broadcasterId }));
}

/** Test seam: inject a fake clip creator that resolves to a clip id. */
export function initClipsWith(fn) {
  createFn = fn;
}

/** True once a clip creator (real or injected) is wired. */
export function clipsReady() {
  return typeof createFn === 'function';
}

/**
 * Create a clip of the channel's live stream.
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function createChannelClip() {
  if (!createFn) throw new Error('clips service not initialized');
  const id = await createFn();
  return { id, url: `https://clips.twitch.tv/${id}` };
}
