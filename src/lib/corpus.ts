/** A tiny product corpus + a shared analyzer, used across the phases. */

export interface Doc { id: number; text: string }

export const CORPUS: Doc[] = [
  { id: 1, text: "Red running shoes for men, lightweight and breathable" },
  { id: 2, text: "Blue running shoes women, cushioned marathon trainers" },
  { id: 3, text: "Waterproof hiking boots, rugged trail running approach shoes" },
  { id: 4, text: "Running socks, moisture-wicking, pack of six pairs" },
  { id: 5, text: "Red leather dress shoes for men, formal Oxford style" },
  { id: 6, text: "Kids running shoes, red and blue, durable playground sneakers" },
  { id: 7, text: "Trail running vest with hydration bladder for ultra running" },
  { id: 8, text: "Classic red high-top canvas sneakers, unisex casual shoes" },
];

const STOPWORDS = new Set(["for", "and", "the", "with", "of", "a", "an", "to", "in", "is", "pack"]);

/** Very small stemmer: normalize plurals and -ing/-ed so shoe/shoes, run/running
 *  collapse to one term. Not linguistically perfect — just enough to show why
 *  both sides must analyze identically. */
function stem(token: string): string {
  let t = token.toLowerCase();
  if (/(sses|shes|ches|xes)$/.test(t)) t = t.slice(0, -2);      // boxes → box
  else if (/[^s]s$/.test(t)) t = t.slice(0, -1);                // shoes → shoe, kids → kid
  if (/ing$/.test(t) && t.length > 5) {                         // running → runn → run
    t = t.slice(0, -3);
    if (/(.)\1$/.test(t)) t = t.slice(0, -1);
  } else if (/ed$/.test(t) && t.length > 4) t = t.slice(0, -2); // cushioned → cushion
  return t;
}

/** Analysis = lowercase → split on non-letters → drop stopwords → stem. */
export function analyze(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem)
    .filter(Boolean);
}
