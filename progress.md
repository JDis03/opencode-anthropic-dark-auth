## 2026-11-09 23:23 — opencode-anthropic-dark-auth
**Summary**: Arreglé la rotación 429: handleRateLimit ahora salta cuentas expiradas (+test). Deshabilité 3 cuentas vencidas en dark-auth-accounts.json (backup .bak-20261109) y cambié la activa a 817251cb (sin rate limit).
**Verified**: npm test 51 passed (1 nuevo); npm run build OK; verificado el estado del JSON de cuentas por script (3 deshabilitadas, activa 817251cb). Sin requests reales a Anthropic, sin reiniciar el servicio, sin commit.
**Completed**: none
---
## 2026-10-07 08:20 — opencode-anthropic-dark-auth
**Summary**: Implementé renovación de cuentas secundarias en dark-auth v2 para que la rotación por rate limit 429 funcione con 2 cuentas: refreshSecondaryAccounts() renueva solo cuentas que no posee OpenCode Core, desde el timer de 5 min.
**Verified**: npm test: 50 passed (4 tests nuevos: solo secundaria, exclusiones, Core desconocido, timer end-to-end); npm run build OK; git diff --check limpio. Sin reinicio de servicio ni requests reales a Anthropic; sin commit.
**Completed**: none
---
## 2026-10-07 08:17 — opencode-anthropic-dark-auth
**Summary**: Revisé si dark-auth v2 permite usar una segunda cuenta al llegar al rate limit: la rotación 429 existe, pero la cuenta secundaria caduca en ~8h sin renovarse, así que en la práctica falla salvo recién conectada.
**Verified**: Lectura de src/v2.ts (retry 429 -> handleRateLimit, chequeo expiresAt) y core credential.ts create (borra credenciales previas del integration). Sin cambios de código ni tests.
**Completed**: none
---
## 2026-09-25 04:18 — opencode-anthropic-dark-auth
**Summary**: Diagnostiqué y corregí el fallo recurrente OAuth refresh failed en dark-auth v2: el plugin refrescaba anticipadamente en el request hook y timer (60 min antes) y rotaba su cuenta local sin actualizar el refresh token en la conexión OpenCode v2 (Core refresca solo a 5 min). El request/retry/timer ya no refrescan de forma independiente; solo el callback OAuth renueva y retorna al Core, con deduplicación de refresh simultáneo. Tras reconectar, cuenta activa local y conexión v2 coinciden. No reinicié el servicio para no interrumpir la sesión actual; queda pendiente recarga para activar el build compilado.
**Verified**: SQLite consultada mediante backup en memoria sin volcar secretos; no hay errores reales de refresh después de reconectar (se excluyeron logs INFO de comandos diagnósticos); npm test 46 passed; npm run build correcto; git diff --check limpio. Sin llamadas a Anthropic ni prueba de renovación real. No commit/publish.
**Completed**: none
---
## 2026-09-25 04:03 — opencode-anthropic-dark-auth
**Summary**: Aclaré el comportamiento esperado: tras completar una conexión nueva en v2, el callback OAuth refresh debe renovar y persistir tokens sin volver a pedir login, pero no se puede garantizar hasta probar una renovación real; el estado previo no permite concluir que el mecanismo funciona.
**Verified**: Revisado flujo src/v2.ts refresh callback (búsqueda de cuenta por refresh token, refreshIfNeeded o refreshToken, retorno oauthCredential), sin cambios ni requests de red.
**Completed**: none
---
## 2026-09-25 04:01 — opencode-anthropic-dark-auth
**Summary**: Diagnostiqué el error OAuth refresh failed de dark-auth v2; la conexión de OpenCode v2 tiene refresh inválido o desconectado de cuentas locales y Claude Code carece de tokens para resincronizar. Recomendé reconectar Anthropic con método Dark Auth desde /connect o auth login, sin alterar credenciales ni modificar código.
**Verified**: opencode service status muestra servidor activo, opencode auth list muestra OAuth almacenado, plugin list confirma dark-auth local, inspección de metadatos sin exponer tokens; ningún request a Anthropic ni cambios a credenciales.
**Completed**: none
---
## 2026-09-23 13:55 — opencode-anthropic-dark-auth
**Summary**: Aclaré que OpenCode v2 descubre automáticamente el shim local desde el directorio global de plugins y que por eso la ruta al repositorio no figura directamente en opencode.json; no se hicieron cambios.
**Verified**: Configuración y activación del plugin corroboradas en sesión anterior mediante opencode plugin list y API /api/plugin.
**Completed**: none
---
## 2026-09-23 13:53 — opencode-anthropic-dark-auth
**Summary**: Arreglé el descubrimiento del plugin v2 creando un shim global index.mjs que reexporta el build local y quitando la ruta de repositorio no descubierta de plugins[]. Confirmé con la API de OpenCode v2 que opencode-anthropic-dark-auth está active; quedan fallos independientes en otros plugins v1 y falta probar un request real de Anthropic.
**Verified**: opencode plugin list muestra opencode-anthropic-dark-auth local; opencode api GET /api/plugin reportó state.status=active; npm run build y npm test (44 passed); git diff --check; no petición a Anthropic.
**Completed**: none
---
## 2026-09-23 13:52 — opencode-anthropic-dark-auth
**Summary**: Corregí el descubrimiento local de dark-auth v2 creando un shim global index.mjs que reexporta dist/v2.js y retirando únicamente la ruta del repo del array plugins global. No se reinició servicio ni se hizo commit.
**Verified**: dist/v2.js exporta default object con id y setup función; import Node ESM del shim conserva id/setup sin ejecutar setup; opencode.json parsea como JSON y plugins pasó de 4 a 3 sin la ruta objetivo; shim contiene exactamente un comentario y el reexport indicado.
**Completed**: none
---
## 2026-09-23 13:35 — opencode-anthropic-dark-auth
**Summary**: Migré el plugin a OpenCode v2.0.15 con entrypoint Plugin.define, hooks HTTP/retry y método OAuth, manteniendo export legacy v1. Añadí pruebas y documentación, configuré carga local en opencode.json. Falta reiniciar CodeNomad y verificar carga/conexión real; no publiqué ni hice commit.
**Verified**: npm run build; npm test (44 passed); git diff --check; JSON de config validado, import v2 id/setup validado; servidor v2 aislado inició sin enviar solicitudes al modelo.
**Completed**: none
---
## 2026-09-23 13:30 — opencode-anthropic-dark-auth
**Summary**: Ajusté la migración v2: restauración de cuenta tras rotación 429 fallida, timer proactivo con cleanup y resync acotado, guardas para fallback 401, peer legacy retirado y lock regenerado, README local corregido; preservé cambios previos sin commit.
**Verified**: npm test: 44/44; npm run build: correcto; git diff --check: correcto; npm ls muestra solo @opencode/plugin v2 a nivel raíz. Sin tráfico real ni publicación.
**Completed**: none
---
## 2026-09-23 13:20 — opencode-anthropic-dark-auth
**Summary**: Migré el paquete a entrypoint OpenCode v2 con hooks nativos Anthropic, OAuth integration, import inicial, rotación/reintentos y SSE; conservé legacy por subpath y cambios preexistentes.
**Verified**: npm test: 39 pruebas; npm run build: correcto; imports de dist/v2.js y dist/index.js: correctos; git diff --check: correcto. Sin tráfico real Anthropic.
**Completed**: none
---
## 2026-09-23 11:26 — opencode-anthropic-dark-auth
**Summary**: Diagnostiqué y resolví en caliente el error persistente 'OAuth access token has been revoked': el token guardado por el plugin (dark-auth-accounts.json y auth.json) había quedado desincronizado del token realmente vigente en ~/.claude/.credentials.json, ambos con expiresAt futuro por lo que el refresh proactivo nunca lo detectaba. Forcé la resincronización usando las propias funciones del plugin (importFromClaudeCode + upsertAccount) y repliqué el resultado a auth.json. Descarté CodeNomad como causa (su plugin session-pruning no referencia auth/credenciales). Registré el hallazgo como learning y un TODO para hacer la detección proactiva en vez de solo reactiva a 401.
**Verified**: Tras la resincronización, dark-auth.log registró '[import] Successfully imported from Claude Code' y las siguientes requests (COMPACTION DEBUG, Session snapshot) corrieron sin ningún 401/'revoked' nuevo.
**Completed**: none
---
## 2026-09-23 00:43 — opencode-anthropic-dark-auth
**Summary**: Apliqué también el arreglo a la instalación local activa de OpenCode, actualizando el artefacto compilado en su caché sin publicar a npm.
**Verified**: La copia local cacheada de dist/model-config.js anuncia ccVersion 2.1.280, comprobado importando el módulo con Node; npm tests y build pasaron en el código fuente; git diff --check limpio.
**Completed**: none
---
## 2026-09-23 00:40 — opencode-anthropic-dark-auth
**Summary**: Corregí el billing header del plugin para anunciar Claude Code 2.1.280, requisito mínimo del modelo reportado, y añadí una prueba de regresión del transformBody.
**Verified**: npm test: 29 tests passed; npm run build: correcto; git diff --check: limpio. Se preservó el cambio preexistente en progress.md.
**Completed**: none
---
## 2026-09-08 04:06 — opencode-anthropic-dark-auth
**Summary**: Diagnóstico del error 'blocked by provider's content filter' con Opus reportado por el usuario: no es un bug del plugin. Se confirmó que la versión instalada (1.0.7, cache ~/.cache/opencode/packages) coincide con HEAD del repo (38b8d5a) y npm@latest. El error lo produce opencode core (session/prompt.ts) al mapear stop_reason:'refusal' de Anthropic -> finish 'content-filter'; es un 200 OK normal, por eso nunca aparece en dark-auth.log (que solo loguea status!=200). Sin código modificado. Solo 1 cuenta configurada (Claude Pro).
**Verified**: Revisado src/index.ts, transforms.ts, model-config.ts, signing.ts; grep en dark-auth.log (45k líneas) sin 400/403/refusal cercanos al momento del error; comparado version instalada vs git HEAD vs npm view (todas 1.0.7); git status limpio, sin cambios pendientes.
**Completed**: none
---
---
## 2026-07-21 17:29 — opencode-anthropic-dark-auth
**Summary**: Aplicados todos los fixes del /review sobre el fix del 401: (1) reintegrado handleRateLimit en el handler 429 (rotación multi-cuenta estaba muerta desde 315eb9b); (2) sanitizeInputSchema ya no pisa silenciosamente propiedades colisionantes entre branches oneOf/anyOf, ahora las combina en anyOf anidado; (3) loadAccounts/getActiveAccount cacheados en memoria con TTL 2s e invalidación en saveAccounts para no leer disco sincrónicamente en cada request; (4) agregado vitest + 18 tests (accounts.test.ts, transforms.test.ts) cubriendo refresh proactivo/forzado, rotación 429, cache de credenciales, y el merge de schemas; (5) limpiados 3 comentarios //# sourceMappingURL residuales pegados en fuentes .ts; excluidos *.test.ts del build de tsc. Build (tsc --noEmit) y test suite (npm test) verdes. Pendiente: commit no realizado (a la espera de confirmación del usuario), y falta test de integración end-to-end del fetch() completo (agregado a TODOs).
**Verified**: npx tsc --noEmit -p tsconfig.json exit 0; npm test → 18/18 tests passed; npm run build regenera dist/ sin *.test.js
**Completed**: none
---
---
## 2026-07-21 17:16 — opencode-anthropic-dark-auth
**Summary**: Session started but blocked: /review command invoked with empty $ARGUMENTS, and target repo lacks AGENTS.md, feature_list.json, and init.sh required by the harness workflow and by the review command's TEST_RUNNER/COVERAGE_MIN prerequisites. No code changes made; asked user to clarify review target, test runner, and coverage threshold before continuing.
**Verified**: not recorded
**Completed**: none
