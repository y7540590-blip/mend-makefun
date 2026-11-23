// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON tool calls), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what changed or why it failed. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree, strict: boolean) => void;

/** A file as lines, with its own line break and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFL(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function serFL(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

/** Matching lines (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(F: string[], O: string[], tier: number): number[] {
  const res: number[] = [];
  const oN = O.map((l) => normLine(l, tier));
  outer: for (let i = 0; i + O.length <= F.length; i += 1) {
    for (let j = 0; j < O.length; j += 1) {
      if (normLine(F[i + j]!, tier) !== oN[j]) continue outer;
    }
    res.push(i);
  }
  return res;
}

function findMatch(F: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const pos = occurrences(F, O, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` line. */
interface Item {
  type: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  empty?: boolean;
}

/** The lines a hunk or chunk writes: context lines are the file's own, new lines are re-indented at tier 2. */
function writtenItems(items: Item[], F: string[], start: number, O: string[], tier: number): string[] {
  let fInd = '';
  let pInd = '';
  if (tier === 2) {
    fInd = indentOf(F[start] ?? '');
    pInd = indentOf(O[0] ?? '');
  }
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.type === 'ctx') {
      out.push(F[start + oIdx]!);
      oIdx += 1;
    } else if (it.type === 'del') {
      oIdx += 1;
    } else if (it.type === 'add') {
      const t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(pInd)) out.push(fInd + t.slice(pInd.length));
      else out.push(t);
    }
  }
  return out;
}

/** The lines a SEARCH/REPLACE block writes (no context lines, so tier 2 re-indents every line). */
function writtenPlain(N: string[], F: string[], start: number, O: string[], tier: number): string[] {
  if (tier !== 2) return [...N];
  const fInd = indentOf(F[start] ?? '');
  const pInd = indentOf(O[0] ?? '');
  return N.map((t) => (t.trim() !== '' && t.startsWith(pInd) ? fInd + t.slice(pInd.length) : t));
}

/**
 * Whether a `\` line follows the hunk's last context or `+` line in its body. A `\` line refers to the body
 * line before it (SPEC.md section 6), so only one placed immediately after that line counts: a `\` line after
 * a `-` line says the old file's last line has no break, and says nothing about the result's final break.
 */
function noBreakAfter(items: Item[]): boolean {
  let last = -1;
  items.forEach((it, idx) => {
    if (it.type === 'ctx' || it.type === 'add') last = idx;
  });
  return last >= 0 && items[last + 1]?.type === 'bs';
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

/** Unified diffs (SPEC.md section 6). */
interface UHunk {
  a: number;
  items: Item[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const s = rest.slice(2);
  const idx = s.indexOf(' b/');
  if (idx <= 0) return null;
  const y = s.slice(idx + 3);
  if (y === '') return null;
  return [s.slice(0, idx), y];
}

function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  const rest = line.slice(m[0].length);
  if (rest !== '' && !rest.startsWith(' ')) return null;
  return parseInt(m[1]!, 10);
}

/** Consume one section's header and hunks; returns the index of the first line after the section. */
function parseUSection(lines: string[], i: number, sec: USection): number {
  let inHeader = true;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (!inHeader && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (line.startsWith('@@')) {
      const a = hunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const items: Item[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') items.push({ type: 'ctx', text: '', empty: true });
        else if (bl[0] === ' ') items.push({ type: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') items.push({ type: 'del', text: bl.slice(1) });
        else if (bl[0] === '+') items.push({ type: 'add', text: bl.slice(1) });
        else if (bl[0] === '\\') items.push({ type: 'bs', text: bl.slice(1) });
        else break;
        j += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.empty) items.pop();
      sec.hunks.push({ a, items });
      i = j;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.minus = headerPath(line);
        sec.plus = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        sec.plus = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function applyUHunks(fl: FileLines, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const O = hunk.items.filter((it) => it.type === 'ctx' || it.type === 'del').map((it) => it.text);
    const nLen = hunk.items.filter((it) => it.type === 'ctx' || it.type === 'add').length;
    if (O.length === 0) {
      const adds = hunk.items.filter((it) => it.type === 'add').map((it) => it.text);
      const pos = Math.min(Math.max(hunk.a + d, 0), fl.lines.length);
      const atEnd = pos === fl.lines.length;
      fl.lines.splice(pos, 0, ...adds);
      if (atEnd) fl.final = !noBreakAfter(hunk.items);
      d += nLen;
    } else {
      const m = findMatch(fl.lines, O, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = m.pos[0]!;
      for (const p of m.pos) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const written = writtenItems(hunk.items, fl.lines, pos, O, m.tier);
      const atEnd = pos + O.length === fl.lines.length;
      fl.lines.splice(pos, O.length, ...written);
      if (atEnd) fl.final = !noBreakAfter(hunk.items);
      d += nLen - O.length;
    }
  }
}

function uEdit(sec: USection): Edit {
  const oldP = sec.minus ?? sec.renameFrom ?? sec.gitOld ?? '';
  const newP = sec.plus ?? sec.renameTo ?? sec.gitNew ?? '';
  const creation = oldP === '/dev/null' || sec.newFile;
  const deletion = !creation && (newP === '/dev/null' || sec.delFile);
  return (tree, strict) => {
    if (creation) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const flat = sec.hunks.flatMap((h) => h.items);
      const plus = flat.filter((it) => it.type === 'add').map((it) => it.text);
      const text = plus.length === 0 ? '' : plus.join('\n') + (noBreakAfter(flat) ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (deletion) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (oldP !== newP && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const fl = parseFL(before);
    applyUHunks(fl, sec.hunks, strict, oldP);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, serFL(fl));
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, serFL(fl));
    }
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = gitPaths(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = { gitOld: g[0], gitNew: g[1], minus: null, plus: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      i = parseUSection(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { gitOld: null, gitNew: null, minus: null, plus: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      i = parseUSection(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(uEdit);
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = parseFL(before);
    const m = findMatch(fl.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = m.pos[0]!;
    const written = writtenPlain(newLines, fl.lines, pos, oldLines, m.tier);
    fl.lines.splice(pos, oldLines.length, ...written);
    tree.now.set(path, serFL(fl));
  };
}

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${i + 1}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** V4A patches (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

function findAnchor(F: string[], anchor: string, cursor: number, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const want = normLine(anchor, tier);
    for (let j = cursor; j < F.length; j += 1) {
      if (normLine(F[j]!, tier) === want) return j;
    }
  }
  return -1;
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fl = parseFL(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(fl.lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = chunk.items.filter((it) => it.type === 'ctx' || it.type === 'del').map((it) => it.text);
      if (O.length === 0) {
        const adds = chunk.items.filter((it) => it.type === 'add').map((it) => it.text);
        const pos = chunk.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const cand = occurrences(fl.lines, O, tier).filter((p) => p >= cursor && (!chunk.eof || p + O.length === fl.lines.length));
          if (cand.length > 0) {
            found = { tier, pos: cand[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const written = writtenItems(chunk.items, fl.lines, found.pos, O, found.tier);
        fl.lines.splice(found.pos, O.length, ...written);
        cursor = found.pos + written.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, serFL(fl));
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, serFL(fl));
    }
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : line.startsWith('*** Update File: ') ? 'upd' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const secLine = i + 1;
    const raw: { text: string; lineNo: number }[] = [];
    let j = i + 1;
    while (j < last && !isStart(lines[j]!)) {
      raw.push({ text: lines[j]!, lineNo: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const flines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) flines.push(r.text.slice(1));
        else if (r.text === '') flines.push('');
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.lineNo}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      raw.forEach((r, idx) => {
        const l = r.text;
        if (l.startsWith('*** Move to: ')) {
          if (idx !== 0) throw new Exit2(`error: parse ${r.lineNo}`);
          moveTo = l.slice('*** Move to: '.length).trim();
          return;
        }
        if (l === '*** End of File') {
          // It ends a chunk (SPEC.md section 8); with no chunk open there is nothing for it to end.
          if (cur === null) throw new Exit2(`error: parse ${r.lineNo}`);
          cur.eof = true;
          cur = null;
          return;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() || null, eof: false, items: [] };
          chunks.push(cur);
          return;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            // Only the first chunk of a section may start at a body line (SPEC.md section 8); a body line
            // after a chunk was closed (by `*** End of File`) belongs to no chunk.
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.lineNo}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (l === '') cur.items.push({ type: 'ctx', text: '' });
          else if (l[0] === ' ') cur.items.push({ type: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.items.push({ type: 'del', text: l.slice(1) });
          else cur.items.push({ type: 'add', text: l.slice(1) });
          return;
        }
        throw new Exit2(`error: parse ${r.lineNo}`);
      });
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? srEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rPairs = tree.moves.filter(([o, n]) => o !== n && tree.original(o) !== null && state(o) === null && tree.original(n) === null && state(n) !== null);
  const covered = new Set<string>();
  for (const [o, n] of rPairs) {
    covered.add(o);
    covered.add(n);
  }
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
