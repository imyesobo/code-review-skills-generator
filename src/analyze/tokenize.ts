const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren as at be because been before being below between both
but by can cannot could couldn did didn do does doesn doing don down during each else few for from further get got had hasn have
haven having he her here hers him his how i if in into is isn it its itself just let lets like ll make maybe me might more most
much must mustn my no nor not now of off on once only or other our ours out over own perhaps please re really same shall she
should shouldn so some such than that the their theirs them then there these they this those through to too under until up us
ve very was wasn we were weren what when where which while who whom why will with won would wouldn yes yet you your yours
think thing things here's there's it's that's i'm we're you're don't can't won't isn't doesn't instead use using used code
line lines file files change changes changed pr one two also still already even need needs want wants see seems look looks`.split(/\s+/),
);

/** Small Porter-like stemmer; consistent enough for clustering short review comments. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ss|x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);

  for (const [suf, rep] of [['ation', 'ate'], ['ment', ''], ['ing', ''], ['ed', ''], ['ly', '']] as const) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      w = w.slice(0, -suf.length) + rep;
      break;
    }
  }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** stem -> surface form -> count; lets us display "require" instead of the stem "requir". */
export type Surfaces = Map<string, Map<string, number>>;

export function tokenize(text: string, surfaces?: Surfaces): string[] {
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/`([^`]*)`/g, ' $1 ')
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return words.map((w) => {
    const s = stem(w);
    if (surfaces) {
      const m = surfaces.get(s) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1);
      surfaces.set(s, m);
    }
    return s;
  });
}

export function surfaceOf(stemmed: string, surfaces: Surfaces): string {
  const m = surfaces.get(stemmed);
  if (!m) return stemmed;
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
}
