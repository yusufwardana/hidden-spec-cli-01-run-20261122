// mend: one patch tool for every AI edit format.
//
// Applies AI-written edits in four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON tool calls) to a tree of text files, per the
// specification in SPEC.md. Node 22+, standard library only, no network.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the trial is handed over to runner.ts.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Brk = "\n" | "\r\n";

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// Split patch text into lines: split at \n, one trailing \r removed per
// line, no empty piece after a final \n.
function patchLines(text: string): string[] {
  const parts = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// File text model (SPEC section 3)
// ---------------------------------------------------------------------------

interface ParsedText {
  lines: string[];
  brk: Brk;
  ends: boolean;
}

function parseText(text: string): ParsedText {
  if (text === "") return { lines: [], brk: "\n", ends: false };
  const firstLf = text.indexOf("\n");
  const brk: Brk = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const parts = text.split(brk);
  let ends = false;
  if (text.endsWith(brk)) {
    ends = true;
    parts.pop();
  }
  return { lines: parts, brk, ends };
}

function serialize(lines: string[], brk: Brk, ends: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(brk) + (ends ? brk : "");
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrencesAt(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0 || pat.length > lines.length) return out;
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

// First tier (0, then 1, then 2; only 0 when strict) with an occurrence at or
// after `from`. Null when there is none at any tier.
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, pat, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Build the replacement lines for a match at `pos`. nCtx[k] is the index
// into O when the k-th line of N is a context line, else -1.
function buildReplacement(
  fileLines: string[],
  pos: number,
  o: string[],
  n: string[],
  nCtx: number[],
  tier: number,
): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadWs(o[0]) : "";
  const f = pos < fileLines.length ? leadWs(fileLines[pos]) : "";
  for (let k = 0; k < n.length; k++) {
    const ci = nCtx[k];
    if (ci >= 0) {
      out.push(fileLines[pos + ci]);
    } else if (tier === 2) {
      const line = n[k];
      if (line !== "" && !/^[ \t]*$/.test(line) && line.startsWith(p)) {
        out.push(f + line.slice(p.length));
      } else {
        out.push(line);
      }
    } else {
      out.push(n[k]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tree: original state plus simulated state (SPEC section 10)
// ---------------------------------------------------------------------------

interface FileState {
  exists: boolean;
  text: string;
}

class Tree {
  private orig = new Map<string, FileState>();
  private cur = new Map<string, FileState>();
  moves: Array<[string, string]> = [];

  private touch(p: string): void {
    if (this.orig.has(p)) return;
    if (existsSync(p)) {
      let text = "";
      let ok = true;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        ok = false;
      }
      if (ok) {
        this.orig.set(p, { exists: true, text });
        this.cur.set(p, { exists: true, text });
      } else {
        this.orig.set(p, { exists: false, text: "" });
        this.cur.set(p, { exists: false, text: "" });
      }
    } else {
      this.orig.set(p, { exists: false, text: "" });
      this.cur.set(p, { exists: false, text: "" });
    }
  }

  exists(p: string): boolean {
    const s = this.cur.get(p);
    if (s) return s.exists;
    return existsSync(p);
  }

  read(p: string): FileState {
    this.touch(p);
    return this.cur.get(p)!;
  }

  set(p: string, text: string): void {
    this.touch(p);
    this.cur.set(p, { exists: true, text });
  }

  del(p: string): void {
    this.touch(p);
    this.cur.set(p, { exists: false, text: "" });
  }

  origEntries(): Array<[string, FileState]> {
    return [...this.orig.entries()];
  }

  curState(p: string): FileState {
    return this.cur.get(p)!;
  }
}

// ---------------------------------------------------------------------------
// Command line (SPEC section 1)
// ---------------------------------------------------------------------------

interface Opts {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): { opts: Opts } | { usageErr: true } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (seenCheck) return { usageErr: true };
        seenCheck = true;
        check = true;
      } else if (a === "--strict") {
        if (seenStrict) return { usageErr: true };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith("--format=")) {
        if (seenFormat) return { usageErr: true };
        seenFormat = true;
        const v = a.slice("--format=".length);
        if (v !== "auto" && v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json") {
          return { usageErr: true };
        }
        format = v;
      } else {
        return { usageErr: true };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { usageErr: true };
  return { opts: { format: format ?? "auto", check, strict, patch: positional[0] ?? null } };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

interface HunkBodyLine {
  k: " " | "-" | "+" | "\\";
  text: string;
  empty: boolean; // the patch line itself was empty (a context line of "")
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
}

interface VChunkBodyLine {
  k: " " | "-" | "+";
  text: string;
}

interface VChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: VChunkBodyLine[];
}

type Edit =
  | { kind: "unified"; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }
  | { kind: "sr"; path: string; oldLines: string[]; newLines: string[] }
  | { kind: "v4a-add"; path: string; lines: string[] }
  | { kind: "v4a-del"; path: string }
  | { kind: "v4a-update"; path: string; newPath: string | null; chunks: VChunk[] }
  | { kind: "json-create"; path: string; fileText: string }
  | { kind: "json-str"; path: string; oldStr: string; newStr: string }
  | { kind: "json-insert"; path: string; insertLine: number; newStr: string };

interface Fail {
  code: string;
  path: string;
}

type ParseResult = { edits: Edit[] } | { parseErr: number };

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === "*** Begin Patch") return "v4a";
  const head = lines[first].trimStart();
  if (head[0] === "[" || head[0] === "{") return "json";
  for (let i = 0; i < lines.length; i++) {
    if (trimEndWs(lines[i]) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

// Path from a `--- ` / `+++ ` header line: text after the four characters,
// up to the first tab, surrounding spaces removed; /dev/null means no file;
// one leading a/ or b/ removed.
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf("\t");
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): ParseResult {
  const sections: UniSection[] = [];
  const n = lines.length;
  let i = 0;
  let sec: {
    gitOld: string | null;
    gitNew: string | null;
    headOld: string | null;
    headNew: string | null;
    renOld: string | null;
    renNew: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
  } | null = null;
  let phase: "none" | "header" | "body" | "between" = "none";
  let hunk: Hunk | null = null;

  function closeSection(): void {
    if (sec) {
      sections.push({
        oldPath: sec.headOld ?? sec.renOld ?? sec.gitOld,
        newPath: sec.headNew ?? sec.renNew ?? sec.gitNew,
        isCreate: sec.isCreate,
        isDelete: sec.isDelete,
        hunks: sec.hunks,
      });
    }
    sec = null;
  }

  function startSection(gitOld: string | null, gitNew: string | null): void {
    closeSection();
    sec = {
      gitOld,
      gitNew,
      headOld: null,
      headNew: null,
      renOld: null,
      renNew: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    phase = "header";
  }

  function endBody(): void {
    if (hunk && sec) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].empty) hunk.body.pop();
      sec.hunks.push(hunk);
      hunk = null;
    }
    phase = "between";
  }

  function parseHunkHeader(line: string): number | null {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) return null;
    return parseInt(m[1], 10);
  }

  while (i < n) {
    const line = lines[i];
    if (phase === "body") {
      const isBodyChar =
        line === "" || line[0] === " " || line[0] === "-" || line[0] === "+" || line[0] === "\\";
      const isSectionStart =
        line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ");
      if (isBodyChar && !isSectionStart) {
        if (line === "") hunk!.body.push({ k: " ", text: "", empty: true });
        else if (line[0] === " ") hunk!.body.push({ k: " ", text: line.slice(1), empty: false });
        else if (line[0] === "-") hunk!.body.push({ k: "-", text: line.slice(1), empty: false });
        else if (line[0] === "+") hunk!.body.push({ k: "+", text: line.slice(1), empty: false });
        else hunk!.body.push({ k: "\\", text: line.slice(1), empty: false });
        i++;
        continue;
      }
      endBody();
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) return { parseErr: i + 1 };
      startSection(m[1], m[2]);
      i++;
      continue;
    }

    if (phase === "header") {
      if (line.startsWith("@@")) {
        const a = parseHunkHeader(line);
        if (a === null) return { parseErr: i + 1 };
        hunk = { a, body: [] };
        phase = "body";
        i++;
        continue;
      }
      if (line.startsWith("--- ")) {
        if (i + 1 >= n || !lines[i + 1].startsWith("+++ ")) return { parseErr: i + 2 };
        sec!.headOld = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith("+++ ")) {
        sec!.headNew = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith("rename from ")) {
        sec!.renOld = line.slice("rename from ".length).trim();
        i++;
        continue;
      }
      if (line.startsWith("rename to ")) {
        sec!.renNew = line.slice("rename to ".length).trim();
        i++;
        continue;
      }
      if (line.startsWith("new file mode")) {
        sec!.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        sec!.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // phase "none" or "between"
    if (line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
      startSection(null, null);
      continue;
    }
    if (line.startsWith("@@")) {
      if (phase === "none" || sec === null) return { parseErr: i + 1 };
      const a = parseHunkHeader(line);
      if (a === null) return { parseErr: i + 1 };
      hunk = { a, body: [] };
      phase = "body";
      i++;
      continue;
    }
    i++;
  }

  if (phase === "body") endBody();
  closeSection();
  if (sections.length === 0) return { parseErr: 1 };
  const edits: Edit[] = sections.map((s) => {
    const isCreate = s.isCreate || s.oldPath === null;
    const isDelete = !isCreate && (s.isDelete || s.newPath === null);
    return { kind: "unified", oldPath: s.oldPath, newPath: s.newPath, isCreate, isDelete, hunks: s.hunks };
  });
  return { edits };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSR(lines: string[]): ParseResult {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (t.startsWith("```")) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) return { parseErr: searchIdx + 1 };
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = trimEndWs(lines[j]);
      if (t === "=======") {
        eq = j;
        break;
      }
      if (t === ">>>>>>> REPLACE" || t === "<<<<<<< SEARCH") break;
    }
    if (eq === -1) return { parseErr: searchIdx + 1 };
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = trimEndWs(lines[j]);
      if (t === ">>>>>>> REPLACE") {
        rep = j;
        break;
      }
      if (t === "<<<<<<< SEARCH") break;
    }
    if (rep === -1) return { parseErr: searchIdx + 1 };
    edits.push({
      kind: "sr",
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) return { parseErr: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

function parseV4a(lines: string[]): ParseResult {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first === -1) return { parseErr: 1 };
  if (lines[first].trim() !== "*** Begin Patch") return { parseErr: first + 1 };
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== "*** End Patch") return { parseErr: n + 1 };

  const edits: Edit[] = [];
  let sec: {
    kind: "add" | "del" | "update";
    path: string;
    num: number;
    raw: Array<{ text: string; num: number }>;
  } | null = null;

  function closeSection(): { parseErr: number } | null {
    if (!sec) return null;
    const raw = sec.raw.slice();
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === "") raw.pop();
    if (sec.kind === "add") {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === "") fileLines.push("");
        else if (r.text.startsWith("+")) fileLines.push(r.text.slice(1));
        else return { parseErr: r.num };
      }
      edits.push({ kind: "v4a-add", path: sec.path, lines: fileLines });
    } else if (sec.kind === "del") {
      for (const r of raw) {
        if (r.text.trim() !== "") return { parseErr: r.num };
      }
      edits.push({ kind: "v4a-del", path: sec.path });
    } else {
      let idx = 0;
      let newPath: string | null = null;
      if (idx < raw.length && raw[idx].text.startsWith("*** Move to: ")) {
        newPath = raw[idx].text.slice("*** Move to: ".length).trim();
        idx++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      for (; idx < raw.length; idx++) {
        const r = raw[idx];
        const t = r.text;
        if (t.startsWith("@@")) {
          const anchorText = t.slice(2).trim();
          cur = { anchor: anchorText === "" ? null : anchorText, endOfFile: false, body: [] };
          chunks.push(cur);
          seenChunk = true;
        } else if (t === "" || t[0] === " " || t[0] === "-" || t[0] === "+") {
          if (cur === null) {
            if (seenChunk) return { parseErr: r.num };
            cur = { anchor: null, endOfFile: false, body: [] };
            chunks.push(cur);
            seenChunk = true;
          }
          cur.body.push({ k: t === "" ? " " : (t[0] as " " | "-" | "+"), text: t === "" ? "" : t.slice(1) });
        } else if (t.trim() === "*** End of File") {
          if (cur === null) return { parseErr: r.num };
          cur.endOfFile = true;
          cur = null;
        } else {
          return { parseErr: r.num };
        }
      }
      if (chunks.length === 0 && newPath === null) return { parseErr: sec.num };
      edits.push({ kind: "v4a-update", path: sec.path, newPath, chunks });
    }
    sec = null;
    return null;
  }

  for (let i = first + 1; i < last; i++) {
    const line = lines[i];
    const kind = line.startsWith("*** Add File: ")
      ? "add"
      : line.startsWith("*** Delete File: ")
        ? "del"
        : line.startsWith("*** Update File: ")
          ? "update"
          : null;
    if (kind) {
      const err = closeSection();
      if (err) return err;
      sec = { kind, path: line.slice(line.indexOf(": ") + 2).trim(), num: i + 1, raw: [] };
      continue;
    }
    if (sec === null) {
      if (line.trim() === "") continue;
      return { parseErr: i + 1 };
    }
    sec.raw.push({ text: line, num: i + 1 });
  }
  const err = closeSection();
  if (err) return err;
  if (edits.length === 0) return { parseErr: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function toJsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.command !== "string") return null;
  if (typeof o.path !== "string") return null;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    return { kind: "json-create", path: o.path, fileText: o.file_text };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") return null;
    let newStr = "";
    if ("new_str" in o) {
      if (typeof o.new_str !== "string") return null;
      newStr = o.new_str;
    }
    return { kind: "json-str", path: o.path, oldStr: o.old_str, newStr };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    return { kind: "json-insert", path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], text: string): ParseResult {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return { parseErr: 1 };
  if (lines[firstIdx].trimStart()[0] === "[") {
    const arrStartLine = firstIdx + 1;
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      return { parseErr: arrStartLine };
    }
    if (!Array.isArray(arr)) return { parseErr: arrStartLine };
    const edits: Edit[] = [];
    for (const obj of arr) {
      const e = toJsonEdit(obj);
      if (!e) return { parseErr: arrStartLine };
      edits.push(e);
    }
    if (edits.length === 0) return { parseErr: 1 };
    return { edits };
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return { parseErr: i + 1 };
    }
    const e = toJsonEdit(obj);
    if (!e) return { parseErr: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) return { parseErr: 1 };
  return { edits };
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC sections 5, 6, 7, 8, 9, 10)
// ---------------------------------------------------------------------------

function hunkParts(h: Hunk): { o: string[]; n: string[]; nCtx: number[]; lastMarker: boolean } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  let lastCp = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i].k === " " || h.body[i].k === "+") lastCp = i;
  }
  const lastMarker =
    lastCp >= 0 && lastCp + 1 < h.body.length && h.body[lastCp + 1].k === "\\";
  for (const b of h.body) {
    if (b.k === " ") {
      const idx = o.length;
      o.push(b.text);
      n.push(b.text);
      nCtx.push(idx);
    } else if (b.k === "-") {
      o.push(b.text);
    } else if (b.k === "+") {
      n.push(b.text);
      nCtx.push(-1);
    }
  }
  return { o, n, nCtx, lastMarker };
}

// Apply a section's hunks in order to a file's lines. Returns the new lines
// and final-break state, or a failure code.
function applyHunks(
  lines: string[],
  ends: boolean,
  hunks: Hunk[],
  strict: boolean,
): { fail?: string; lines: string[]; ends: boolean } {
  let cur = lines.slice();
  let curEnds = ends;
  let d = 0;
  for (const h of hunks) {
    const { o, n, nCtx, lastMarker } = hunkParts(h);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > cur.length) pos = cur.length;
      const atEnd = pos === cur.length;
      cur.splice(pos, 0, ...n);
      if (atEnd) curEnds = !lastMarker;
    } else {
      const found = findTier(cur, o, strict);
      if (!found) return { fail: "no-match", lines: cur, ends: curEnds };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(cur, best, o, n, nCtx, found.tier);
      const runsToEnd = best + o.length === cur.length;
      cur.splice(best, o.length, ...repl);
      if (runsToEnd) curEnds = !lastMarker;
    }
    d += n.length - o.length;
  }
  return { lines: cur, ends: curEnds };
}

function chunkParts(ch: VChunk): { o: string[]; n: string[]; nCtx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const b of ch.body) {
    if (b.k === " ") {
      const idx = o.length;
      o.push(b.text);
      n.push(b.text);
      nCtx.push(idx);
    } else if (b.k === "-") {
      o.push(b.text);
    } else if (b.k === "+") {
      n.push(b.text);
      nCtx.push(-1);
    }
  }
  return { o, n, nCtx };
}

function applyUnified(tree: Tree, e: Extract<Edit, { kind: "unified" }>, strict: boolean): Fail | null {
  for (const p of [e.oldPath, e.newPath]) {
    if (p !== null && !isSafePath(p)) return { code: "unsafe", path: p };
  }
  if (e.isCreate) {
    const np = e.newPath;
    if (np === null) return null;
    if (tree.exists(np)) return { code: "exists", path: np };
    const plus: string[] = [];
    let lastPlus: { h: number; j: number } | null = null;
    for (let hi = 0; hi < e.hunks.length; hi++) {
      const h = e.hunks[hi];
      for (let j = 0; j < h.body.length; j++) {
        if (h.body[j].k === "+") {
          plus.push(h.body[j].text);
          lastPlus = { h: hi, j };
        }
      }
    }
    let ends = true;
    if (lastPlus) {
      const h = e.hunks[lastPlus.h];
      if (lastPlus.j + 1 < h.body.length && h.body[lastPlus.j + 1].k === "\\") ends = false;
    }
    tree.set(np, serialize(plus, "\n", ends));
    return null;
  }
  if (e.isDelete) {
    const op = e.oldPath;
    if (op === null) return null;
    if (!tree.exists(op)) return { code: "missing", path: op };
    tree.del(op);
    return null;
  }
  const op = e.oldPath!;
  const np = e.newPath!;
  const isMove = op !== np;
  if (!tree.exists(op)) return { code: "missing", path: op };
  if (isMove && tree.exists(np)) return { code: "exists", path: np };
  const cur = tree.read(op);
  const parsed = parseText(cur.text);
  const res = applyHunks(parsed.lines, parsed.ends, e.hunks, strict);
  if (res.fail) return { code: res.fail, path: op };
  const text = serialize(res.lines, parsed.brk, res.ends);
  if (isMove) {
    tree.set(np, text);
    tree.del(op);
    tree.moves.push([op, np]);
  } else {
    tree.set(op, text);
  }
  return null;
}

function applySR(tree: Tree, e: Extract<Edit, { kind: "sr" }>, strict: boolean): Fail | null {
  if (!isSafePath(e.path)) return { code: "unsafe", path: e.path };
  if (e.oldLines.length === 0) {
    if (tree.exists(e.path)) return { code: "exists", path: e.path };
    tree.set(e.path, e.newLines.length === 0 ? "" : e.newLines.join("\n") + "\n");
    return null;
  }
  if (!tree.exists(e.path)) return { code: "missing", path: e.path };
  const cur = tree.read(e.path);
  const parsed = parseText(cur.text);
  const found = findTier(parsed.lines, e.oldLines, strict);
  if (!found) return { code: "no-match", path: e.path };
  if (found.occ.length > 1) return { code: "ambiguous", path: e.path };
  const pos = found.occ[0];
  const repl = buildReplacement(parsed.lines, pos, e.oldLines, e.newLines, e.newLines.map(() => -1), found.tier);
  const next = parsed.lines.slice();
  next.splice(pos, e.oldLines.length, ...repl);
  tree.set(e.path, serialize(next, parsed.brk, parsed.ends));
  return null;
}

function applyV4a(tree: Tree, e: Extract<Edit, { kind: "v4a-add" | "v4a-del" | "v4a-update" }>, strict: boolean): Fail | null {
  if (!isSafePath(e.path)) return { code: "unsafe", path: e.path };
  if (e.kind === "v4a-add") {
    if (tree.exists(e.path)) return { code: "exists", path: e.path };
    tree.set(e.path, e.lines.length === 0 ? "" : e.lines.join("\n") + "\n");
    return null;
  }
  if (e.kind === "v4a-del") {
    if (!tree.exists(e.path)) return { code: "missing", path: e.path };
    tree.del(e.path);
    return null;
  }
  if (e.newPath !== null && !isSafePath(e.newPath)) return { code: "unsafe", path: e.newPath };
  if (!tree.exists(e.path)) return { code: "missing", path: e.path };
  if (e.newPath !== null && tree.exists(e.newPath)) return { code: "exists", path: e.newPath };
  const cur = tree.read(e.path);
  const parsed = parseText(cur.text);
  let lines = parsed.lines.slice();
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      const found = findTier(lines, [ch.anchor], strict, cursor);
      if (!found) return { code: "no-match", path: e.path };
      cursor = found.occ[0] + 1;
    }
    const { o, n, nCtx } = chunkParts(ch);
    if (o.length === 0) {
      const pos = ch.endOfFile ? lines.length : cursor;
      lines.splice(pos, 0, ...n);
      cursor = pos + n.length;
    } else {
      const found = findTier(lines, o, strict, cursor);
      if (!found) return { code: "no-match", path: e.path };
      let occ = found.occ;
      if (ch.endOfFile) {
        occ = occ.filter((p) => p + o.length === lines.length);
        if (occ.length === 0) return { code: "no-match", path: e.path };
      }
      const pos = occ[0];
      const repl = buildReplacement(lines, pos, o, n, nCtx, found.tier);
      lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
  }
  const text = serialize(lines, parsed.brk, parsed.ends);
  if (e.newPath !== null) {
    tree.set(e.newPath, text);
    tree.del(e.path);
    tree.moves.push([e.path, e.newPath]);
  } else {
    tree.set(e.path, text);
  }
  return null;
}

function applyJson(tree: Tree, e: Extract<Edit, { kind: "json-create" | "json-str" | "json-insert" }>): Fail | null {
  if (!isSafePath(e.path)) return { code: "unsafe", path: e.path };
  if (e.kind === "json-create") {
    if (tree.exists(e.path)) return { code: "exists", path: e.path };
    tree.set(e.path, e.fileText);
    return null;
  }
  if (!tree.exists(e.path)) return { code: "missing", path: e.path };
  const cur = tree.read(e.path);
  const parsed = parseText(cur.text);
  if (e.kind === "json-str") {
    let text = cur.text;
    let oldS = e.oldStr;
    let newS = e.newStr;
    if (parsed.brk === "\r\n") {
      text = text.replace(/\r\n/g, "\n");
      oldS = oldS.replace(/\r\n/g, "\n");
      newS = newS.replace(/\r\n/g, "\n");
    }
    let count = 0;
    let first = -1;
    let idx = text.indexOf(oldS);
    while (idx !== -1) {
      count++;
      if (first === -1) first = idx;
      idx = text.indexOf(oldS, idx + 1);
    }
    if (count === 0) return { code: "no-match", path: e.path };
    if (count > 1) return { code: "ambiguous", path: e.path };
    const replaced = text.slice(0, first) + newS + text.slice(first + oldS.length);
    tree.set(e.path, parsed.brk === "\r\n" ? replaced.replace(/\n/g, "\r\n") : replaced);
    return null;
  }
  if (e.insertLine < 0 || e.insertLine > parsed.lines.length) {
    return { code: "no-match", path: e.path };
  }
  const ins = patchLines(e.newStr);
  const next = parsed.lines.slice();
  next.splice(e.insertLine, 0, ...ins);
  tree.set(e.path, serialize(next, parsed.brk, parsed.ends));
  return null;
}

function applyEdit(tree: Tree, e: Edit, strict: boolean): Fail | null {
  switch (e.kind) {
    case "unified":
      return applyUnified(tree, e, strict);
    case "sr":
      return applySR(tree, e, strict);
    case "v4a-add":
    case "v4a-del":
    case "v4a-update":
      return applyV4a(tree, e, strict);
    default:
      return applyJson(tree, e);
  }
}

// ---------------------------------------------------------------------------
// Output (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

function computeChanges(tree: Tree): string[] {
  const added: string[] = [];
  const deleted: string[] = [];
  const out: Array<{ key: string; line: string }> = [];
  for (const [p, orig] of tree.origEntries()) {
    const cur = tree.curState(p);
    if (!orig.exists && cur.exists) added.push(p);
    else if (orig.exists && !cur.exists) deleted.push(p);
    else if (orig.exists && cur.exists && orig.text !== cur.text) {
      out.push({ key: p, line: `M ${p}` });
    }
  }
  const moveFrom = new Map<string, string>();
  for (const [o, n] of tree.moves) moveFrom.set(o, n);
  const addedSet = new Set(added);
  const deletedSet = new Set(deleted);
  for (const d of [...deleted]) {
    const seen = new Set<string>([d]);
    let cur = d;
    while (moveFrom.has(cur) && !seen.has(moveFrom.get(cur)!)) {
      cur = moveFrom.get(cur)!;
      seen.add(cur);
    }
    if (cur !== d && addedSet.has(cur)) {
      out.push({ key: cur, line: `R ${d} -> ${cur}` });
      deletedSet.delete(d);
      addedSet.delete(cur);
    }
  }
  for (const a of addedSet) out.push({ key: a, line: `A ${a}` });
  for (const d of deletedSet) out.push({ key: d, line: `D ${d}` });
  out.sort((x, y) => Buffer.compare(Buffer.from(x.key, "utf8"), Buffer.from(y.key, "utf8")));
  return out.map((c) => c.line);
}

function writeChanges(tree: Tree): void {
  for (const [p, orig] of tree.origEntries()) {
    const cur = tree.curState(p);
    if (orig.exists === cur.exists && orig.text === cur.text) continue;
    if (!cur.exists) {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    } else {
      const dir = dirname(p);
      if (dir !== "." && dir !== "") mkdirSync(dir, { recursive: true });
      writeFileSync(p, cur.text, "utf8");
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const outLines: string[] = [];
  const out = (s: string): void => {
    outLines.push(s);
  };
  const finish = (code: number): void => {
    if (outLines.length > 0) process.stdout.write(outLines.join("\n") + "\n");
    process.exitCode = code;
  };

  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if ("usageErr" in parsed) {
    out("error: usage");
    finish(2);
    return;
  }
  const { format, check, strict, patch } = parsed.opts;

  let patchText: string;
  if (patch === null || patch === "-") {
    try {
      patchText = readFileSync(0, "utf8");
    } catch {
      patchText = "";
    }
  } else {
    try {
      patchText = readFileSync(patch, "utf8");
    } catch {
      out("error: no-patch");
      finish(2);
      return;
    }
  }

  const lines = patchLines(patchText);
  const fmt = format === "auto" ? detectFormat(lines) : format;
  if (fmt === null) {
    out("error: format");
    finish(2);
    return;
  }

  let result: ParseResult;
  if (fmt === "unified") result = parseUnified(lines);
  else if (fmt === "search-replace") result = parseSR(lines);
  else if (fmt === "v4a") result = parseV4a(lines);
  else result = parseJson(lines, patchText);
  if ("parseErr" in result) {
    out(`error: parse ${result.parseErr}`);
    finish(2);
    return;
  }
  const edits = result.edits;

  const tree = new Tree();
  const failures: Fail[] = [];
  for (const e of edits) {
    const f = applyEdit(tree, e, strict);
    if (f) failures.push(f);
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    finish(1);
    return;
  }

  const changes = computeChanges(tree);
  if (!check) writeChanges(tree);
  for (const c of changes) out(c);
  out(changes.length === 1 ? "ok: 1 file" : `ok: ${changes.length} files`);
  finish(0);
}

// ---------------------------------------------------------------------------
// Entry point (kept last: class declarations below the call would be in
// their temporal dead zone if this ran at the top of the file)
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import("./runner.ts");
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
