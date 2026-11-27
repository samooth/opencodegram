# Roadmap

## Done

- Per-topic session isolation with persisted tab bindings (`data/active.json`).
- Modular daemon: store, sessions, status, panels, events, commands, callbacks,
  messages, updates and Telegram/OpenCode bridges.
- Rich status card: thinking, tool calls, Stop button, final answer, tok/s.
- Model and variant picker (free models first), agent picker.
- Permission approvals, including reject-with-reason.
- Multimedia ingestion (photo/document/audio/voice/video) with vision auto-switch.
- Outbound documents via `sendDocument` and `/file`.
- Safe file browser: `/ls`, `/find`, `/read`, inline navigation, pagination,
  hidden-file toggle, symlink confinement and text preview limits.
- `/zip` archives and automatic delivery of files produced by a turn.
- Local voice-note transcription with configurable Whisper-compatible CLI.
- Worktree management: list, create, remove and switch the active session.
- VCS actions: branch switching, staging/unstaging and commits with confirmation.
- MCP status: list, connect, disconnect, remove servers and browse resources.
- Operations: health endpoint, metrics, audit log rotation and disk guard.
- Automated Bun tests for routing/tab isolation, path guard, `/file`, file
  browser, transcription, rate-limit retry and command parsing (`bun test`).
- `/vcs` status, `/worktrees` listing, `/forms` + `/formreply`.
- `/sync` history replay, `/context`, `/usage`, `/diff`, `/compact`.
- Rate-limit retry at `:15` of the next hour.
- Audit log (`data/audit.log`) and per-update error isolation.
- Webhook mode (optional) with secret validation; long polling remains default.
- Update offset persistence and update dedup to avoid replayed prompts.
- Bounded auto-retry (max attempts, stale-prompt guard); /retry falls back to
  the most recent session in the chat.
- Per-turn prompt persistence (`data/turnPrompts.json`) for dataset exports.
- Export formats: HTML (safe Markdown rendering), Markdown, JSON-LD and JSONL.
- Per-session transcript persistence (`data/transcripts/`), pagination cache and
  attachment cleanup with TTL.
- Voice transcription via a bundled HuggingFace Whisper wrapper with automatic
  language detection.
- Graceful handling of Telegram 429 (`retry_after`), 502 outages and 409
  conflict on restart.
- Group media policy: photos/documents require an explicit mention; voice notes
  also work as a reply to the bot.
- Adaptive per-chat throttle, enriched `/ops` health (throttles + GPU).
- OpenCode 2.3.0 in Docker: background subagents and fork/subagent badges, MCP
  events, quieter transcripts (card verbosity setting).
- Expandable per-turn activity blocks (thoughts, reads, shells, forms) with a
  single footer stats line, a live 💬 Respuesta section that accumulates all
  streamed answers below the shell, a 🤖 block listing subagent sessions, and
  the OpenCode `todo` checklist; no extra messages.
- Browser tooling: optional OpenCode Browse (real browser via extension) and
  always-on Playwright MCP (headless Chromium for web debugging).
- Streaming transcription (SSE) with partial text published to the card.
- Card theme (auto/light/dark), card verbosity and read-text LRU cache.
- `/todos`, `/unlink`, `/cancel` commands; per-user rate limiting opt-in via env.
- Code quality: zero `any` in `src`, structured logging, unified save/load
  helpers, no silent `answerCallbackQuery` failures.

## 0.3.0 (plan)

### A. Robustez y observabilidad
- [ ] Graceful degradation si OpenCode cae: notificar, reintentar y no colgar.
- [ ] Daemon persistente para Whisper (diseñar según entorno).
- [ ] Coalescing de deltas (publicar cada 500 ms en vez de cada delta).
- [ ] Caché LRU de lecturas recientes para no repetir I/O.
- [ ] Exportar rango de turnos (desde/hasta turno N).
- [ ] Métricas de latencia de transcripción.
- [ ] Ampliar logging: cubrir los `.catch` restantes en rutas de archivo/media.

### B. UX del card y sesiones
- [ ] Secciones colapsables por sesión (no globales).
- [ ] `/retry` con selección de turno.
- [ ] `/search` sobre prompts de usuario (hoy solo bloques).
- [ ] Resumen automático de sesión para el título del topic.
- [ ] Modo solo lectura para grupos.
- [ ] Preview de imágenes en el card.
- [ ] Progreso de descarga para archivos grandes.
- [ ] Paginación de botones del card (>56 páginas).
- [ ] Adaptación de tema claro/oscuro a preferencias de Telegram.

### C. Seguridad (residuales)
- [x] Mitigar DNS rebinding en `/mcp read` (fijar IP tras lookup; verificado en `mcp.ts`).
- [x] Reintentar acks fallidos por red (`answerCallbackQuery` con 3 intentos y backoff).
- [x] Códigos de un solo uso para la web app (`webauth.ts`): `/web` emite un código canjeable por una cookie HttpOnly; el token estático queda como fallback.
- [x] Auth opcional en `/health`/`/metrics` cuando `OPS_HOST != 127.0.0.1` (`OPS_AUTH_TOKEN`).

### D. Arquitectura y limpieza
- [x] Reducir `status.ts`: `renderThinkingBottom`, `renderLatestToolBottom` y `lastReasoning` extraídos a `status-render.ts`.
- [x] Validar paths en `downloadOne` (whitelist de extensiones → `.bin` para desconocidas).
- [x] Rate limiting por usuario (opt-in, ya existe flag global `USER_RATE_LIMIT_ENABLED`).
- [x] Documentar módulos `config/doctor/opencode/persist` y `commands/*` en AGENTS.md (tabla ampliada con `stats.ts`, `widgets.ts`).

### E. SQLite + UX 100% por botones (0.4.0) — completado
- [x] Crear `src/db.ts`: una sola BD `data/opencodegram.db` (WAL) con tabla `kv_state` para estado JSON y esquema relacional de permisos.
- [x] Helper `jsonRead`/`jsonWrite` con migración transparente desde `data/*.json` (espejo JSON como backup, external edits ganan).
- [x] Migrar `permissions.ts` a la BD central (incluye importación de `permissions.db` 0.3.x y `permissions.json`).
- [x] Migrar `settings.ts`, `store.ts` y `updates.ts` al helper SQLite.
- [x] Tests `tests/db.test.ts`: migración JSON/DB legada, persistencia entre instancias, espejo y estadísticas (8 tests).
- [x] Panel "🗄 Datos" accesible por botón desde el panel principal (sin `/comandos`).
- [x] Callbacks `db:info`, `db:refresh`, `db:vacuum` (admin), `db:back` con render en el mismo mensaje.
- [x] Convertir los comandos del bot en botones `botcmd:` dentro de `⚡ Comandos` (peligrosos excluidos).
- [x] Documentar BD y panel por botones en README/AGENTS/ARCHITECTURE/COMMANDS.
- [x] Validar `typecheck && test && build` (483 tests), recargar daemon y commitear.

### Siguiente orden sugerido
SQLite + botones → graceful degradation → resumen automático → `/retry` con turno → `/search` sobre prompts → daemon Whisper.

## Next (legacy)
