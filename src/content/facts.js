// Curated "Nikki Fun Facts" — the canonical inside-joke set and the SINGLE source
// of truth for the curated facts. On boot the bot upserts these into Firebase
// `facts/` (see seedCuratedFacts in ../db/facts.js), where BOTH `!fact` and the
// /info/ page read them alongside viewer-submitted facts. The website's
// _data/facts.yml is only an offline snapshot/fallback — keep it in sync with this.
export const CURATED_FACTS = [
  "🎂 Freshly harvested every June 14th — and, for the record, a perpetual 25.",
  "Ghost, her mini Pomeranian, is the actual star of the channel. Nikki just works here. 🐾",
  "Her heart belongs to fictional men: Link, Leon Kennedy, and a rotating roster of anime boyfriends. 3D men could never. 💘",
  "Wayne the delivery robot is the one that got away. She's still not over it. 🤖💔",
  "Yes, she has a foot phone. Yes, it is a phone shaped like a foot. No further questions. 📞🦶",
  "Certified WoW Horde raider — Mythic+ is her cardio. Would uninstall before she'd roll Alliance. Who even plays Alliance? For the Horde, bby. 💀",
  "Her subscribers are Sith Lords. She's a clumsy ninja with Vader style. It all checks out.",
  "A real-deal LA actress — turns up on How I Met Your Mother, Workaholics, and in films with Bruce Willis.",
  "Raised by a Nintendo 64. Ocarina of Time and Majora's Mask did most of the parenting.",
  "Space-obsessed science geek, anime nerd, ex-NCAA golfer, and RC-car menace. The range is genuinely unhinged.",
  "Runs on horror and stealth in equal measure — Resident Evil screams and Metal Gear sneaking (and yes, more Leon).",
  "Will cosplay Harley Quinn at the faintest provocation.",
];
