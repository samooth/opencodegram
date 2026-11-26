/**
 * Minimal i18n layer for user-visible strings.
 *
 * Spanish is the default (backwards compatible). Set LOCALE=en to get English
 * UI strings. Auto-detection from Telegram's `language_code` is a phase-2
 * addition; for now the locale is resolved once at startup from env/setting.
 *
 * Strings that are already universal (icons like ⏹ 🔁 🧠 📂 ⚙️ 🏠) are not
 * translated. Only human words are.
 */
export type Locale = "es" | "en";

const DICT: Record<Locale, Record<string, string>> = {
  es: {
    stop: "⏹ Detener",
    retry: "🔁 Reintentar",
    changeModel: "🧠 Cambiar modelo",
    panel: "🏠 Panel",
    sessions: "📂 Sesiones",
    settings: "⚙️ Ajustes",
    export: "📥 Exportar",
    history: "📥 Historial",
    copy: "📋 Copiar",
    copyAnswer: "📋 Copiar respuesta",
    copyCommand: "📋 Copiar comando",
    copyDiff: "📋 Copiar diff",
    back: "⬅ Volver",
    more: "▾ Más",
    less: "▴ Menos",
    details: "▾ Ver detalles",
    hideDetails: "▴ Ocultar detalles",
    done: "✅ Listo",
    answer: "💬 Respuesta",
    fullAnswer: "📄 Respuesta",
    readAnswer: "📖 Respuesta",
    viewFull: "Ver completo",
    last: "⏭ Última",
    reasoning: "🧠 Razonamiento",
    thinking: "💭 Pensamiento",
    shell: "⚡ Shell",
    tools: "🔧 Herramientas",
    model: "🧠 Modelo",
    noModel: "sin modelo",
    turn: "Turno",
    noTurn: "Sin turno",
    empty: "(vacío)",
    noBlocks: "(sin bloques)",
    background: "En segundo plano",
    occupyTab: "otra sesión ocupa la pestaña",
    loadingSessions: "⏳ Cargando sesiones…",
    loadingStatus: "⏳ Cargando estado…",
    noSession: "No hay sesión activa.",
    noContext: "No hay contexto todavía: envía el primer mensaje.",
    save: "💾 Guardar",
    focus: "🔀 Enfocar",
    openSession: "🔗 Abrir sesión",
    patch: "📦 Patch",
    resetMetrics: "♻️ Reset métricas",
  },
  en: {
    stop: "⏹ Stop",
    retry: "🔁 Retry",
    changeModel: "🧠 Change model",
    panel: "🏠 Panel",
    sessions: "📂 Sessions",
    settings: "⚙️ Settings",
    export: "📥 Export",
    history: "📥 History",
    copy: "📋 Copy",
    copyAnswer: "📋 Copy answer",
    copyCommand: "📋 Copy command",
    copyDiff: "📋 Copy diff",
    back: "⬅ Back",
    more: "▾ More",
    less: "▴ Less",
    details: "▾ View details",
    hideDetails: "▴ Hide details",
    done: "✅ Done",
    answer: "💬 Answer",
    fullAnswer: "📄 Answer",
    readAnswer: "📖 Answer",
    viewFull: "View full",
    last: "⏭ Last",
    reasoning: "🧠 Reasoning",
    thinking: "💭 Thinking",
    shell: "⚡ Shell",
    tools: "🔧 Tools",
    model: "🧠 Model",
    noModel: "no model",
    turn: "Turn",
    noTurn: "No turn",
    empty: "(empty)",
    noBlocks: "(no blocks)",
    background: "In background",
    occupyTab: "another session owns this tab",
    loadingSessions: "⏳ Loading sessions…",
    loadingStatus: "⏳ Loading status…",
    noSession: "No active session.",
    noContext: "No context yet: send the first message.",
    save: "💾 Save",
    focus: "🔀 Focus",
    openSession: "🔗 Open session",
    patch: "📦 Patch",
    resetMetrics: "♻️ Reset metrics",
  },
};

let current: Locale = (process.env.LOCALE ?? "es").toLowerCase().startsWith("en") ? "en" : "es";

/** Resolve locale from LOCALE env (es|en), default es. */
export function initLocale(envLocale?: string): Locale {
  const v = (envLocale ?? process.env.LOCALE ?? "es").toLowerCase();
  current = v.startsWith("en") ? "en" : "es";
  return current;
}

export function locale(): Locale {
  return current;
}

/** Translate a key, falling back to Spanish then to the key itself. */
export function t(key: string): string {
  return DICT[current][key] ?? DICT.es[key] ?? key;
}
