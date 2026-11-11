# Álbum digital

Sitio estático (Eleventy) con un álbum de capítulos para el celular: portada, índice y una página por capítulo con fotos, videos, cartas y notas. Todo el texto de la interfaz está en español. Los capítulos se agregan desde `/admin/` (sin tocar código) o editando `content/`.

Requisitos: Node >= 22, `ffmpeg`, `ffprobe` y `pdftoppm` (poppler). Si falta alguna, el build termina con código 4 y dice cuál.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run build` | Cadena completa: `guard pre`, `media`, `open-items`, `eleventy`, `guard post`, `verify-dist`. Salida en `dist/`. |
| `npm run media` | Valida los capítulos y genera fotos, videos y páginas de PDF optimizados en `build/media/` (caché en `.cache/`). |
| `npm run open-items` | Regenera `OPEN_ITEMS.md` (pendientes para Angel). No se publica. |
| `npm run guard -- pre\|post` | Revisa fuentes (`pre`) o `dist/` (`post`) contra la lista de exclusión. |
| `npm run seed` | Siembra capítulos desde `ALBUM_SRC` (`--only a,b`, `--force`). Solo lectura sobre el origen. |
| `npm run preview` | Sirve `dist/` como Pages (`--strict-headers` aplica `_headers`). |
| `npm run dev` | Media más Eleventy en modo servidor. |
| `npm test` | Pruebas unitarias y de propiedades (`node:test`, `fast-check`). |
| `npm run verify` | Verificación estática de `dist/`. |
| `npm run verify:browser` | Recorrido en Chrome móvil con capturas en `verification/`. |
| `npm run e2e` | Flujo de administración contra el mock local de GitHub. |

## Estructura

- `content/`: datos. `site.json` (título, volumen, `repo`), `chapters/<slug>/chapter.json` con sus archivos, `open-items.json` (pendientes curados).
- `seed/`: definiciones de los capítulos y lista de fotos grupales prohibidas como portada.
- `guard/`: hashes de los archivos excluidos.
- `lib/`: lógica compartida (slug, validador, guard, pipeline de medios, headers).
- `scripts/`: comandos de arriba, mock de GitHub y servidor local.
- `src/`: plantillas, CSS/JS, service worker y la página `/admin/`.
- `test/`: pruebas. `docs/`: `GUIA_ANGEL.md`, `DEPLOY.md`, `CANVA_REPORT.md`.
- Generados (ignorados por git): `build/`, `.cache/`, `dist/`, `verification/`, `tmp/`.

## Reglas de privacidad

- El álbum no tiene autenticación: se protege con `noindex`, `robots.txt` con `Disallow: /`, sin sitemap y una dirección imposible de adivinar. Quien tenga el enlace puede verlo.
- No hay código ni fuentes de terceros; todo se sirve del mismo origen. Los CSP son uno por ruta (`dist/_headers`).
- Las fotos publicadas no llevan EXIF ni GPS; los videos no llevan metadatos de ubicación. Los originales nunca se sirven.
- Todo lo relacionado con Setlog queda fuera: ningún archivo, carpeta, texto ni hash de esa app puede entrar al sitio.
- `/home/anbernal/kama/album-for-kiro/` es solo lectura. Este proyecto no hace push, no tiene remoto, no despliega y no programa etiquetas NFC.
- El token de GitHub del administrador se guarda cifrado (PBKDF2 + AES-GCM) en el dispositivo y nunca se registra.

## Cómo se protege el build

1. `guard pre` revisa rutas, cadenas de los JSON y SHA-256 de las fuentes; cualquier coincidencia con `/setlog/i` o un hash prohibido detiene todo (código 3).
2. `media` valida primero todos los capítulos (nombres, archivos, extensiones, `pairWithPrevious`) y recién después procesa medios.
3. `open-items` genera `OPEN_ITEMS.md` antes de Eleventy, para que CI no pueda omitirlo.
4. `guard post` vuelve a revisar nombres y texto de `dist/`.
5. `verify-dist` comprueba referencias, noindex, headers, ausencia de originales, EXIF y marcadores tipo `TODO`. Con `STRICT_BUDGET=1` el presupuesto de fotos es fatal (código 5).

En CI, el archivo `OPEN_ITEMS.md` fresco se publica como artefacto `OPEN_ITEMS` de la ejecución.
