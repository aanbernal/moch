# FINAL_REPORT: álbum digital

Estado: todo construido y verificado en local. **No se hizo push, no se desplegó nada y no se programó ninguna etiqueta NFC.** `git remote -v` en `album-site` está vacío. Los comandos de este informe se ejecutaron en la máquina local el día de la redacción; donde una cifra viene de un reporte ya existente, se dice cuál.

## 1. Qué se construyó

Sitio estático (Eleventy 3.1.8, Node, ESM, texto en español) con:

- Portada, índice y 18 páginas de capítulo (prólogo, capítulos 1 a 16 y el teaser "Continuará"), generadas desde `content/chapters/*/chapter.json` y `content/site.json`. `dist/capitulo/` contiene 18 carpetas y `dist/` 22 archivos HTML (18 capítulos + portada, índice, 404 y admin).
- Validador de datos (`lib/validate-core.mjs` sin imports, compartido con el admin), guardia de exclusión (`scripts/guard.mjs`, `guard/denied-hashes.json`), pipeline de medios (fotos WebP/JPEG con escalera de compresión, video H.264, PDF a imágenes) con caché y manifiesto determinista.
- Navegación fija (Anterior / Siguiente / Índice), gestos, teclado, zoom de cartas, movimiento reducido, service worker offline, `_headers` con una sola CSP por ruta, `noindex`, `robots.txt`.
- Administrador `/admin/` (token cifrado con PBKDF2 + AES-GCM, cliente de la API Git Data de GitHub, preparación de imágenes en el navegador) y un mock local de GitHub (`scripts/mock-github.mjs`) con servidor de vista previa (`scripts/serve.mjs`).
- Cadena de build `guard pre → media → open-items → eleventy → guard post → verify-dist` (`scripts/build.mjs`) y `.github/workflows/deploy.yml` (escrito, nunca ejecutado).
- Documentación: `README.md`, `docs/GUIA_ANGEL.md`, `docs/CANVA_REPORT.md`, `docs/DEPLOY.md`, `OPEN_ITEMS.md`.

## 2. Evidencia comprobada para este informe

| Comando | Resultado |
|---|---|
| `npm test` | 159 pruebas, 9 suites, 159 correctas, 0 fallas, 0 omitidas (~39 s), exit 0 |
| `STRICT_BUDGET=1 npm run build` | 6 etapas OK (guard pre: 79 archivos revisados; media: 58 elementos, 59 reutilizados del caché; guard post OK; verify-dist OK con 0 avisos), exit 0 |
| `npm run verify` | `verify-dist` OK, 0 avisos, exit 0 |
| `grep -ri setlog dist/` y búsqueda de nombres | 0 archivos con el texto, 0 nombres |
| `node scripts/verify-source-untouched.mjs` | 102 archivos hasheados antes y después del build: "el material original no cambió" (ver nota abajo) |
| Video más grande en `dist/m/` | 1 372 494 bytes (menos de 15 MB) |
| Tamaños | `dist/` 30 MB, `content/` 117 MB, `build/` 29 MB |

Nota sobre `verify-source-untouched`: imprimió "git status de /home/anbernal no está limpio". `album-for-kiro/` no es un repositorio propio: `git rev-parse --show-toplevel` devuelve `/home/anbernal`, así que la comprobación de git mira el home completo (hay muchos archivos sin seguimiento ajenos al proyecto). La comparación de huellas, que es la prueba real, pasó. La parte "git status limpio" de la tarea 13.3 no es concluyente por esta razón.

Los siguientes resultados vienen de reportes ya generados que **no se volvieron a ejecutar** para este informe:

- `verification/REPORT.md` / `report.json` (navegador, 2026-11-10): 153 correctas, 0 fallas, 0 avisos, 0 omitidas. Portada de 154 885 bytes (`coverBytes`), dentro del límite de 450 KB.
- `verification/e2e/REPORT.md` (2026-11-11): TODO OK, 56 correctas, 0 fallas.

## 3. Evidencia por tarea

| Tarea | Evidencia |
|---|---|
| 1 Setup | `package.json` con versiones exactas, `package-lock.json`, `git remote -v` vacío |
| 2 Modelo y validador | `test/slug*.test.mjs`, `test/validate*.test.mjs` (Propiedades 3 y 5) |
| 3 Guardia Setlog | `test/setlog-guard*.test.mjs` (Propiedades 18 y 19), CLI exit 3; `grep` de `dist/` en 0 |
| 4 Medios | `test/photo*.test.mjs`, `video*.test.mjs`, `pdf.test.mjs`, `media*.test.mjs` (Propiedades 4, 12 a 17) |
| 5 Portada, TOC, navegación, headers | `test/chapter-templates.test.mjs`, `headers.test.mjs`, `sw.test.mjs`; capturas `verification/screenshots/` (20 PNG: portada, índice y 18 capítulos) |
| 6 Capítulo de muestra | prólogo y `expo-aws` sembrados con `scripts/seed.mjs` |
| 7 Verificación estática | `test/verify-dist.test.mjs`, `open-items.test.mjs`, `deploy-workflow.test.mjs`; `verify-dist` OK |
| 8 Admin y mock | `test/admin-*.test.js`, `admin.property.test.js` (Propiedades 25 y 26, grep de APIs DOM prohibidas), `mock-github.test.mjs`, `serve.test.mjs`, `admin-ship.test.mjs` |
| 9 Esqueleto | `scripts/verify-browser.mjs`, `scripts/e2e-admin.mjs`; commit local `5a788e4` (checkpoint 10) |
| 11 Semilla completa | `test/seed.test.mjs` (Propiedad 20); 18 capítulos; `cartas` con exactamente 4 `figure.frame-letter` (verificado en el reporte del navegador) |
| 12 Documentación | `docs/` (GUIA_ANGEL 142 líneas, CANVA_REPORT 123, DEPLOY 256), `README.md` 51 |
| 13.1 | build estricto y `verify` arriba |
| 13.2 | `verification/REPORT.md`, 20 capturas |
| 13.3 | `grep`, huellas de `ALBUM_SRC`, remote vacío |
| 13.4 | `verification/e2e/` (7 capturas admin, 1 del sitio, `baseline.json`, `dist-final.json`, `diff-r.txt`, `mock-requests.json`, logs de build) |
| 13.5 | `docs/img/` con 7 imágenes, incrustadas en `docs/GUIA_ANGEL.md` y marcadas como "copia local de prueba". La captura `admin-07-build-fallido.png` está en `verification/e2e/` pero no en la guía |

## 4. Las 8 correcciones del review de diseño y dónde se verificaron

| Fix | Qué | Verificado en |
|---|---|---|
| 1 | Aserciones clase A (CI) y clase B (`STRICT_SEED=1`); etiquetas de navegación fijas | Clase A: `verify-dist` (build OK). Clase B y etiquetas: `verification/REPORT.md` (teaser sin 28/café/pregunta/noviembre, 4 cartas, frases clave ausentes, "Siguiente" recorre todo y termina en el índice); `test/chapter-templates.test.mjs` ("nav labels are fixed") |
| 2 | `ALBUM_SRC` ausente en CI | `verify-dist` omite solo esa comparación; `verify-source-untouched` presente y ejecutado. **No se probó** el caso real sin `ALBUM_SRC` en un runner de CI |
| 3 | Tabla de portadas, lista de fotos grupales, fila teaser sin miniatura | `test/seed.test.mjs`; reporte del navegador ("La fila teaser no tiene `<img>`", "mide lo mismo", "Ninguna portada es una foto de grupo") |
| 4 | Presupuesto de portada 300 KB objetivo, 450 KB límite | Reporte del navegador: portada 154 885 bytes, variante de 800 px, sin variantes de 1200 px |
| 5 | `validate-core.mjs` sin imports, copiado sin cambios a `dist/admin/` | `test/admin-ship.test.mjs`, `test/validate.test.mjs` ("has no import statements"), `verify-dist` |
| 6 | Orden de build, `open-items` en la cadena, artefacto CI | `test/deploy-workflow.test.mjs` ("build chain runs the stages in order"), build real de 6 etapas. El artefacto `OPEN_ITEMS` está solo escrito en el workflow, no se ejecutó |
| 7 | Lienzo blanco antes de exportar JPEG; sección "Cambiar el título del álbum" | `test/admin-model.test.js` ("white fill happens before drawImage"), e2e ("el píxel de la esquina es blanco"), sección 5 de `docs/GUIA_ANGEL.md` |
| 8 | Una tabla de compresión, consultas de movimiento reducido con nombre, `before()`, secciones ordenadas | `test/photo*.test.mjs` (Propiedad 13), reporte del navegador (`--page-turn` es `none` con movimiento reducido y `fade` sin preferencia), convención `before()` usada en las pruebas |

## 5. Desviaciones

- **Pruebas de propiedad opcionales sin implementar**, tal como indica `tasks.md`: 5.6 (Propiedades 1, 2, 6), 5.7 (7, 8, 9, 30, 31), 5.8 (21, 24), 7.4 (10, 11, 22, 23), 8.7 (27, 28, 29), 12.5 (pruebas de documentación). Algunos de esos comportamientos sí tienen pruebas unitarias de ejemplo (`chapter-templates`, `headers`, `sw`, `verify-dist`, `open-items`, `admin-model`), pero no en forma de propiedad con `fast-check`.
- **Tarea 4.7** (Propiedades 4 y 17) sigue sin marcar en `tasks.md`, pero el repositorio contiene `test/media.property.test.mjs` con ambas propiedades y pasan en la corrida de `npm test`. Es una discrepancia entre la lista de tareas y el código; el código es el que existe.
- Script `test`: `node --test "test/*.test.js" "test/*.test.mjs"` (el original `node --test test/` ejecutaba 0 pruebas en Node 24).
- "401 a mitad de la sesión": el admin muestra "token no válido o vencido", conserva el formulario y no publica nada, pero no vuelve solo a la pantalla de configuración (se usa "Bloquear" y "Olvidar este dispositivo").
- El e2e añade casos sintéticos (`capitulo-de-ronda`) solo a su copia de prueba.
- Las versiones de acciones en `deploy.yml` (checkout, setup-node, cache, upload-artifact v4, wrangler-action v3) se eligieron sin consulta y deben verificarse antes del primer uso (`docs/DEPLOY.md`, sección 8).
- "Insertar antes de Continuará" (pregunta de 13.4): el e2e confirma que el capítulo queda justo antes del teaser, con el número siguiente, sin renumerar los anteriores. La guía lo refleja.
- Estado de git: commit final local de la tarea 14 sobre `5884dc0` y `5a788e4`, con los capítulos sembrados, `README.md`, `docs/`, este informe y los ajustes de pruebas. Los temporales `.p.log` y `test/.vp.out` se borraron. `build/`, `.cache/`, `verification/`, `tmp/`, `node_modules` y `dist` están en `.gitignore` y no se incluyeron. `git remote -v` sigue vacío: no hay push ni despliegue. El hash exacto se obtiene con `git log -1`.

## 6. Pendientes (de `OPEN_ITEMS.md`)

Para Angel, resumidos; el detalle está en `OPEN_ITEMS.md`:

- Riesgo de privacidad aceptado: `noindex` más dirección imposible de adivinar, sin autenticación.
- Pendientes del plan por fecha (pies de foto de la captura del 29 sep, palabras del 4 oct, videos del 8 oct, nombre del gimnasio, selfie borrosa del 15 oct, videos del 17 oct, nota del alcohol del 23 oct, lugar de los elotes del 25 oct, convocatoria del 26 oct, charlas del 29 y 30 oct, selfies del 7 nov, historia del 1 nov) y título definitivo del álbum.
- Seis nombres que no coinciden entre el plan y el disco, más cuatro discrepancias detectadas por la semilla.
- Todos los capítulos sembrados (17 de 18 páginas, salvo el teaser) tienen texto provisional (`draft: true`) y casi todos carecen de pie de foto; `cartas` no tiene nota; once capítulos no tienen lugar; el prólogo no tiene fecha.
- `repo` en `content/site.json` sigue con `REPLACE_…`; el admin no desbloquea hasta completarlo.
- Confirmar la portada de `jsconf-gdl` (`IMG-20261029-WA0106.jpg` no debe ser foto grupal).

## 7. Qué NO se ejercitó

- Flujo real con un token fine-grained de GitHub (API real, permisos, límites de tasa). Solo se probó contra el mock local.
- Ninguna ejecución real de GitHub Actions; `deploy.yml` nunca corrió.
- Despliegue en Cloudflare Pages.
- Comportamiento real de `_headers` en Cloudflare, incluida la unión de cabeceras del mismo nombre. Solo se probó la semántica local implementada en `scripts/serve.mjs --strict-headers`.
- HTTPS en `pages.dev`.
- Teléfono real: las comprobaciones usan Chrome headless con emulación a 390 px.
- NFC: no se programó ninguna etiqueta.
- Instalación del service worker bajo HTTPS real y en un navegador de teléfono; solo se probó sobre `localhost`.
- Caso de CI sin `ALBUM_SRC` en un runner real.

## 8. Confirmación de seguridad

- Nada se subió: no hay remote, no hubo `git push`.
- Nada se desplegó y no se crearon cuentas.
- No se programó ninguna etiqueta NFC.
- Nada se escribió en `/home/anbernal/kama/album-for-kiro/`; las huellas SHA-256 de sus 102 archivos fueron idénticas antes y después del build.
