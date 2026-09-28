// Localized strings for the Graphics settings section. The rest of the UI is
// English-only; this table picks a locale from navigator.language.

const EN = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', fromPreset: 'From preset ({tier})',
  renderScale: 'Render scale', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; rendering without it.',
  gpuUnknown: 'unknown GPU',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Colour grade', antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles', background: 'Arena motion', detail: 'Arena detail' },
  tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed' },
};

const US = { ...EN, cats: { ...EN.cats, grade: 'Color grade' } };

const ES = {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', fromPreset: 'Según el ajuste ({tier})',
  renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; se renderiza sin él.',
  gpuUnknown: 'GPU desconocida',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado', reflections: 'Reflejos', particles: 'Partículas', background: 'Movimiento del escenario', detail: 'Detalle del escenario' },
  tiers: { off: 'No', on: 'Sí', low: 'Bajas', medium: 'Medias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Sencillo', detailed: 'Detallado' },
};
const ES_419 = { ...ES, fromPreset: 'Según el preajuste ({tier})', showFps: 'Mostrar cuadros por segundo' };

const DE = {
  graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', fromPreset: 'Laut Voreinstellung ({tier})',
  renderScale: 'Renderskalierung', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne sie gerendert.',
  gpuUnknown: 'unbekannte GPU',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Partikel', background: 'Arena-Bewegung', detail: 'Arena-Details' },
  tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert' },
};

const FR = {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})', fromPreset: 'Selon le préréglage ({tier})',
  renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement est indisponible sur cet appareil ; rendu sans post-traitement.',
  gpuUnknown: 'GPU inconnu',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage', antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules', background: "Animation de l'arène", detail: "Détails de l'arène" },
  tiers: { off: 'Non', on: 'Oui', low: 'Basses', medium: 'Moyennes', high: 'Hautes', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statique', animated: 'Animée', plain: 'Sobre', detailed: 'Détaillée' },
};
const FR_CA = { ...FR, showFps: 'Afficher les images par seconde (IPS)', cats: { ...FR.cats, antialias: 'Anticrénelage (lissage)' } };

const PT_BR = {
  graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', fromPreset: 'Conforme a predefinição ({tier})',
  renderScale: 'Escala de renderização', adaptive: 'Resolução adaptativa', showFps: 'Mostrar quadros por segundo',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; renderizando sem ele.',
  gpuUnknown: 'GPU desconhecida',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização', reflections: 'Reflexos', particles: 'Partículas', background: 'Movimento da arena', detail: 'Detalhes da arena' },
  tiers: { off: 'Não', on: 'Sim', low: 'Baixas', medium: 'Médias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado' },
};

const IT = {
  graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', fromPreset: 'Da preimpostazione ({tier})',
  renderScale: 'Scala di rendering', adaptive: 'Risoluzione adattiva', showFps: 'Mostra fotogrammi al secondo',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il rendering prosegue senza.',
  gpuUnknown: 'GPU sconosciuta',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Particelle', background: "Movimento dell'arena", detail: "Dettagli dell'arena" },
  tiers: { off: 'No', on: 'Sì', low: 'Basse', medium: 'Medie', high: 'Alte', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato' },
};

export const GFX_STRINGS = {
  'en-US': US, 'en-GB': EN, 'es-419': ES_419, 'es-ES': ES, 'de-DE': DE,
  'fr-FR': FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT,
};

const LANG_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick the best supported locale for a BCP-47 tag (exact, then region rules, then language). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(GFX_STRINGS).find(k => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split('-');
  if (lang === 'es') return region === 'es' ? 'es-ES' : 'es-419';
  if (lang === 'en' && ['gb', 'ie', 'au', 'nz', 'za', 'in'].includes(region)) return 'en-GB';
  if (lang === 'fr' && region === 'ca') return 'fr-CA';
  return LANG_DEFAULT[lang] ?? 'en-US';
}

export function gfxStrings(tag = (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) {
  return GFX_STRINGS[pickLocale(tag)];
}
