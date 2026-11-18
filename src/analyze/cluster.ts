export type Vec = Map<string, number>;

export function tfidf(docs: string[][]): { vectors: Vec[]; idf: Map<string, number> } {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log((1 + n) / (1 + f)) + 1);

  const vectors = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vec = new Map();
    for (const [t, f] of tf) v.set(t, (1 + Math.log(f)) * idf.get(t)!);
    return normalizeVec(v);
  });
  return { vectors, idf };
}

export function normalizeVec(v: Vec): Vec {
  let norm = 0;
  for (const x of v.values()) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out: Vec = new Map();
  for (const [k, x] of v) out.set(k, x / norm);
  return out;
}

export function cosine(a: Vec, b: Vec): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y) s += x * y;
  }
  return s;
}

function addInto(target: Vec, v: Vec) {
  for (const [k, x] of v) target.set(k, (target.get(k) ?? 0) + x);
}

/**
 * Leader clustering against running centroids followed by centroid merge passes.
 * Deterministic for a given input order. Returns clusters as arrays of doc indices.
 */
export function cluster(vectors: Vec[], threshold: number): number[][] {
  const members: number[][] = [];
  const sums: Vec[] = [];
  const centroids: Vec[] = [];

  vectors.forEach((v, i) => {
    if (v.size === 0) return;
    let best = -1;
    let bestSim = threshold;
    centroids.forEach((c, j) => {
      const s = cosine(v, c);
      if (s >= bestSim) { bestSim = s; best = j; }
    });
    if (best === -1) {
      members.push([i]);
      sums.push(new Map(v));
      centroids.push(v);
    } else {
      members[best].push(i);
      addInto(sums[best], v);
      centroids[best] = normalizeVec(sums[best]);
    }
  });

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let a = 0; a < centroids.length; a++) {
      for (let b = a + 1; b < centroids.length; b++) {
        if (cosine(centroids[a], centroids[b]) >= threshold) {
          members[a].push(...members[b]);
          addInto(sums[a], sums[b]);
          centroids[a] = normalizeVec(sums[a]);
          members.splice(b, 1); sums.splice(b, 1); centroids.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return refine(vectors, members, threshold);
}

/**
 * Centroid drift lets leader clustering absorb loosely related docs. Reassign each doc
 * to its best centroid (if >= threshold, else a singleton) until stable.
 */
function refine(vectors: Vec[], initial: number[][], threshold: number, maxIter = 10): number[][] {
  let groups = initial;
  for (let iter = 0; iter < maxIter; iter++) {
    const centroids = groups.map((g) => centroidOf(g.map((i) => vectors[i])));
    const next: number[][] = groups.map(() => []);
    const singles: number[][] = [];
    let moved = false;
    groups.forEach((g, from) => {
      for (const i of g) {
        let best = -1;
        let bestSim = threshold;
        centroids.forEach((c, j) => {
          const s = cosine(vectors[i], c);
          if (s > bestSim || (s === bestSim && j === from)) { bestSim = s; best = j; }
        });
        if (best === -1) {
          if (g.length > 1) moved = true;
          singles.push([i]);
        } else {
          if (best !== from) moved = true;
          next[best].push(i);
        }
      }
    });
    groups = [...next.filter((g) => g.length), ...singles];
    if (!moved) break;
  }
  return groups.map((g) => g.sort((a, b) => a - b));
}

export function centroidOf(vectors: Vec[]): Vec {
  const sum: Vec = new Map();
  for (const v of vectors) addInto(sum, v);
  return normalizeVec(sum);
}

/** Index (within `vectors`) of the most central member. */
export function medoid(vectors: Vec[]): number {
  const c = centroidOf(vectors);
  let best = 0;
  let bestSim = -1;
  vectors.forEach((v, i) => {
    const s = cosine(v, c);
    if (s > bestSim) { bestSim = s; best = i; }
  });
  return best;
}

export function topTerms(v: Vec, n: number): string[] {
  return [...v.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}
