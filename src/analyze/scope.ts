const TEST_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i;

function ext(p: string): string | undefined {
  const base = p.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : undefined;
}

function commonDir(paths: string[]): string {
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0] ?? [];
  let i = 0;
  while (i < first.length && split.every((s) => s[i] === first[i])) i++;
  return first.slice(0, i).join('/');
}

/**
 * Infer an `applyTo` glob for a set of reviewed file paths, or undefined if the
 * guidance looks repository-wide. `dominance` is the share of paths that must agree.
 */
export function inferApplyTo(paths: (string | undefined)[], dominance = 0.7): string | undefined {
  const ps = paths.filter((p): p is string => !!p);
  if (ps.length === 0 || ps.length / paths.length < dominance) return undefined;

  const counts = new Map<string, number>();
  for (const p of ps) {
    const e = ext(p);
    if (e) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  const [topExt, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
  const extOk = topExt !== undefined && topCount / ps.length >= dominance;
  const scoped = extOk ? ps.filter((p) => ext(p) === topExt) : ps;

  const testShare = scoped.filter((p) => TEST_RE.test(p)).length / scoped.length;
  const dir = commonDir(scoped);

  if (testShare >= dominance && extOk) {
    return dir ? `${dir}/**/*.{test,spec}.${topExt}` : `**/*.{test,spec}.${topExt}`;
  }
  if (dir && extOk) return `${dir}/**/*.${topExt}`;
  if (dir) return `${dir}/**`;
  if (extOk) return `**/*.${topExt}`;
  return undefined;
}

/** Minimal glob -> RegExp for the patterns produced above (`**`, `*`, `{a,b}`). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`;
      i = end;
    } else re += escape(ch);
  }
  return new RegExp(`^${re}$`);
}

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

/**
 * A scope is only useful if it is narrower than where reviewers comment in general.
 * Returns false when the glob covers more than `maxShare` of all reviewed paths.
 */
export function isDiscriminative(glob: string, allPaths: string[], maxShare = 0.6): boolean {
  if (allPaths.length === 0) return true;
  const re = globToRegExp(glob);
  return allPaths.filter((p) => re.test(p)).length / allPaths.length <= maxShare;
}
