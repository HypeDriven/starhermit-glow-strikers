// The nine StarHermit locales and the nearest one to a BCP 47 tag (en-GB,
// es-ES and fr-CA by region), as the browser build's gfx-strings.js picked them.
export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const LANG_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = LOCALES.find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split('-');
  if (lang === 'es') return region === 'es' ? 'es-ES' : 'es-419';
  if (lang === 'en' && ['gb', 'ie', 'au', 'nz', 'za', 'in'].includes(region)) return 'en-GB';
  if (lang === 'fr' && region === 'ca') return 'fr-CA';
  return LANG_DEFAULT[lang] ?? 'en-US';
}
