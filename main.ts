// mend — the CLI SPEC.md specifies.
// Applies an AI-written edit (unified diff, SEARCH/REPLACE blocks, V4A patch,
// or JSON edits) to a tree of text files: every file is changed or nothing is.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A line of an old block O or a new block N. ctx: a context line, written as the file's own line. */
interface BlockLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s));

/** Positions where O occurs in F at one tier. */
function occurrences(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > F.length) return out;
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(O[j]!, tier) !== normLine(F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) where O occurs in F, with its positions. */
function findTier(O: string[], F: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(O, F, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/**
 * Replace O by N at position pos in F. Context lines of N are the file's own
 * matched lines; at tier 2 the other lines of N are re-indented from O's
 * first line's leading whitespace to the file's first matched line's.
 */
function applyReplace(F: string[], O: BlockLine[], N: BlockLine[], pos: number, tier: number): string[] {
  const out = F.slice(0, pos);
  const oTexts = O.map((l) => l.text);
  const pLead = oTexts.length > 0 ? leadWs(oTexts[0]!) : '';
  const fLead = F.length > pos ? leadWs(F[pos]!) : '';
  for (const nl of N) {
    if (nl.ctx) {
      out.push(F[pos + nl.oIdx]!);
    } else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(pLead)) {
      out.push(fLead + nl.text.slice(pLead.length));
    } else {
      out.push(nl.text);
    }
  }
  for (let i = pos + O.length; i < F.length; i++) out.push(F[i]!);
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------- unified diffs (SPEC section 6) ---------------- */

interface Hunk {
  a: number;
  o: BlockLine[];
  n: BlockLine[];
  noFinal: boolean;
  plusNoFinal: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string): { old: string; next: string } | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  return { old: rest.slice(0, sep), next: rest.slice(sep + 3) };
}

function headerPath(text: string): string | null {
  let p = text;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const head = lines[at]!;
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(head);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let i = at + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: BlockLine[] = [];
  const n: BlockLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, k) => {
    if (l === '') {
      o.push({ text: '', ctx: true, oIdx: o.length });
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      o.push({ text: l.slice(1), ctx: true, oIdx: o.length });
      n.push({ text: l.slice(1), ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      o.push({ text: l.slice(1), ctx: false, oIdx: o.length });
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = k;
      lastPlus = k;
    }
  });
  const noFinal = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  const plusNoFinal = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  return { hunk: { a, o, n, noFinal, plusNoFinal }, next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: Section | null = null;
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: dg.old, newPath: dg.next, newFile: false, deletedFile: false, hunks: [] };
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [] };
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    let inHeader = true;
    let hasPair = false;
    while (i < lines.length) {
      const h = lines[i]!;
      if (inHeader) {
        if (h.startsWith('--- ')) {
          if ((lines[i + 1] ?? '').startsWith('+++ ')) {
            if (hasPair) break;
            hasPair = true;
            sec.oldPath = headerPath(h.slice(4));
            sec.newPath = headerPath(lines[i + 1]!.slice(4));
            i += 2;
            continue;
          }
          throw new Exit2(`error: parse ${i + 2}`);
        }
        if (h.startsWith('rename from ')) {
          if (!hasPair) sec.oldPath = h.slice('rename from '.length).trim();
          i++;
          continue;
        }
        if (h.startsWith('rename to ')) {
          if (!hasPair) sec.newPath = h.slice('rename to '.length).trim();
          i++;
          continue;
        }
        if (h.startsWith('new file mode')) {
          sec.newFile = true;
          i++;
          continue;
        }
        if (h.startsWith('deleted file mode')) {
          sec.deletedFile = true;
          i++;
          continue;
        }
        if (h.startsWith('@@')) {
          inHeader = false;
          continue;
        }
        if (h.startsWith('diff --git ')) break;
        if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        i++;
        continue;
      }
      if (h.startsWith('@@')) {
        const { hunk, next } = parseHunk(lines, i);
        sec.hunks.push(hunk);
        i = next;
        continue;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      i++;
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    if (isCreate) {
      // Both paths /dev/null names no file: the section has no effect.
      if (newP === null) return;
      const target = newP;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      let plus: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        const bodyPlus: string[] = [];
        h.n.forEach((nl) => {
          if (!nl.ctx) bodyPlus.push(nl.text);
        });
        plus = plus.concat(bodyPlus);
      }
      const lastPlus = findLastPlus(sec);
      if (lastPlus) noFinal = true;
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const isMove = oldP !== newP;
    if (isMove) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    } else if (tree.get(oldP!) === null) {
      throw new Fail('missing', oldP!);
    }
    const src = tree.get(oldP!)!;
    const f = splitFile(src);
    let cur: FileLines = f;
    let d = 0;
    for (const h of sec.hunks) {
      cur = applyHunk(cur, h, d, sec, strict);
      d += h.n.length - h.o.length;
    }
    const out = joinFile(cur);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(oldP!, null);
      tree.moves.push({ old: oldP!, next: newP! });
    } else {
      tree.now.set(oldP!, out);
    }
  };
}

/** Whether a `\` line follows the last `+` line of any hunk (for a created file's final break). */
function findLastPlus(sec: Section): boolean {
  for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
    const h = sec.hunks[hi]!;
    const nPlus = h.n.filter((nl) => !nl.ctx).length;
    if (nPlus > 0) return h.plusNoFinal;
  }
  return false;
}

function applyHunk(cur: FileLines, h: Hunk, d: number, sec: Section, strict: boolean): FileLines {
  const oTexts = h.o.map((l) => l.text);
  if (oTexts.length === 0) {
    const at = Math.min(h.a + d, cur.lines.length);
    const ins = h.n.map((l) => l.text);
    const lines = cur.lines.slice(0, at).concat(ins, cur.lines.slice(at));
    const final = ins.length === 0 ? cur.final : at === cur.lines.length ? !h.noFinal : cur.final;
    return { lines, br: cur.br, final };
  }
  const found = findTier(oTexts, cur.lines, strict);
  if (found === null) throw new Fail('no-match', sec.oldPath!);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const lines = applyReplace(cur.lines, h.o, h.n, best, found.tier);
  const final = best + oTexts.length === cur.lines.length ? !h.noFinal : cur.final;
  return { lines, br: cur.br, final };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    const j = lines.findIndex((l, k) => k >= i && l.trimEnd() === '<<<<<<< SEARCH');
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${j + 1}`);
    }
    let eq = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${j + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${j + 1}`);
    const oldLines = lines.slice(j + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const o: BlockLine[] = oldLines.map((t, k) => ({ text: t, ctx: false, oIdx: k }));
    const n: BlockLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const lines = applyReplace(f.lines, o, n, found.pos[0]!, found.tier);
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

interface V4AChunk {
  anchor: string | null;
  o: BlockLine[];
  n: BlockLine[];
  eof: boolean;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const got: { text: string; plus: boolean }[] = [];
      i++;
      while (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ') && lines[i]!.trim() !== '*** End Patch') {
        const s = lines[i]!;
        if (s.startsWith('+')) got.push({ text: s.slice(1), plus: true });
        else if (s === '') got.push({ text: '', plus: false });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (got.length > 0 && !got[got.length - 1]!.plus) got.pop();
      edits.push(v4aAdd(path, got.map((g) => g.text)));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aDelete(path));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      const flush = () => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ') || s.trim() === '*** End Patch') break;
        if (s.startsWith('*** End of File')) {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          flush();
          i++;
          continue;
        }
        if (s.startsWith('@@')) {
          flush();
          cur = { anchor: s.slice(2).trim(), o: [], n: [], eof: false };
          i++;
          continue;
        }
        if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
          if (cur === null && chunks.length > 0) {
            // A body line after the first chunk cannot start another chunk:
            // chunks start at an @@ line, or (first chunk only) at a body
            // line. A blank line is excused only when nothing but blanks
            // follows before the section ends (trailing section blanks).
            if (s === '') {
              let j = i + 1;
              while (j < last && lines[j] === '') j++;
              const sectionEnds =
                j >= last ||
                lines[j]!.startsWith('*** Add File: ') ||
                lines[j]!.startsWith('*** Delete File: ') ||
                lines[j]!.startsWith('*** Update File: ') ||
                lines[j]!.trim() === '*** End Patch';
              if (sectionEnds) {
                i = j;
                continue;
              }
            }
            throw new Exit2(`error: parse ${i + 1}`);
          }
          if (cur === null) cur = { anchor: null, o: [], n: [], eof: false };
          if (s === '') {
            cur.o.push({ text: '', ctx: true, oIdx: cur.o.length });
            cur.n.push({ text: '', ctx: true, oIdx: cur.o.length - 1 });
          } else if (s[0] === ' ') {
            cur.o.push({ text: s.slice(1), ctx: true, oIdx: cur.o.length });
            cur.n.push({ text: s.slice(1), ctx: true, oIdx: cur.o.length - 1 });
          } else if (s[0] === '-') {
            cur.o.push({ text: s.slice(1), ctx: false, oIdx: cur.o.length });
          } else {
            cur.n.push({ text: s.slice(1), ctx: false, oIdx: -1 });
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      // Blank lines at the end of a section are not part of it: trim trailing
      // empty context lines from the last chunk.
      {
        const lastC = chunks[chunks.length - 1];
        if (lastC !== undefined) {
          while (
            lastC.o.length > 0 &&
            lastC.n.length > 0 &&
            lastC.o[lastC.o.length - 1]!.ctx &&
            lastC.o[lastC.o.length - 1]!.text === '' &&
            lastC.n[lastC.n.length - 1]!.ctx &&
            lastC.n[lastC.n.length - 1]!.text === '' &&
            lastC.n[lastC.n.length - 1]!.oIdx === lastC.o.length - 1
          ) {
            lastC.o.pop();
            lastC.n.pop();
          }
        }
      }
      while (chunks.length > 0) {
        const c = chunks[chunks.length - 1]!;
        if (c.anchor === null && c.o.length === 0 && c.n.length === 0) chunks.pop();
        else break;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      if (chunks.length === 0 && moveTo !== null) {
        edits.push(v4aMoveOnly(path, moveTo));
      } else {
        edits.push(v4aUpdate(path, moveTo, chunks, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aMoveOnly(oldP: string, newP: string): Edit {
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    tree.now.set(newP, tree.get(oldP));
    tree.now.set(oldP, null);
    tree.moves.push({ old: oldP, next: newP });
  };
}

function v4aUpdate(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (normLine(lines[k]!, tier) === normLine(c.anchor!, tier)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const oTexts = c.o.map((l) => l.text);
      if (oTexts.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const ins = c.n.map((l) => l.text);
        lines = lines.slice(0, at).concat(ins, lines.slice(at));
        cursor = at + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; pos: number[] } | null = null;
      for (const tier of tiers) {
        const all = occurrences(oTexts, lines, tier).filter((p) => p >= cursor);
        const ok = c.eof ? all.filter((p) => p + oTexts.length === lines.length) : all;
        if (ok.length > 0) {
          found = { tier, pos: ok };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos[0]!;
      lines = applyReplace(lines, c.o, c.n, pos, found.tier);
      cursor = pos + c.n.length;
    }
    const out = joinFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, next: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ---------------- JSON edits (SPEC section 9) ---------------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- run ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Write every changed file (unless --check), including both sides of a move.
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; text: string }[] = [];
  const movedNew = new Set<string>();
  const movedOld = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.next);
    const nowOld = tree.get(m.old);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
      movedNew.add(m.next);
      movedOld.add(m.old);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedNew.has(p) || movedOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
