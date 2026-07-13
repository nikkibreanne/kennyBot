// TODO BOARD (/todo/) — Nikki's public, date-organized to-do list, controlled
// entirely from chat by mods/broadcaster (`!todo add|remove|list`). Items live at
// `todos/<id>` keyed by a short atomic counter (the easy chat target) and are
// client-READ-ONLY; the website groups them by day. All writes are Admin-SDK only.

import { database, PATHS, SERVER_TIMESTAMP } from './firebase.js';
import { config } from '../config.js';

const MIN_LEN = 1;
const MAX_LEN = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Bucket todos by the CHANNEL's local day (not UTC / the server's TZ) so "today"
// matches Nikki's wall clock. Reuses the raid-night time zone as the channel TZ.
const CHANNEL_TZ = config.raidNight?.timeZone || 'America/Los_Angeles';

/** YYYY-MM-DD for the given instant in the channel's time zone (now by default). */
export function channelDate(when = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CHANNEL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(when);
}

/** Normalize submitted text: collapse whitespace, trim. */
export function cleanTodoText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve an optional leading date token to a YYYY-MM-DD string, or null if the
 * token isn't a date (so the caller keeps it as part of the todo text). Accepts an
 * explicit `YYYY-MM-DD`, or the words `today` / `tomorrow` (in channel time).
 */
export function resolveDateToken(token) {
  const t = String(token || '').toLowerCase().trim();
  if (ISO_DATE.test(t)) return t;
  if (t === 'today') return channelDate();
  if (t === 'tomorrow') return channelDate(new Date(Date.now() + 86_400_000));
  return null;
}

/**
 * Add a to-do item. Date defaults to the channel's today when not given/invalid.
 * @returns {Promise<{ok:true,id:number,todo:object}|{ok:false,reason:string}>}
 */
export async function addTodo({ text, date, by }) {
  const clean = cleanTodoText(text);
  if (clean.length < MIN_LEN) return { ok: false, reason: 'empty' };
  if (clean.length > MAX_LEN) return { ok: false, reason: 'too-long' };
  const day = ISO_DATE.test(String(date || '')) ? date : channelDate();

  const counter = await database().ref(PATHS.todoCounter()).transaction((n) => (n || 0) + 1);
  const id = counter.snapshot.val();
  const todo = { id, text: clean, date: day, by: by || null, at: SERVER_TIMESTAMP };
  await database().ref(PATHS.todo(id)).set(todo);
  return { ok: true, id, todo: { ...todo, at: Date.now() } };
}

/** Remove a to-do by id. */
export async function removeTodo(id) {
  const ref = database().ref(PATHS.todo(id));
  const cur = (await ref.get()).val();
  if (!cur) return { ok: false, reason: 'not-found' };
  await ref.remove();
  return { ok: true, text: cur.text, date: cur.date };
}

/** All to-dos, sorted by date (soonest first) then creation order within a day. */
export async function listTodos(limit = 100) {
  const val = (await database().ref(PATHS.todos()).get()).val() || {};
  return Object.values(val)
    .filter((t) => t && t.text)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)))
    .slice(0, limit);
}
