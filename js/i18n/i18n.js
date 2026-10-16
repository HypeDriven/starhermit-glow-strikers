/* Glow Strikers — localization engine (classic script, loaded before the game modules).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/i18n/strings.js and strings-content.js fill
 * window.GS_STRINGS (en-GB, es-ES and fr-CA carry only their differences from
 * en-US, es-419 and fr-FR). The locale comes from the game's Language setting
 * through sh-language.js (explicit choice → StarHermit account preference →
 * navigator.languages → en-US); ?lang= forces one for the page load (QA).
 *
 * The UI is built from HTML templates, so the DOM is translated where it is
 * rendered: a MutationObserver translates every text node and every
 * aria-label / title / placeholder / alt whose whole (trimmed) English text is
 * a key, remembers the key, and re-translates those nodes in place when the
 * language changes. Text assembled at runtime goes through T() and re-renders
 * on the `gs-language` event. Subtrees marked data-i18n-skip, <kbd>, <code>,
 * <script> and <style> are left alone.
 * Browser global: window.GSI18N.
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var TABLES = root.GS_STRINGS || {};
  var KEYS = TABLES['es-419'] || {};
  var ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
  var SKIP = { SCRIPT: 1, STYLE: 1, KBD: 1, CODE: 1, NOSCRIPT: 1, CANVAS: 1 };
  var hasOwn = Object.prototype.hasOwnProperty;
  var lang = 'en-US';

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders filled from vars. */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? String(vars[k]) : m; });
    return s;
  }

  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  // ---- DOM translation -------------------------------------------------------
  var texts = new WeakMap();   // text node -> { key, pre, post, last }
  var attrs = new WeakMap();   // element -> { attr: { key, last } }

  function skipped(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (SKIP[n.tagName] || n.hasAttribute('data-i18n-skip')) return true;
    }
    return false;
  }
  function textNode(node) {
    var v = node.nodeValue;
    var rec = texts.get(node);
    if (rec && v === rec.last) {
      var again = rec.pre + T(rec.key) + rec.post;
      if (again !== v) { rec.last = again; node.nodeValue = again; }
      return;
    }
    var key = norm(v);
    if (!key || !hasOwn.call(KEYS, key) || skipped(node.parentNode)) { texts.delete(node); return; }
    var m = /^(\s*)[\s\S]*?(\s*)$/.exec(v);
    var out = m[1] + T(key) + m[2];
    texts.set(node, { key: key, pre: m[1], post: m[2], last: out });
    if (out !== v) node.nodeValue = out;
  }
  function attr(el, name) {
    var v = el.getAttribute(name);
    if (v == null) return;
    var map = attrs.get(el);
    var rec = map && map[name];
    if (rec && v === rec.last) {
      var again = T(rec.key);
      if (again !== v) { rec.last = again; el.setAttribute(name, again); }
      return;
    }
    var key = norm(v);
    if (!hasOwn.call(KEYS, key) || skipped(el)) { if (rec) delete map[name]; return; }
    if (!map) { map = {}; attrs.set(el, map); }
    var out = T(key);
    map[name] = { key: key, last: out };
    if (out !== v) el.setAttribute(name, out);
  }
  function element(el) {
    for (var i = 0; i < ATTRS.length; i++) if (el.hasAttribute(ATTRS[i])) attr(el, ATTRS[i]);
  }
  /** Translate (or re-translate) a subtree. */
  function translate(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { textNode(rootNode); return; }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) { if (skipped(rootNode)) return; element(rootNode); }
    var walker = document.createTreeWalker(rootNode, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode: function (n) {
        if (n.nodeType === 1 && (SKIP[n.tagName] || n.hasAttribute('data-i18n-skip'))) return 2; // REJECT subtree
        return 1;
      }
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) textNode(n); else element(n);
    }
  }

  var observer = null;
  function observe() {
    if (observer || !document.body || typeof MutationObserver === 'undefined') return;
    translate(document.body);
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') { for (var j = 0; j < r.addedNodes.length; j++) translate(r.addedNodes[j]); }
        else if (r.type === 'characterData') textNode(r.target);
        else if (r.type === 'attributes') attr(r.target, r.attributeName);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    document.documentElement.lang = lang;
    if (document.body) translate(document.body);
    document.dispatchEvent(new CustomEvent('gs-language', { detail: { lang: lang } }));
  }

  var forced = null;
  try { forced = new URLSearchParams(root.location.search).get('lang'); } catch (e) { /* opaque origin */ }
  var SL = root.StarHermitLanguage;
  var forcedLocale = forced && SL ? SL.match(forced, LOCALES) : null;
  var language = SL ? SL.create({
    game: 'glow-strikers', supported: LOCALES, panel: !forcedLocale,
    apply: function (locale) { setLocale(forcedLocale || locale); }
  }) : null;
  if (!language) setLocale('en-US');
  if (document.body) observe();
  else document.addEventListener('DOMContentLoaded', observe);

  root.GSI18N = {
    T: T,
    get lang() { return lang; },
    locales: LOCALES,
    language: language,
    tables: TABLES,
    translate: translate,
    has: function (key) { return hasOwn.call(KEYS, norm(key)); }
  };
})(typeof self !== 'undefined' ? self : this);
