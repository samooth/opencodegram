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
    cancel: "❌ Cancelar",
    confirmYes: "✅ Sí, crear nueva",
    newSession: "➕ Nueva sesión",
    newSessionHere: "➕ Nueva sesión aquí",
    noActiveSessionShort: "No hay sesión activa",
    loadingModels: "⏳ Cargando modelos…",
    chooseRepo: "Elige el repositorio para la nueva sesión:",
    onlyAdminSettings: "⚙️ Solo un admin de este chat puede cambiar los ajustes.",
    onlyAdminExport: "📊 Solo un admin puede exportar el histórico de todos los chats.",
    onlyAdminDelete: "🗑 Solo un admin de este chat puede borrar sesiones.",
    activeSessionWarn: "⚠️ Ya hay una sesión activa:",
    createNewQuestion: "¿Crear una nueva y reemplazarla?",
    noResults: "Sin resultados para",
    noActiveInGroup: "🤖 No hay sesiones activas en este grupo.",
    whichSession: "¿A qué sesión respondo?",
    createOrChoose: "Crea una nueva o elige una existente para empezar.",
    sessionsActive: "sesiones activas. Elige una.",
    changesBackground: "✅ Comando enviado a segundo plano (equivalente a Ctrl+B).",
    sessionContent: "📜 Contenido de la sesión",
    stats: "📊 Estado",
    content: "📂 Contenido",
    status: "📊 Estado",
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
    cancel: "❌ Cancel",
    confirmYes: "✅ Yes, create new",
    newSession: "➕ New session",
    newSessionHere: "➕ New session here",
    noActiveSessionShort: "No active session",
    loadingModels: "⏳ Loading models…",
    chooseRepo: "Choose the repository for the new session:",
    onlyAdminSettings: "⚙️ Only a chat admin can change the settings.",
    onlyAdminExport: "📊 Only an admin can export all chats history.",
    onlyAdminDelete: "🗑 Only a chat admin can delete sessions.",
    activeSessionWarn: "⚠️ There is already an active session:",
    createNewQuestion: "Create a new one and replace it?",
    noResults: "No results for",
    noActiveInGroup: "🤖 No active sessions in this group.",
    whichSession: "Which session should I reply to?",
    createOrChoose: "Create a new one or choose an existing one to start.",
    sessionsActive: "active sessions. Choose one.",
    changesBackground: "✅ Command sent to background (same as Ctrl+B).",
    sessionContent: "📜 Session content",
    stats: "📊 Status",
    content: "📂 Content",
    status: "📊 Status",
  },
};

let current: Locale = (process.env.LOCALE ?? "es").toLowerCase().startsWith("en") ? "en" : "es";

/** Resolve locale from LOCALE env (es|en), default es. */
export function initLocale(envLocale?: string): Locale {
  const v = (envLocale ?? process.env.LOCALE ?? "es").toLowerCase();
  current = v.startsWith("en") ? "en" : "es";
  return current;
}

export function setLocale(l: Locale): Locale { current = l; return current; }

export function locale(): Locale {
  return current;
}

/** Translate a key, falling back to Spanish then to the key itself. */
export function t(key: string, loc?: Locale): string {
  const l = loc ?? current;
  return DICT[l][key] ?? DICT.es[key] ?? key;
}
