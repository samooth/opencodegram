# UI/UX WoW — plan de experiencia para opencodegram

> Objetivo: que el card deje de parecer un log y se sienta como un panel de
> control. Menos texto visible, cada estado con una acción obvia y el detalle
> siempre a un toque.

## Estado

**P0, P1 y P2 completados** (18 nov 2026). Validado con `bun run typecheck`,
`bun test` (364 tests en 39 archivos) y `bun run build`.

## Principios

1. **Una pantalla por card.** El estado, la telemetría y las acciones caben sin
   scroll. El transcript completo vive detrás de `📖 Leer` / paginación.
2. **Cada estado tiene una acción primaria.** Nunca un callejón sin salida.
3. **El detalle es opt-in.** Contadores compactos + `▾ Detalles`; nunca una
   pared de tool calls por defecto.
4. **Números consistentes.** `1m 42s`, `4.2k tok`, `38 tok/s`, `+48 −12`, `68% ctx`.
5. **Copy 100% en español**, un emoji por fila, sin sopa de emojis.
6. **Telegram-native.** Nada de widgets en grupos/topics. Botones inline,
   `copy_text` en privado, `blockquote expandable` como fallback.
7. **Ack inmediato.** Toda pulsación responde en <300 ms; si la acción tarda,
   el botón cambia a `⏳` y luego se edita el resultado.

## P0 — Impacto máximo, bajo riesgo (1–2 días)

### P0.1 Copy deck en español y estados consistentes
- [x] Traducir estados del card: `Working…` → `⏳ Trabajando…`, `Done` → `✅ Listo`, `Stopped` → `⏹ Detenido`.
- [x] Traducir secciones: `Thinking` → `Razonamiento`, `Tool calls` → `Herramientas`, `Edits` → `Cambios`.
- [x] Traducir contadores de actividad: pensamientos, lecturas, búsquedas, ediciones, comandos, herramientas.
- [x] Traducir botones: `Stop` → `Detener`, `Models` → `Modelos`, `Sessions` → `Sesiones`, `Full diffs` → `Diffs`.
- [x] Unificar toasts y avisos (`Creating…`, `Retrying…`, `Edit expired`).
- [x] Tests de copy actualizados y golden de estados.

### P0.2 Teclados contextuales por estado
- [x] Trabajando: `[⏹ Detener] [▾ Detalles]` como primera fila.
- [x] Listo: `[📄 Respuesta] [✏️ Cambios]` como primera fila.
- [x] Detenido: `[▶️ Continuar] [📥 Historial]`.
- [x] Error: `[🔁 Reintentar] [🧠 Cambiar modelo]`.
- [x] Mantener debajo actividad, recursos, diffs por archivo y navegación.
- [x] Test: cada estado expone su acción primaria y ninguna acción queda huérfana.

### P0.3 Turn Receipt
- [x] Al cerrar el turno mostrar: estado + duración, prompt, archivos `+N −M`, test detectado, tokens/tok/s/contexto.
- [x] Detectar `bun test`, `npm test`, `pytest`, `go test`, `cargo test` y su resultado.
- [x] Duración estable con `turnFinishedAt` (no depende del render).
- [x] Test unitario del recibo y de la detección de tests.

### P0.4 Errores accionables y estados expirados
- [x] Guardar `lastTurnError` y renderizar `⚠️ Turno interrumpido` con causa en una línea.
- [x] Botones `🔁 Reintentar` y `🧠 Cambiar modelo` en el card.
- [x] `edit:`/`edits:full:` expirados responden con alerta clara y salida al panel/último turno.
- [x] Test: error de rate limit produce card accionable; snapshot ausente no rompe.

### P0.5 Botones de copiar
- [x] `📋 Copiar respuesta` con `copy_text` en privado cuando el texto cabe (≤256).
- [x] Fallback en grupo: `📋 Copiar` envía bloque `<pre>` fácil de mantener pulsado.
- [x] `📋 Copiar prompt` y `📋 Copiar comando` cuando aplique.
- [x] Test de gating privado/grupo y de límite de 256 caracteres.

### P0.6 Línea de telemetría
- [x] `⏱ duración · ⚡ tok/s · N tok · 68% ctx` en el card vivo y en el recibo.
- [x] Ocultar tok/s con menos de 100 tokens (evitar cifras engañosas).
- [x] Test de formato y de contexto ausente.

## P1 — Estructura y navegación (3–5 días)

### P1.1 Card compacto + modo lectura
- [x] Card por defecto ≤1.200 caracteres y ≤3 filas de botones.
- [x] `📖 Leer` transforma el mismo mensaje en transcript paginado.
- [x] `⬅ Volver` restaura el panel sin crear mensajes nuevos.

### P1.2 Rail de últimas 3 acciones
- [x] Pipeline en vivo: `✅ Leer…`, `✅ Editar…`, `⏳ bun test` (en el detalle compacto; se retiró el rail duplicado).
- [x] Sin progreso falso: tiempo real, última acción y tokens.
- [x] El detalle completo sigue en `▾ Detalles`.

### P1.3 Navegación por turnos
- [x] `Turno 3/12` en lugar de `3/12`; selector con resumen de una línea.
- [x] `⏭ Último` visible si el usuario se alejó del final.
- [x] Mini “previously on…” de 2 líneas al cambiar de turno.

### P1.4 Revisión de cambios tipo PR
- [x] Tabla `archivo +N −M` y acciones por archivo.
- [x] `📦 Descargar .patch` listo para aplicar.
- [x] `📋 Copiar diff` (privado) y fallback a bloque de código.

### P1.5 Mission control
- [x] Chips de sesión con estado real (🟢/⚪/🔴) y tap para conectar.
- [ ] Sparklines Unicode para CPU/RAM/GPU — desactivadas a petición del usuario; se conservan barras y flecha de tendencia.
- [x] Coste acumulado si el modelo expone precios.

### P1.6 Presets de estilo
- [x] Minimal / Balanced / Verbose / Terminal.
- [x] Persistidos por chat y aplicables desde `/settings`.

## P2 — Producto (1–2 semanas)

- [x] Web App Mission control (solo privado; en grupos solo botones).
- [x] Recap de sesión al reconectar.
- [x] Búsqueda dentro de la conversación.
- [x] Onboarding con demo corta y tips progresivos.
- [x] Efectos/celebración opcional al entregar la respuesta final.
- [x] Pasada de accesibilidad y tests golden de UX por estado.

## Presupuestos medibles

| Métrica | Objetivo |
| --- | --- |
| Ack visual de un tap | <300 ms |
| Primer estado del card | <1 s |
| Card por defecto | ≤1.200 caracteres |
| Filas de botones | ≤3 en el card compacto |
| Ediciones por card | ≤1/s y ≤20/min |
| Copy en español | 100% |
| Estados con acción | 100% |
| Errores con recuperación | 100% |

## Criterios de aceptación P0

1. Todos los estados del card (trabajando, listo, detenido, error) muestran su
   acción primaria en la primera fila.
2. El turno terminado muestra un recibo con duración, cambios, test y tokens.
3. Un error de proveedor se lee en una línea y ofrece reintentar o cambiar de
   modelo sin salir del card.
4. Un botón de diff expirado explica qué pasó y ofrece una salida.
5. En privado se puede copiar respuesta/prompt; en grupo el fallback sigue
   siendo utilizable.
6. `bun run typecheck`, `bun test` y `bun run build` pasan.
