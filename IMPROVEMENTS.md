# Posibles mejoras — opencodegram

Lista exhaustiva de mejoras identificadas tras revisión del código.
No commitear este archivo (es solo documentación de trabajo).

---

## 1. Rendimiento y escalabilidad

1. **Cachear paginación del transcript** — `renderPage` llama a `paginateTranscript` en cada `publish` (cada 3s en streaming). Para sesiones largas es O(n) por edición. Cachear por `sessionId + blockCount`.
2. **Fragmentar persistencia de transcripts** — `saveTranscripts` serializa todo el mapa cada 2s. Con muchas sesiones es costoso. Archivo por sesión (`transcripts/{sid}.json`).
3. **Coalescing de deltas más agresivo** — `handleSessionTextDelta` llama `updateStatus` en cada delta (aunque throttled). Acumular deltas y publicar cada 500ms.
4. **Limpiar attachments con TTL** — `/tmp/opencode/attachments/` crece sin límite. Añadir cleanup de archivos >24h.
5. **Lazy loading de modelos en transcripción** — El script carga el modelo Whisper en cada invocación (~1-2s). Un daemon persistente o caché en memoria reduciría latencia.
6. **Optimizar `renderResourceBlock`** — Llama a `readGpuInfo`/`readMemoryPercent` en cada render. Ya tiene caché de 5s, pero el bloque se regenera igual.

## 2. UI/UX del card (sesión)

7. **Mostrar prompt del usuario en el card** — Actualmente solo en exports. Añadir un bloque colapsable `👤 Prompt` al inicio del turno.
8. **Botón "Ver completo" más accesible** — `lastFinalText` se limpia en cada turno; el botón desaparece. Mantenerlo disponible para turnos anteriores.
9. **Colapsar/expandir secciones por defecto** — Settings `showThinking`, `showTools` etc. son globales. Permitir por-sesión o por-turno.
10. **Indicador de progreso de descarga** — Archivos grandes (>10MB) se descargan sin feedback. Barra de progreso.
11. **Preview de imagen en el card** — Las fotos se envían como documentos. Mostrar thumbnail inline.
12. **Paginación de botones del card** — `pagePickerKeyboard` soporta hasta 56 botones. Para sesiones con >56 páginas, colapsar.
13. **Animación de "escribiendo"** — `sendChatAction("typing")` cada 4s. Podría ser más frecuente o usar draft preview.
14. **Tema claro/oscuro** — El card usa HTML fijo. Adaptar a preferencias de Telegram (dark mode).

## 3. Funcionalidad

15. **Exportar en JSONL** — Además de JSON-LD, exportar una línea por turno (formato OpenAI fine-tuning).
16. **Exportar rango de turnos** — Para sesiones muy largas, permitir exportar desde/hasta turno N.
17. **`/search` sobre prompts** — Actualmente busca en bloques de respuesta. Extender a prompts de usuario.
18. **`/retry` con selección de turno** — Reintentar un turno específico, no solo el último.
19. **`/diff` entre turnos** — Comparar dos versiones de un archivo editado en distintos turnos.
20. **Soporte multi-idioma de transcripción** — Auto-detectar idioma en lugar de hardcodear `es`.
21. **Transcripción cloud (fallback)** — Si el modelo local falla, usar API cloud (OpenAI Whisper API).
22. **Resumen automático de sesión** — Generar un resumen del turno (1-2 líneas) para el topic title.
23. **Modo "solo lectura" para grupos** — Permitir que miembros del grupo vean el card pero no envíen prompts.
24. **Comando `/fork`** — Crear una rama de la sesión en un nuevo topic.

## 4. Robustez y observabilidad

25. **Logging no silencioso** — Reemplazar `.catch(() => {})` por `logger.warn` en rutas críticas (publish, edits, deep-link, transcription). ✅ En progreso
26. **Tests para gating de media en grupos** — No hay tests para la nueva regla de media. Añadir.
27. **Tests para export HTML con markdown** — Verificar que `markdownToHtml` se aplica y no hay XSS.
28. **Tests para binding de prompt por turno** — Verificar que `turnPromptsBySession` se persiste y recupera.
29. **Health endpoint enriquecido** — Exponer: tasa de 429, último error, estado de OpenCode, VRAM.
30. **Reintentos de `sendDocument`/`sendRichMessage`** — Solo `call()` tiene retry. Los métodos de envío de documentos no.
31. **Rotación de logs** — `audit.log` y `sessions.log` crecen sin límite. Rotar por tamaño.
32. **Graceful degradation si OpenCode cae** — Si OpenCode no responde, el bot debería notificar y reintentar, no colgarse.
33. **Métricas de latencia de transcripción** — Registrar tiempo de transcripción para optimizar.

## 5. Seguridad

34. **Sanitizador HTML dedicado para exports** — `markdownToHtml` ya escapa, pero un sanitizer explícito (DOMPurify-style) sería defensa en profundidad.
35. **Validar paths en `downloadOne`** — El nombre del archivo se sanitiza parcialmente. Añadir whitelist de extensiones.
36. **Rate limiting por usuario** — Evitar que un usuario floodée el bot con mensajes.
37. **Verificar firma de webhooks** — Si se usa webhook mode, verificar `secret_token`.

## 6. Código y arquitectura

38. **Extraer lógica de "turn" a un helper** — `turnSeq` increment, prompt binding, pageBreak están repartidos entre `status`, `messages`, `callbacks`. Centralizar.
39. **Tipar `any` en `events.ts`** — Formularios, tool parts usan `any`. Usar tipos del SDK.
40. **Unificar constantes duplicadas** — `MAX_READ_BYTES`/`MAX_DOCUMENT_BYTES` existen en `constants.ts` y `files/path.ts`. Eliminar duplicado. ✅ Hecho
41. **Reducir tamaño de `status.ts`** — 1023 líneas. Extraer `renderLiveParts`, `renderFinished`, `finishedKeyboard` a un módulo.
42. **Eliminar `s.timer` residual** — Ya eliminado. ✅ Hecho
43. **Unificar `escapeRegExp` / `esc`** — `esc` se usa en muchos lugares; considerar un módulo de sanitización único.
44. **Documentar el contrato de `EventsDeps`** — La interfaz es grande; documentar cada campo.

## 7. Transcripción de audio

45. **Daemon persistente para Whisper** — Cargar el modelo una vez y servir vía socket/HTTP. Reduce latencia de 2-4s a <500ms.
46. **Auto-detectar idioma** — Whisper soporta detección automática. No requerir `VOICE_TRANSCRIPTION_LANGUAGE`.
47. **Soporte para modelos más grandes** — Permitir configurar `whisper-medium` o `whisper-large` vía env.
48. **Transcripción en streaming** — Mostrar texto parcial mientras se transcribe (para audios largos).
49. **Caché de transcripciones** — Si el mismo audio se reenvía, no retranscribir.
50. **Manejo de audio en grupos sin mención** — Permitir transcripción de voz en grupos si es respuesta al bot (ya implementado para voz, pero no para fotos).

---

**Leyenda:** ✅ = ya implementado en esta sesión.
**Prioridad sugerida:** 1, 2, 25, 29, 38, 45.
