// Localization coverage helpers: collect the English keys a template-built UI
// shows, and audit the translation tables.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
export const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', larr: '←', rarr: '→', times: '×' };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');
const HOLE = '\u0000';
/** Decode one backslash escape at src[j] (\uXXXX, \u{…}, \n, or the literal next char). */
function esc(src, j) {
  const c = src[j + 1];
  if (c === 'u' && src[j + 2] === '{') { const k = src.indexOf('}', j); return { ch: String.fromCodePoint(parseInt(src.slice(j + 3, k), 16)), end: k + 1 }; }
  if (c === 'u') return { ch: String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)), end: j + 6 };
  if (c === 'n') return { ch: '\n', end: j + 2 };
  return { ch: c, end: j + 2 };
}

/** Load classic-script string tables into one object. */
export function loadTables(root, files, globalName) {
  const sandbox = { self: {} };
  sandbox.window = sandbox.self;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), sandbox);
  return sandbox.self[globalName];
}

/** English keys passed to T('…') / N('…'), including T(c ? '…' : '…'). */
export function codeKeys(src, fns = ['T', 'N']) {
  const keys = new Set();
  const f = fns.join('|');
  const lit = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${f})\(\s*(?:${lit})`, 'g'))) keys.add(unq(m[1] ?? m[2]));
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${f})\((?:[^()'"?]|'[^'\n]*'|\([^()]*\))*\?\s*(?:${lit})\s*:\s*(?:${lit})`, 'g'))) {
    keys.add(unq(m[1] ?? m[2])); keys.add(unq(m[3] ?? m[4]));
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/**
 * Every string / template literal in a JS source, with ${…} replaced by a hole
 * marker. A small lexer: skips comments and regex literals.
 */
export function literals(src) {
  const out = [];
  let i = 0;
  let prev = '';
  const n = src.length;
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(?:return|typeof|case|of|in)$/.test(prev) || prev === '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === '/' && regexAllowed()) {
      i++; let cls = false;
      while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
      i++; while (/[a-z]/.test(src[i] || '')) i++;
      prev = 'x'; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c) { if (src[j] === '\\') { const e = esc(src, j); s += e.ch; j = e.end; continue; } s += src[j]; j++; }
      out.push(s); i = j + 1; prev = 'x'; continue;
    }
    if (c === '`') {
      const r = template(src, i + 1);
      out.push(...r.nested, r.text); i = r.end; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = (prev + c).slice(-8);
    i++;
  }
  return out;
}
function template(src, i) {
  let text = '';
  const nested = [];
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { text += src[i + 1]; i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') {
      // Expression: find the matching brace, collecting nested literals.
      let depth = 1, j = i + 2; const start = j;
      while (j < src.length && depth) {
        const d = src[j];
        if (d === '`') { const r = template(src, j + 1); j = r.end; continue; }
        if (d === "'" || d === '"') { let k = j + 1; while (k < src.length && src[k] !== d) { if (src[k] === '\\') k++; k++; } j = k + 1; continue; }
        if (d === '{') depth++; else if (d === '}') depth--;
        j++;
      }
      nested.push(...literals(src.slice(start, j - 1)));
      text += HOLE; i = j; continue;
    }
    text += src[i]; i++;
  }
  return { text, nested, end: i + 1 };
}

/** Static text and aria-label/title/placeholder/alt values inside HTML-ish literals. */
export function htmlKeys(literal, { strict = false } = {}) {
  const keys = new Set();
  if (!/<\/?[a-z]/i.test(literal) && !strict) return [];
  let body = literal.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|code|kbd)\b[\s\S]*?<\/\1>/g, '')
    .replace(/<(\w+)[^>]*\bdata-i18n-skip\b[^>]*>[\s\S]*?<\/\1>/g, '');
  for (const m of body.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) {
    const v = norm(decode(m[2]));
    if (/[A-Za-z]/.test(v) && !v.includes(HOLE)) keys.add(v);
  }
  body = body.replace(/<[^<>]*>/g, '<>');
  for (const seg of body.split('<>')) {
    for (const part of seg.split(HOLE)) {
      const v = norm(decode(part));
      if (/[A-Za-z]{2}/.test(v)) keys.add(v);
    }
  }
  return [...keys];
}

/** Text segments inside HTML literals that also contain an interpolation (must use T()). */
export function mixedSegments(literal) {
  if (!/<\/?[a-z]/i.test(literal)) return [];
  const body = literal.replace(/<(script|style|code|kbd)\b[\s\S]*?<\/\1>/g, '').replace(/<[^<>]*>/g, '<>');
  return body.split('<>').filter((seg) => seg.includes(HOLE) && /[A-Za-z]{2}/.test(seg.split(HOLE).join(' '))).map((s) => norm(s.split(HOLE).join('…')));
}

/** Problems: missing translations in full locales, placeholder drift, stale or unknown keys. */
export function audit(tables, used, { allowUnused = [] } = {}) {
  const usedSet = new Set(used);
  const problems = [];
  for (const loc of FULL) {
    const t = tables[loc] || {};
    for (const k of usedSet) if (!Object.prototype.hasOwnProperty.call(t, k)) problems.push(`${loc} missing: ${k}`);
  }
  for (const [loc, table] of Object.entries(tables)) {
    if (!LOCALES.includes(loc)) problems.push(`unknown locale ${loc}`);
    for (const [k, v] of Object.entries(table)) {
      if (!usedSet.has(k) && !allowUnused.includes(k)) { problems.push(`${loc} unused: ${k}`); continue; }
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      if (want !== got) problems.push(`${loc} placeholders: ${k}`);
      const tagsK = (k.match(/<\/?\w+/g) || []).sort().join();
      const tagsV = (String(v).match(/<\/?\w+/g) || []).sort().join();
      if (tagsK !== tagsV) problems.push(`${loc} markup: ${k}`);
    }
  }
  for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!tables[loc]) problems.push(`no ${loc} table`);
  return problems;
}

/** A sandbox with sh-language.js + tables + the engine; returns the engine global. */
export function bootI18n(root, { files, global, event, languages = ['de-DE'] }) {
  const events = [];
  const doc = {
    documentElement: { lang: 'en' }, body: null,
    dispatchEvent: (e) => { if (e.type === event) events.push(e.detail.lang); },
    addEventListener() {},
  };
  const sandbox = {
    document: doc, location: { search: '' },
    navigator: { languages, language: languages[0] },
    localStorage: { getItem: () => null, setItem: () => {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o.detail; } },
    URLSearchParams,
  };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), sandbox);
  return { I18N: sandbox[global], events, doc };
}

/** English keys in the static <body> markup of index.html (text and labels). */
export function markupKeys(html) {
  let body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/g, '');
  return htmlKeys(body, { strict: true });
}

/**
 * String / template literals with the code just before them (for el()-built UIs
 * whose text children are plain literals). `before` is the preceding source
 * with whitespace collapsed (last 40 chars).
 */
export function literalsWithContext(src) {
  const out = [];
  let i = 0;
  let prev = '';
  const n = src.length;
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(?:return|typeof|case|of|in)$/.test(prev) || prev === '';
  const ctx = (at) => src.slice(Math.max(0, at - 80), at).replace(/\s+/g, ' ').slice(-40);
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === '/' && regexAllowed()) {
      i++; let cls = false;
      while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
      i++; while (/[a-z]/.test(src[i] || '')) i++;
      prev = 'x'; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const at = i;
      let j = i + 1, s = '', depth = 0;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { const e = esc(src, j); s += e.ch; j = e.end; continue; }
        if (c === '`' && d === '$' && src[j + 1] === '{') { depth = 1; j += 2; s += '\u0000'; while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; } continue; }
        if (d === c) break;
        s += d; j++;
      }
      out.push({ text: s, before: ctx(at), template: c === '`' });
      i = j + 1; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = (prev + c).slice(-8);
    i++;
  }
  return out;
}

const CODE_CONTEXT = /(?:class|className|style|id|role|src|href|type|for|name|key|kind|op|action|mode|screen|theme|layout|lang|rel|sel|selector)\s*:\s*$|\.(?:querySelector(?:All)?|getElementById|closest|matches|on|off|emit|event|play|setAttribute|getAttribute|removeAttribute|toggle|contains|add|remove|startsWith|endsWith|includes|split|join|replace|createElement|addEventListener|removeEventListener|get|set|has|delete|setItem|getItem|removeItem|dispatchEvent|log|warn|error|track|unlock|send|_api|api|indexOf)\(\s*$|(?<![\w$.])(?:\$|fetch|Error|CustomEvent|createElement)\(\s*$|(?:===|!==|==|!=|case)\s*$|\[\s*$/;

/** Prose literals (likely shown to players) in an el()-built UI module. */
export function proseLiterals(src) {
  return literalsWithContext(src)
    .filter((l) => !CODE_CONTEXT.test(l.before) && !/\b(?:T|N)\(\s*$/.test(l.before))
    .map((l) => l.text)
    .filter((t) => /[A-Za-z]{2}/.test(t) && !t.includes('\u0000') && !/^[a-z0-9_.:#/-]+$/.test(t) && !/^[a-z-]+(?: [a-z-]+)*$/.test(t) && !/[<>{}=]/.test(t))
    .map((t) => norm(t));
}

/** Template literals with words and an interpolation, outside T() (must be converted). */
export function proseTemplates(src) {
  return literalsWithContext(src)
    .filter((l) => l.template && l.text.includes('\u0000') && !/\b(?:T|N)\(\s*$/.test(l.before) && !CODE_CONTEXT.test(l.before))
    .map((l) => l.text)
    .filter((t) => /[A-Za-z]{2,}/.test(t.replace(/<[^>]*>/g, '')) && !/^[\w-]*\u0000[\w-]*$/.test(t) && !/^(?:[a-z0-9_-]+ )*[a-z0-9_-]*\u0000?$/.test(t))
    .map((t) => norm(t.replace(/\u0000/g, '…')));
}
