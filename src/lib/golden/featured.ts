/** The three golden scenarios offered in the UI; the full set still runs in the benchmark. */
export const FEATURED_GOLDEN = [
  { id: "GS-01", emoji: "🐢", short: "Routine slowdown", blurb: "One partner's systems slow down sharply. Textbook case — the rulebook knows exactly what this looks like." },
  { id: "GS-05", emoji: "🚦", short: "Rush hour", blurb: "Traffic doubles everywhere, one partner slows, and retail banking's reserved capacity is switched off. Lots going on, but every piece is in the rulebook." },
  { id: "GS-19", emoji: "🎲", short: "Mystery incident", blurb: "Randomised. One partner is quietly failing, every signal is just under a rulebook threshold, and there are red herrings elsewhere. No rule fits — someone has to reason about it." },
] as const;

export type FeaturedGoldenId = (typeof FEATURED_GOLDEN)[number]["id"];
