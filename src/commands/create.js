// !create <class> — create a character + grant starter gear (spec §5.5, §11).
import { resolveClass, CLASS_NAMES, CLASSES } from '../content/classes.js';
import { createPlayer } from '../db/players.js';

export default {
  names: ['create'],
  mod: false,
  subOnly: true, // subscriber-only participation (spec §5.4 / owner decision)
  cooldownMs: 5_000,
  help: `!create <class> — choose one of: ${CLASS_NAMES.join(', ')}`,
  async run({ user, args, reply }) {
    const className = resolveClass(args[0] || '');
    if (!className) {
      reply(`@${user.displayName} choose a class — !create <${CLASS_NAMES.join('|')}>`);
      return;
    }

    const { created, player } = await createPlayer({
      userId: user.id,
      login: user.login,
      displayName: user.displayName,
      className,
    });

    if (!created) {
      reply(`@${user.displayName} you already play a ${player.class} (level ${player.level}). Try !char.`);
      return;
    }

    reply(
      `@${user.displayName} welcome — you are a ${player.class} (${player.role})! ` +
        `Starter gear equipped. ${CLASSES[className].blurb} Chat while live to grow.`,
    );
  },
};
