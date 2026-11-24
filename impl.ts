// impl.ts — mend's unified diff (§6), SEARCH/REPLACE (§7) and V4A (§8) readers,
// and line matching at three tiers (§5). Node 22, standard library alone.
// main.ts imports parseEdits, P2, FE and moves from here.

export class P2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
export class FE {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** [old, new] of every move edit that succeeded in this run (for the R output line). */
export const moves: Array<[string, string]> = [];

export interface TreeLike {
  get(p: string): string | null;
  now: Map<string, string | null>;
}
export type Edit = (tree: TreeLike) => void;

const safe = (p: string): boolean =>
  p !== '' &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}
const splitFile = (text: string): FileLines => {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
};
const joinFile = (lines: string[], br: string, final: boolean): string =>
  lines.length === 0 ? '' : lines.join(br) + (final ? br : '');

const lead = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0];
const norm = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

const occurrences = (file: string[], o: string[], tier: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(file[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
};

/** First tier (0, 1, 2 — or only 0 when strict) where O occurs, with its positions. */
const findTier = (file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null => {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(file, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
};

/** One line of N: a context line names its index in O (written as the file's own line), else an added line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Replace O at pos with N. Context lines come from the file; added lines are re-indented at tier 2. */
const applyChunk = (file: string[], o: string[], n: NLine[], pos: number, tier: number): void => {
  const f = lead(file[pos] ?? '');
  const p = lead(o[0] ?? '');
  const out = n.map((item) => {
    if (item.ctx !== null) return file[pos + item.ctx]!;
    if (tier !== 2) return item.text;
    const l = item.text;
    return l !== '' && !/^[ \t]+$/.test(l) && l.startsWith(p) ? f + l.slice(p.length) : l;
  });
  file.splice(pos, o.length, ...out);
};

/** True when a `\` line follows the hunk's last context or `+` line. */
const backslashAfter = (body: string[]): boolean => {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.startsWith(' ') || body[i]!.startsWith('+')) last = i;
  }
  return last >= 0 && (body[last + 1] ?? '').startsWith('\\');
};

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  body: string[];
}

/** Apply a section's hunks in order to a file's text. Throws FE on a failed hunk. */
const applyHunks = (content: string, hunks: Hunk[], strict: boolean, path: string): string => {
  const f = splitFile(content);
  let d = 0;
  let final = f.final;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.n.map((x) => x.text));
      if (atEnd) final = !backslashAfter(h.body);
      d += h.n.length;
    } else {
      const found = findTier(f.lines, h.o, strict);
      if (!found) throw new FE('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === f.lines.length;
      applyChunk(f.lines, h.o, h.n, best, found.tier);
      if (atEnd) final = !backslashAfter(h.body);
      d += h.n.length - h.o.length;
    }
  }
  return joinFile(f.lines, f.br, final);
};

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const headerPath = (raw: string): string | null => {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return stripPrefix(p);
};

const parseHunkHeader = (l: string): number | null => {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  return m ? Number(m[1]) : null;
};

const parseUnified = (lines: string[], strict: boolean): Edit[] => {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      diffOld: undefined,
      diffNew: undefined,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new P2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (inHeader && cur !== null) {
        if (!nextIsPlus) throw new P2(`error: parse ${i + 2}`);
        if (cur.pairOld === undefined) {
          cur.pairOld = headerPath(l);
          cur.pairNew = headerPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        cur = fresh();
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        inHeader = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new P2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(l);
      if (a === null) throw new P2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const n: NLine[] = [];
      for (const b of body) {
        if (b.startsWith(' ')) {
          o.push(b.slice(1));
          n.push({ text: b.slice(1), ctx: o.length - 1 });
        } else if (b.startsWith('-')) o.push(b.slice(1));
        else if (b.startsWith('+')) n.push({ text: b.slice(1), ctx: null });
        else if (b === '') {
          o.push('');
          n.push({ text: '', ctx: o.length - 1 });
        }
      }
      cur.hunks.push({ a, o, n, body });
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  return sections.map((s) => makeSectionEdit(s, strict));
};

const makeSectionEdit = (s: Section, strict: boolean): Edit => {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.diffOld;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.diffNew;
  const isCreate = oldP === null || s.create;
  const isDelete = newP === null || s.del;
  return (tree) => {
    if (isCreate) {
      const p = newP;
      if (p === undefined || p === null) return;
      if (!safe(p)) throw new FE('unsafe', p);
      if (tree.get(p) !== null) throw new FE('exists', p);
      const plus: string[] = [];
      let finalBr = true;
      let sawPlus = false;
      for (const h of s.hunks) {
        for (const x of h.n) if (x.ctx === null) plus.push(x.text);
        if (h.n.some((x) => x.ctx === null)) {
          sawPlus = true;
          let lastPlus = -1;
          for (let b = 0; b < h.body.length; b += 1) if (h.body[b]!.startsWith('+')) lastPlus = b;
          finalBr = !(lastPlus >= 0 && (h.body[lastPlus + 1] ?? '').startsWith('\\'));
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (sawPlus && finalBr ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP;
      if (p === undefined || p === null) return;
      if (!safe(p)) throw new FE('unsafe', p);
      if (tree.get(p) === null) throw new FE('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP === undefined || newP === undefined || oldP === null || newP === null) return;
    if (oldP === newP) {
      if (!safe(oldP)) throw new FE('unsafe', oldP);
      const before = tree.get(oldP);
      if (before === null) throw new FE('missing', oldP);
      tree.now.set(oldP, applyHunks(before, s.hunks, strict, oldP));
      return;
    }
    if (!safe(oldP)) throw new FE('unsafe', oldP);
    if (!safe(newP)) throw new FE('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new FE('missing', oldP);
    if (tree.get(newP) !== null) throw new FE('exists', newP);
    const text = applyHunks(before, s.hunks, strict, oldP);
    tree.now.set(newP, text);
    tree.now.set(oldP, null);
    moves.push([oldP, newP]);
  };
};

const makeSREdit = (path: string, oldLines: string[], newLines: string[], strict: boolean): Edit => (tree) => {
  if (!safe(path)) throw new FE('unsafe', path);
  if (oldLines.length === 0) {
    if (tree.get(path) !== null) throw new FE('exists', path);
    tree.now.set(path, joinFile(newLines, '\n', newLines.length > 0));
    return;
  }
  const before = tree.get(path);
  if (before === null) throw new FE('missing', path);
  const f = splitFile(before);
  const found = findTier(f.lines, oldLines, strict);
  if (!found) throw new FE('no-match', path);
  if (found.occ.length > 1) throw new FE('ambiguous', path);
  const n: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
  applyChunk(f.lines, oldLines, n, found.occ[0]!, found.tier);
  tree.now.set(path, joinFile(f.lines, f.br, f.final));
};

const parseSR = (lines: string[], strict: boolean): Edit[] => {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new P2(`error: parse ${sIdx + 1}`);
    let eq = -1;
    let end = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new P2(`error: parse ${sIdx + 1}`);
    edits.push(makeSREdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
};

const makeAddEdit = (path: string, ls: string[]): Edit => (tree) => {
  if (!safe(path)) throw new FE('unsafe', path);
  if (tree.get(path) !== null) throw new FE('exists', path);
  tree.now.set(path, joinFile(ls, '\n', ls.length > 0));
};

const makeDeleteEdit = (path: string): Edit => (tree) => {
  if (!safe(path)) throw new FE('unsafe', path);
  if (tree.get(path) === null) throw new FE('missing', path);
  tree.now.set(path, null);
};

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

const makeUpdateEdit = (path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit => (tree) => {
  if (!safe(path)) throw new FE('unsafe', path);
  if (moveTo !== null && !safe(moveTo)) throw new FE('unsafe', moveTo);
  const before = tree.get(path);
  if (before === null) throw new FE('missing', path);
  if (moveTo !== null && tree.get(moveTo) !== null) throw new FE('exists', moveTo);
  const f = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        for (let k = cursor; k < f.lines.length; k += 1) {
          if (norm(f.lines[k]!, tier) === norm(ch.anchor!, tier)) {
            foundAt = k;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new FE('no-match', path);
      cursor = foundAt + 1;
    }
    if (ch.o.length === 0) {
      const pos = ch.eof ? f.lines.length : cursor;
      f.lines.splice(pos, 0, ...ch.n.map((x) => x.text));
      cursor = pos + ch.n.length;
    } else {
      let hit: { tier: number; pos: number } | null = null;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        const occ = occurrences(f.lines, ch.o, tier).filter(
          (p) => p >= cursor && (!ch.eof || p + ch.o.length === f.lines.length),
        );
        if (occ.length > 0) {
          hit = { tier, pos: occ[0]! };
          break;
        }
      }
      if (!hit) throw new FE('no-match', path);
      applyChunk(f.lines, ch.o, ch.n, hit.pos, hit.tier);
      cursor = hit.pos + ch.n.length;
    }
  }
  const text = joinFile(f.lines, f.br, f.final);
  if (moveTo !== null) {
    tree.now.set(moveTo, text);
    tree.now.set(path, null);
    moves.push([path, moveTo]);
  } else {
    tree.now.set(path, text);
  }
};

const isSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

const parseV4A = (lines: string[], strict: boolean): Edit[] => {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new P2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new P2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k]!.trim() !== '') {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new P2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.trim() === '') {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      i += 1;
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x) || x.trim() === '*** End Patch') break;
        if (x.startsWith('+')) raw.push(x.slice(1));
        else if (x.trim() === '') raw.push('');
        else throw new P2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      edits.push(makeAddEdit(path, raw));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      edits.push(makeDeleteEdit(l.slice('*** Delete File: '.length).trim()));
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const raw: string[] = [];
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x) || x.trim() === '*** End Patch') break;
        raw.push(x);
        i += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      for (let k = 0; k < raw.length; k += 1) {
        const x = raw[k]!;
        const absLine = i - raw.length + k + 1;
        if (x === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: false, o: [], n: [] };
            chunks.push(cur);
            seenChunk = true;
          }
          cur.eof = true;
          cur = null;
          continue;
        }
        if (x.startsWith('@@')) {
          const a = x.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, o: [], n: [] };
          chunks.push(cur);
          seenChunk = true;
          continue;
        }
        if (x.startsWith('*** ')) throw new P2(`error: parse ${absLine}`);
        if (cur === null) {
          if (seenChunk) throw new P2(`error: parse ${absLine}`);
          cur = { anchor: null, eof: false, o: [], n: [] };
          chunks.push(cur);
          seenChunk = true;
        }
        if (x.startsWith(' ')) {
          cur.o.push(x.slice(1));
          cur.n.push({ text: x.slice(1), ctx: cur.o.length - 1 });
        } else if (x.startsWith('-')) cur.o.push(x.slice(1));
        else if (x.startsWith('+')) cur.n.push({ text: x.slice(1), ctx: null });
        else if (x === '') {
          cur.o.push('');
          cur.n.push({ text: '', ctx: cur.o.length - 1 });
        } else throw new P2(`error: parse ${absLine}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new P2(`error: parse ${updateLine}`);
      edits.push(makeUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new P2(`error: parse ${i + 1}`);
  }
  return edits;
};

/** Read a non-JSON patch in its format. Throws P2 on a parse error. */
export const parseEdits = (kind: string, lines: string[], strict: boolean): Edit[] => {
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSR(lines, strict);
  if (kind === 'v4a') return parseV4A(lines, strict);
  throw new P2('error: parse 1');
};
