// A fast drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree makefun-site's build returns
// for a case's site, byte for byte, in a fraction of the CPU time. One dependency-free ES module.
//
// Where the time goes in the reference, and what this module does instead:
//   - HTML escaping is done in bulk over plain runs of text (the reference escapes character by character from its
//     inline renderer, its single hottest function).
//   - The inline renderer is one pass with plain-run accumulation and index-based scans, not slice-and-recurse per
//     character; the block pass classifies lines with charCode probes instead of a battery of regexes and builds
//     the HTML directly, with no token objects in between.
//   - Slugs are memoised (titles, tag names and headings repeat across a generated site), with an ASCII fast path
//     that skips Unicode normalisation entirely.
//   - Front matter is scanned line by line from the head of the file only; the body is one slice, never a split
//     and re-join of the whole text.
//   - Word counts (reading time) are counted by a code-unit scan with the exact \s set, not a match() array.
// Every rule, message and quirk is makefun-site's own, as its README and code state them.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const escCb = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped, and nothing else. Returns the string itself when there is nothing to do. */
function escapeHtml(text) {
  return ESC_ANY.test(text) ? text.replace(ESC_ALL, escCb) : text;
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;
const slugCache = new Map();

/** The slug of `text`, exactly makefun-site's rule; memoised, since titles, tags and headings repeat. */
function slugify(text) {
  let out = slugCache.get(text);
  if (out === undefined) {
    out = slugifyRaw(text);
    if (slugCache.size < 1 << 16) slugCache.set(text, out);
  }
  return out;
}

function slugifyRaw(text) {
  // ASCII is unchanged by NFKD and holds no combining marks, so the normalisation only runs when it can bite.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    else if (code >= 65 && code <= 90) keep = code + 32;
    if (keep < 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is in JavaScript's \s set. */
function isWsCode(code) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  );
}



// ---------------------------------------------------------------- paths

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. The reference scans the whole text for the closing "---" before it validates a line, splits the
 * text into lines and re-joins the tail as the body; this walks line starts from the head and takes the body as one
 * slice, which is the same text and the same first error.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // The head lines (between the two "---" lines), and where the body starts.
  const head = [];
  let bodyStart = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    head.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < head.length; k++) {
    const line = head[k];
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown
//
// The reference lexes blocks into token objects and renders them after; this fuses the two passes and classifies
// lines with charCode probes. The block grammar, in the order the reference tries it: blank, fence, heading,
// thematic break, blockquote, list, paragraph. A paragraph runs until a blank line, a fence, a heading or a break
// (a quote or list line under text is paragraph text).

/** A line of nothing but spaces and tabs (or nothing). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opening's language, or null: three backticks, language characters, then spaces or tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A fence closing: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line's level and text, or null. The reference's regex cannot span a line separator (its "." stops
 * there), so a text holding one is not a heading; its lazy text group is the rest of the line with trailing
 * spaces and tabs dropped, and an empty text is not a heading.
 */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let start = depth;
  while (start < line.length) {
    const cc = line.charCodeAt(start);
    if (cc !== 32 && cc !== 9) break;
    start++;
  }
  let end = line.length;
  while (end > start) {
    const cc = line.charCodeAt(end - 1);
    if (cc !== 32 && cc !== 9) break;
    end--;
  }
  if (end === start) return null;
  for (let i = start; i < end; i++) {
    const cc = line.charCodeAt(i);
    if (cc === 8232 || cc === 8233) return null;
  }
  return { depth, text: line.slice(start, end) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isBreak(line) {
  const a = line.charCodeAt(0);
  if ((a !== 45 && a !== 42) || line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A bullet item's text, or null: "- " or "* " and the rest of the line. The reference's capture is a regex ".",
 * which cannot span a line separator, so on a body that holds one (the caller passes hasLS) a line holding one is
 * not an item; on any other body the check cannot bite and is skipped.
 */
function bulletOf(line, hasLS) {
  const a = line.charCodeAt(0);
  if ((a !== 45 && a !== 42) || line.charCodeAt(1) !== 32) return null;
  if (hasLS && (line.indexOf('\u2028') !== -1 || line.indexOf('\u2029') !== -1)) return null;
  return line.slice(2);
}

/** An ordered item's number and text, or null: 1 to 9 digits, ". " and the rest of the line. */
function orderedOf(line, hasLS) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  if (hasLS && (line.indexOf('\u2028') !== -1 || line.indexOf('\u2029') !== -1)) return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** A list continuation: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * Whether the character at `j` is the second half of a backslash escape pair, scanning from `from`. The
 * reference scans forward, consuming a "\" and an escapable next character as a pair; within the run of
 * backslashes that ends just before `j` (clipped at `from`), the pairing starts at the run's first unconsumed
 * backslash, so `s[j]` is consumed exactly when the clipped run's length is odd and it is itself escapable.
 */
function isEscapedAt(s, j, from) {
  if (!ESCAPABLE.has(s[j])) return false;
  let r = j;
  while (r > from && s[r - 1] === '\\') r--;
  return (j - r) % 2 === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscapedAt(s, j, from)) j = s.indexOf(what, j + 1);
  return j;
}

/**
 * The first single * from `from`, outside an escape, or -1. The reference walks the text consuming escape
 * pairs; at a * whose next character is also * it steps over the pair (so the pair's second * is never a
 * candidate), and any other * it meets is the closer. The checks below replay that walk over the * positions
 * only: an escaped * is one the walk steps over as a pair's second half, and a ** steps two positions on.
 */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscapedAt(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

const TARGET_WS = /\s/;

/**
 * The special characters of inline, found with one regex scan. Every exec is preceded by an explicit lastIndex
 * assignment, so the recursive calls below (which scan other strings) cannot disturb an outer scan.
 */
const SPECIAL_RE = /[\\`*[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One pass: plain characters accumulate into a run that
 * is escaped in bulk when a construct opens (the reference escapes character by character, and its escapes of a
 * plain run are the bulk escape of that run, since escaping is a per-character map). Constructs that fail stay in
 * the run, exactly as the reference writes them literally and moves on. Plain runs are skipped over with indexOf,
 * not walked character by character.
 */
function inline(s, env) {
  let out = '';
  let runStart = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (m === null) break;
    i = m.index;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > runStart) out += escapeHtml(s.slice(runStart, i));
        out += s[i + 1] === '>' ? '&gt;' : s[i + 1];
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > runStart) out += escapeHtml(s.slice(runStart, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > runStart) out += escapeHtml(s.slice(runStart, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > runStart) out += escapeHtml(s.slice(runStart, i));
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      let linked = false;
      if (k !== -1 && s[k + 1] === '(') {
        const m = s.indexOf(')', k + 2);
        if (m !== -1) {
          const target = s.slice(k + 2, m);
          if (target !== '' && !TARGET_WS.test(target)) {
            if (i > runStart) out += escapeHtml(s.slice(runStart, i));
            out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
            i = m + 1;
            runStart = i;
            linked = true;
          }
        }
      }
      if (!linked) i++;
      continue;
    }
    i++;
  }
  if (n > runStart) out += escapeHtml(s.slice(runStart, n));
  return out;
}

/** The words of one line: its runs of characters other than whitespace (a line holds no "\n", a word never spans one). */
function countLineWords(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    // The \s set, inlined: at or below the space only the space and \t..\r count; above it, the Unicode
    // members (all at 160 or beyond, so a code below 160 settles it at once).
    const ws =
      c <= 32
        ? c === 32 || (c >= 9 && c <= 13)
        : c >= 160 && (c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML), its excerpt (the first paragraph's inline HTML, or "") and its word count
 * (the body's words, counted line by line as the lines are consumed — the same total a pass over the whole
 * body gives, since a word never spans the "\n" between lines, and blank lines hold none).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const hasLS = src.indexOf('\u2028') !== -1 || src.indexOf('\u2029') !== -1;
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  let words = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      words += countLineWords(line);
      i++;
      const start = i;
      while (i < lines.length && !isFenceClose(lines[i])) {
        words += countLineWords(lines[i]);
        i++;
      }
      let body = '';
      if (i > start) body = `${escapeHtml(lines.slice(start, i).join('\n'))}\n`;
      if (i < lines.length) {
        words += countLineWords(lines[i]);
        i++;
      }
      html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${lang}">${body}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      words += countLineWords(line);
      i++;
      continue;
    }
    if (isBreak(line)) {
      html += '<hr>\n';
      words += countLineWords(line);
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        words += countLineWords(lines[i]);
        let rest = lines[i].slice(1);
        if (rest.charCodeAt(0) === 32) rest = rest.slice(1);
        const t = trimLine(rest);
        if (t !== '') body.push(t);
        i++;
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line, hasLS);
    const ordered = bullet === null ? orderedOf(line, hasLS) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let parts = null;
      while (i < lines.length) {
        const text = isOrdered ? orderedOf(lines[i], hasLS)?.text : bulletOf(lines[i], hasLS);
        if (text !== undefined && text !== null) {
          parts = [trimLine(text)];
          items.push(parts);
          words += countLineWords(lines[i]);
          i++;
        } else if (parts !== null && isContinued(lines[i])) {
          parts.push(trimLine(lines[i]));
          words += countLineWords(lines[i]);
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      html += `${open}\n`;
      for (const itemParts of items) html += `<li>${inline(itemParts.join('\n'), env)}</li>\n`;
      html += `</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    words += countLineWords(line);
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      words += countLineWords(lines[i]);
      body.push(trimLine(lines[i++]));
    }
    const inner = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates
//
// The reference's dialect, parsed once per template into the same node tree and rendered by walking it in a chain
// of scopes. The parser below follows its tokenizer and its errors word for word (a failed template's message
// lands in build-report.txt); the renderer keeps its lookup, truthiness and value-to-text rules exactly.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  // Tokenize: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it.
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path`: its first name from the nearest binding, then own properties. Bindings live on two
 * parallel stacks (names / values) that for-loops push and pop, with the render's own variables as the root
 * object underneath — the reference's scope chain, without an object allocated per loop iteration. A loop binds
 * its element and then `loop`, so `loop` is met first walking down, as the reference's one vars object holds it.
 */
function tplLookup(env, path) {
  const head = path[0];
  const names = env.names;
  const values = env.values;
  for (let k = names.length - 1; k >= 0; k--) {
    if (names[k] === head) return tplDescend(values[k], path);
  }
  if (!Object.hasOwn(env.root, head)) return undefined;
  return tplDescend(env.root[head], path);
}

/** The rest of a path, from a value whose first name is already read: own properties or undefined. */
function tplDescend(v, path) {
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplTextOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `env` (the binding stacks over a root object); `ctx` holds the parsed templates. */
function renderNodes(nodes, env, ctx, depth) {
  let out = '';
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(tplTextOf(tplLookup(env, n.path)));
        break;
      case 'raw':
        out += tplTextOf(tplLookup(env, n.path));
        break;
      case 'if': {
        const v = tplTruthy(tplLookup(env, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, env, ctx, depth);
        break;
      }
      case 'for': {
        const xs = tplLookup(env, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const names = env.names;
        const values = env.values;
        const mark = names.length;
        for (let k = 0; k < len; k++) {
          names.push(n.name, 'loop');
          values.push(xs[k], { index: k + 1, first: k === 0, last: k === len - 1, length: len });
          out += renderNodes(n.body, env, ctx, depth);
          names.length = mark;
          values.length = mark;
        }
        break;
      }
      case 'include': {
        if (depth < INCLUDE_DEPTH) {
          const f = ctxFn(ctx, n.name);
          if (f !== undefined) out += f(env, ctx, depth + 1);
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- template compilation
//
// A template renders once per page, so walking its node tree node by node is the build's hottest loop after
// Markdown. Each template is therefore compiled, on its first render, into a plain string-building function:
// literal text and every path, name and number of the tree go in as JSON literals (data, never code — a path is
// a validated list of identifiers, a loop name a validated identifier), and the body only concatenates strings
// and calls the same lookup / truthiness / text / escape helpers the interpreter uses, with the same binding
// stack and the same include depth rule. Nothing from a template or a case is ever evaluated as code beyond the
// shape the tree dictates. A template whose compilation fails for any reason falls back to the interpreter
// above, which renders it identically.

/**
 * escapeHtml for a template variable's text: titles, urls, names and dates repeat from page to page, so a short
 * value's escape is remembered. Long values (a summary, an excerpt) are escaped directly.
 */
const escCache = new Map();
function escapeHtmlCached(s) {
  if (s.length > 128) return escapeHtml(s);
  let r = escCache.get(s);
  if (r === undefined) {
    r = escapeHtml(s);
    if (escCache.size < 1 << 15) escCache.set(s, r);
  }
  return r;
}

/** The helpers a compiled template calls. inc renders an include at the next depth, or "" when it renders nothing. */
const TPL_HELPERS = {
  lk: tplLookup,
  txt: tplTextOf,
  tr: tplTruthy,
  escv: escapeHtmlCached,
  inc: (ctx, name, env, depth) => {
    const f = ctxFn(ctx, name);
    return f === undefined ? '' : f(env, ctx, depth + 1);
  },
};

/** The compiled renderer of the template `name` in `ctx`, or undefined when no such template parsed. */
function ctxFn(ctx, name) {
  let f = ctx.fns.get(name);
  if (f === undefined) {
    const nodes = ctx.templates.get(name);
    if (nodes === undefined) return undefined;
    f = compileOrFallback(nodes);
    ctx.fns.set(name, f);
  }
  return f;
}

/** A template's renderer: its compiled function, or the interpreter over its tree when compilation fails. */
function compileOrFallback(nodes) {
  try {
    const fn = compileTemplate(nodes);
    return (env, ctx, depth) => fn(env, ctx, depth, TPL_HELPERS);
  } catch {
    return (env, ctx, depth) => renderNodes(nodes, env, ctx, depth);
  }
}

/** `nodes` compiled into a function (env, ctx, depth, H) -> string, as described above. */
function compileTemplate(nodes) {
  // Each distinct path becomes one constant array, shared by every lookup that names it.
  const pathConsts = new Map();
  const pathRef = (path) => {
    const key = JSON.stringify(path);
    let ref = pathConsts.get(key);
    if (ref === undefined) {
      ref = `P${pathConsts.size}`;
      pathConsts.set(key, ref);
    }
    return ref;
  };
  const parts = [];
  let uid = 0;
  const emit = (list) => {
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          parts.push(`out += ${JSON.stringify(n.text)};`);
          break;
        case 'var': {
          const v = `v${uid++}`;
          parts.push(`{ const ${v} = H.lk(env, ${pathRef(n.path)}); out += H.escv(typeof ${v} === "string" ? ${v} : H.txt(${v})); }`);
          break;
        }
        case 'raw': {
          const v = `v${uid++}`;
          parts.push(`{ const ${v} = H.lk(env, ${pathRef(n.path)}); out += typeof ${v} === "string" ? ${v} : H.txt(${v}); }`);
          break;
        }
        case 'if':
          parts.push(`if (H.tr(H.lk(env, ${pathRef(n.path)})) !== ${n.not}) {`);
          emit(n.then);
          if (n.else !== null) {
            parts.push('} else {');
            emit(n.else);
          }
          parts.push('}');
          break;
        case 'for': {
          const id = uid++;
          parts.push(`{ const xs${id} = H.lk(env, ${pathRef(n.path)}); if (Array.isArray(xs${id})) { const len${id} = xs${id}.length; const names = env.names; const values = env.values; const mark${id} = names.length;`);
          parts.push(`for (let k${id} = 0; k${id} < len${id}; k${id}++) { names.push(${JSON.stringify(n.name)}, "loop"); values.push(xs${id}[k${id}], { index: k${id} + 1, first: k${id} === 0, last: k${id} === len${id} - 1, length: len${id} });`);
          emit(n.body);
          parts.push(`names.length = mark${id}; values.length = mark${id}; } } }`);
          break;
        }
        case 'include':
          parts.push(`if (depth < ${INCLUDE_DEPTH}) out += H.inc(ctx, ${JSON.stringify(n.name)}, env, depth);`);
          break;
      }
    }
  };
  emit(nodes);
  const consts = [...pathConsts].map(([key, ref]) => `const ${ref} = ${key};`).join('\n');
  return new Function('env', 'ctx', 'depth', 'H', `${consts}\nlet out = "";\n${parts.join('\n')}\nreturn out;`);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it; a post's card is the one the collections stage already built for it. */
function pageOf(s, card) {
  return {
    ...(card ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** One site's output tree: path -> text. The reference's pipeline, stage for stage. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. The checks run in
  // the reference's order, and the first one that fails is the one reported.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name. A source's links repeat,
  // so each source resolves a target once and remembers it (a broken target is still reported, once, through the
  // same Set the reference collects it in).
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const cache = new Map();
    const env = {
      link: (target) => {
        let r = cache.get(target);
        if (r !== undefined) return r;
        r = resolveLink(b, s, dir, target, staticPaths);
        cache.set(target, r);
        return r;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and slug.
  // A source's own tags are its tag names with each slug kept once (the first spelling), in its own order; the
  // pairs are worked out once here, where the reference re-derives each slug as it goes.
  const bySlug = new Map();
  const ownTagPairs = (s) => {
    const list = s.data.tags ?? [];
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      let dup = false;
      for (const pair of out) {
        if (pair.slug === slug) {
          dup = true;
          break;
        }
      }
      if (!dup) out.push({ name, slug });
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTagPairs(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTagPairs(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs, then the static files.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, fns: new Map() };
  const render = (name, vars) => {
    const f = ctxFn(ctx, name);
    if (f === undefined) return null;
    const root = { site, tags: allTags, recent };
    Object.assign(root, vars);
    return f({ root, names: [], values: [] }, ctx, 0);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, b.cards.get(s)) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageTotal = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** One link's href, as the reference's markdown stage resolves it (see its index.js). */
function resolveLink(b, s, dir, target, staticPaths) {
  if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
  if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
  b.broken.add(`broken-link ${s.path} -> ${target}`);
  return target;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
