/** The two golden scenarios offered in the UI; the full set still runs in the benchmark. */
export const FEATURED_GOLDEN = [
  { id: "GS-01", short: "Routine incident", blurb: "A partner's systems slow down sharply. Textbook case — the rules know exactly what this looks like." },
  { id: "GS-18", short: "Tricky incident", blurb: "A partner slows down while its traffic also grows, so it's less obvious whether load or the partner is to blame." },
] as const;

export type FeaturedGoldenId = (typeof FEATURED_GOLDEN)[number]["id"];
