// Command registry (IMPLEMENTATION §G): a new command is a new file, not a
// longer conditional. Each module default-exports { names, mod, cooldownMs,
// help, run }. Names are mapped to defs here; duplicates fail loudly at startup.
import create from './create.js';
import char from './char.js';
import bag from './bag.js';
import equip from './equip.js';
import unequip from './unequip.js';
import grab from './grab.js';
import raid from './raid.js';
import top from './top.js';
import exp from './mod/exp.js';
import mute from './mod/mute.js';
import drop from './mod/drop.js';
import drops from './mod/drops.js';
import boss from './mod/boss.js';
import raidnight from './mod/raidnight.js';
import season from './mod/season.js';

const defs = [create, char, bag, equip, unequip, grab, raid, top, exp, mute, drop, drops, boss, raidnight, season];

/** @type {Map<string, typeof defs[number]>} */
const byName = new Map();
for (const def of defs) {
  for (const name of def.names) {
    if (byName.has(name)) throw new Error(`duplicate command name registered: !${name}`);
    byName.set(name, def);
  }
}

/** Resolve a command def by (lowercased) trigger name, or undefined. */
export function getCommand(name) {
  return byName.get(name);
}

/** All command defs (deduped) — for help/introspection. */
export function listCommands() {
  return defs;
}
