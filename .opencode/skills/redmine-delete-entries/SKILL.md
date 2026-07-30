---
name: redmine-delete-entries
description: "Trigger: borrar horas, revisar horas, ver horas cargadas, review hours, check entries, delete time entries, horas mal cargadas, recargar horas, corregir horas, fix hours, horas incorrectas. List, review, delete, and reload Redmine time entries from the listing view."
license: Apache-2.0
metadata:
  author: "servidor"
  version: "1.1"
---

## Activation Contract

Revisar y/o corregir horas en Redmine desde el listado. Podés:

- **Revisar**: listar todas las horas cargadas en los últimos días en una tabla con ID, fecha, horas, actividad, issue y comentarios
- **Borrar**: seleccionar entradas del listado y eliminarlas automáticamente
- **Recargar**: después de borrar, cargar las versiones corregidas sin salir del flujo

Use when: user says "revisar horas", "ver horas cargadas", "cómo quedaron las horas", "check hours", "review entries", "borrar horas", "las cargó mal", "delete time entries", "recargar horas", "corregir horas", "fix hours", or needs to see a summary of time entries or fix incorrect ones.

## Shared Setup

Este skill comparte configuración y credenciales con `redmine-time-entries`. Si ya cargaste horas alguna vez, ya tenés todo configurado:

- `config.json` en el mismo directorio → `/home/servidor/.config/opencode/skills/redmine-time-entries/`
- `.credentials` en el mismo directorio
- Node modules de Playwright ya instalados

Si no configuraste nunca, ejecutá cualquier comando y el script te guía.

## 🔒 Credential Security

**Mismas reglas que redmine-time-entries:** las credenciales nunca pasan por el chat, bash, o contexto de la IA. El script `redmine-entries.js` lee `.credentials` internamente.

## Usage

```bash
# REVISAR horas cargadas (solo lectura)
node redmine-entries.js --list                    # últimas 7 días
node redmine-entries.js --list --days 30          # últimas 30 días

# BORRAR una o varias entradas específicas
node redmine-entries.js --delete 12345
node redmine-entries.js --delete 12345,12346

# MODO INTERACTIVO: revisar → borrar → recargar todo junto
node redmine-entries.js --interactive
```

### Revisar horas (solo lectura)

Para simplemente ver cómo quedaron las horas cargadas sin hacer nada:

```bash
node redmine-entries.js --list --days 7
```

Muestra una tabla como esta (sin modificar nada):

```
  ┌───┬──────┬────────────┬───────┬─────────────┬──────────────────┬──────────────────────┐
  │ # │  ID  │ Fecha      │ Horas │ Actividad   │ Issue            │ Comentario           │
  ├───┼──────┼────────────┼───────┼─────────────┼──────────────────┼──────────────────────┤
  │ 1 │ 1234 │ 2026-07-28 │ 8.00  │ Desarrollo  │ #15464           │ Implementé login     │
  │ 2 │ 1235 │ 2026-07-29 │ 6.00  │ Testing     │ #15464           │ Testeé módulo        │
  └───┴──────┴────────────┴───────┴─────────────┴──────────────────┴──────────────────────┘

  📊 2 entradas · 14.00 horas
```

Si todo está bien, no hacés nada más. Si algo está mal, correlo con `--interactive` y arreglás desde ahí mismo.

## Interactive Workflow (recomendado)

```
$ node redmine-entries.js --interactive

╔══════════════════════════════════════════════════════════════╗
║         GESTIÓN DE HORAS — Listado + Borrado              ║
╚══════════════════════════════════════════════════════════════╝

  ⏰ Últimos 7 días:

  ┌───┬──────┬────────────┬───────┬─────────────┬──────────────────┬──────────────────────┐
  │ # │  ID  │ Fecha      │ Horas │ Actividad   │ Issue            │ Comentario           │
  ├───┼──────┼────────────┼───────┼─────────────┼──────────────────┼──────────────────────┤
  │ 1 │ 1234 │ 2026-07-28 │ 8.00  │ Desarrollo  │ #15464           │ Implementé login     │
  │ 2 │ 1235 │ 2026-07-29 │ 6.00  │ Testing     │ #15464           │ Testeé módulo        │
  └───┴──────┴────────────┴───────┴─────────────┴──────────────────┴──────────────────────┘

  ────────────────────────────────────────────────────────
  ¿Qué entradas querés borrar?
  • Números separados por coma: 1,3,5
  • Rango: 1-3
  • Combinado: 1,3-5,7
  • "all" para borrar todas
  • Enter vacío para salir
  ────────────────────────────────────────────────────────

  → 1
  Se va a borrar 1 entrada(s):
  • #1234 — 2026-07-28 · 8.00h · Desarrollo · Implementé login

  ¿Confirmás el borrado? (y/N): y
  Deleting #1234... ✅

  ¿Querés cargar horas corregidas para reemplazar las borradas? (y/N): y

  ── Recargar para #1234 (2026-07-28) ──
  Fecha (YYYY-MM-DD) [2026-07-28]:
  Horas [8.00]: 6
  Actividad [Desarrollo]: Testing
  Comentario: Corregido — hice testing
  Issue (Enter = 15464):

  Cargando 2026-07-28 — 6h Testing... ✅
```

## CLI Flags

| Flag | Descripción | Default |
|------|-------------|---------|
| `--list` | Listar entradas recientes | — |
| `--days` | Cantidad de días hacia atrás | 7 |
| `--delete` | ID(s) de entrada(s) a borrar (separados por coma) | — |
| `--interactive` | Modo interactivo completo | — |

## Script Location

El script `redmine-entries.js` comparte directorio con `load-hours.js`:

```
~/.config/opencode/skills/redmine-time-entries/
├── redmine-entries.js   ← este skill
├── load-hours.js        ← skill original de carga
├── config.json          ← configuración compartida
├── .credentials         ← credenciales (NUNCA compartir)
└── node_modules/        ← dependencias (Playwright)
```

## Error Handling

- **Login fails** → verificá credenciales con `node setup.js`
- **Delete falla** → muestra el error y continúa con la siguiente
- **Recarga falla** → la entrada ya está borrada, cargala manualmente
- **Browser crash** → ejecutá de nuevo, las entradas borradas ya no están
