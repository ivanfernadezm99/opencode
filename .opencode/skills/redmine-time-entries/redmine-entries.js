#!/usr/bin/env node
/**
 * Redmine Time Entries Manager
 *
 * List, delete, and reload Redmine time entries interactively from the listing.
 *
 * Usage:
 *   node redmine-entries.js --list                  # Show last 7 days
 *   node redmine-entries.js --list --days 30        # Show last 30 days
 *   node redmine-entries.js --delete 12345          # Delete one entry
 *   node redmine-entries.js --delete 12345,12346    # Delete multiple entries
 *   node redmine-entries.js --interactive           # Interactive: list → delete → reload
 *   node redmine-entries.js --list --interactive    # Same as above
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════
// CONFIG LOADING
// ═══════════════════════════════════════════════════════════════

function loadJSON(filename) {
  const path = join(__dirname, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function promptCredentials() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const exampleFile = join(__dirname, '.credentials.example');
  const credFile = join(__dirname, '.credentials');

  if (!existsSync(exampleFile)) {
    writeFileSync(exampleFile,
      '# Redmine credentials — ONE-TIME SETUP (safe: stored locally, never sent anywhere)\n' +
      '# Edit the values below, save, and close the editor.\n' +
      'REDMINE_USER=your_username\n' +
      'REDMINE_PASS=your_password\n' +
      '\n',
      'utf8'
    );
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        🔒 FIRST-TIME CREDENTIAL SETUP                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  const result = spawnSync(editor, [exampleFile], { stdio: 'inherit', encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    console.error(`❌ Editor "${editor}" exited with error. Try again or set EDITOR env var.`);
    process.exit(1);
  }

  const raw = readFileSync(exampleFile, 'utf8');
  const user = raw.match(/REDMINE_USER=(.+)/)?.[1]?.trim();
  const pass = raw.match(/REDMINE_PASS=(.+)/)?.[1]?.trim();

  if (!user || !pass || user === 'your_username' || pass === 'your_password') {
    console.error('❌ You must set both REDMINE_USER and REDMINE_PASS in the file.');
    process.exit(1);
  }

  writeFileSync(credFile, `REDMINE_USER=${user}\nREDMINE_PASS=${pass}\n`, 'utf8');
  console.log('  ✅ Credentials saved locally in .credentials');
  return { user, pass };
}

function loadCredentials() {
  if (process.env.REDMINE_USER && process.env.REDMINE_PASS) {
    return { user: process.env.REDMINE_USER, pass: process.env.REDMINE_PASS };
  }

  try {
    const raw = readFileSync(join(__dirname, '.credentials'), 'utf8');
    const user = raw.match(/REDMINE_USER=(.+)/)?.[1]?.trim();
    const pass = raw.match(/REDMINE_PASS=(.+)/)?.[1]?.trim();
    if (user && pass) return { user, pass };
  } catch {}

  console.log('  🔒 No credentials found. Setting up...\n');
  return promptCredentials();
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, ''); // normalize --no-detail -> nodetail

    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[key] = args[i + 1];
      i++;
    } else {
      flags[key] = true;
    }
  }

  return flags;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

async function ask(question, defaultVal) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultVal !== undefined ? ` [${defaultVal}]` : '';
  const answer = await rl.question(`${question}${suffix}: `);
  rl.close();
  return answer.trim() || (defaultVal !== undefined ? String(defaultVal) : '');
}

// ═══════════════════════════════════════════════════════════════
// TABLE DISPLAY
// ═══════════════════════════════════════════════════════════════

function displayEntries(entries, title) {
  if (entries.length === 0) {
    console.log('  📭 No entries found.\n');
    return;
  }

  if (title) console.log(`\n  ${title}\n`);

  const sep = `  ┌───┬──────┬────────────┬───────┬─────────────┬──────────────────┬──────────────────────┐`;
  const hdr = `  │ # │  ID  │ Fecha      │ Horas │ Actividad   │ Issue            │ Comentario           │`;
  const div = `  ├───┼──────┼────────────┼───────┼─────────────┼──────────────────┼──────────────────────┤`;
  const bot = `  └───┴──────┴────────────┴───────┴─────────────┴──────────────────┴──────────────────────┘`;

  console.log(sep);
  console.log(hdr);
  console.log(div);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const num = String(i + 1).padEnd(2);
    const id = e.id.padEnd(4);
    const date = e.date.padEnd(10);
    const hours = e.hours.padEnd(5);
    const activity = e.activity.padEnd(11);
    const issue = (e.issue || '—').length > 16 ? (e.issue || '—').substring(0, 14) + '…' : (e.issue || '—').padEnd(16);
    const comments = e.comments.length > 24 ? e.comments.substring(0, 22) + '…' : e.comments.padEnd(24);
    console.log(`  │ ${num} │ ${id} │ ${date} │ ${hours} │ ${activity} │ ${issue} │ ${comments} │`);
  }
  console.log(bot);

  const total = entries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0);
  console.log(`  📊 ${entries.length} entradas · ${total.toFixed(2)} horas\n`);
}

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════

async function login(page, config, credentials) {
  process.stdout.write('🔐 Logging in...');
  await page.goto(`${config.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('#username').fill(credentials.user);
  await page.locator('#password').fill(credentials.pass);
  await page.locator('#login-submit').click();
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  if (page.url().includes('/login')) {
    console.log(' ❌');
    console.error('  Login failed — check your credentials');
    process.exit(1);
  }
  console.log(' ✅');
}

// ═══════════════════════════════════════════════════════════════
// COMMAND: LIST
// ═══════════════════════════════════════════════════════════════

async function listEntries(page, config, days) {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const from = formatDate(fromDate);
  const to = formatDate(new Date());

  await page.goto(
    `${config.baseUrl}/projects/${config.project}/time_entries?set_filter=1` +
    `&sort=spent_on:desc` +
    `&f[]=spent_on&op[spent_on]=between&v[spent_on][]=${from}&v[spent_on][]=${to}` +
    `&f[]=user_id&op[user_id]==&v[user_id][]=me` +
    `&per_page=100`,
    { waitUntil: 'networkidle' }
  );

  const entries = await page.$$eval('.time-entries tbody tr', (rows) => {
    return rows.map((row) => {
      const dateEl = row.querySelector('.spent_on');
      const hoursEl = row.querySelector('.hours');
      const activityEl = row.querySelector('.activity');
      const issueEl = row.querySelector('.issue');
      const commentsEl = row.querySelector('.comments');

      if (!dateEl) return null;

      return {
        id: row.id ? row.id.replace('time-entry-', '') : '?',
        date: dateEl.textContent.trim(),
        hours: hoursEl?.textContent?.trim() || '',
        activity: activityEl?.textContent?.trim() || '',
        issue: issueEl?.textContent?.trim().replace(/\s+/g, ' ') || '—',
        comments: commentsEl?.textContent?.trim() || '',
      };
    }).filter(Boolean);
  });

  return entries;
}

// ═══════════════════════════════════════════════════════════════
// COMMAND: DELETE
// ═══════════════════════════════════════════════════════════════

async function deleteEntry(page, config, entryId) {
  try {
    // Set up dialog handler BEFORE navigating
    let dialogAccepted = false;
    page.once('dialog', (dialog) => {
      dialogAccepted = true;
      dialog.accept();
    });

    // Navigate to the edit page
    await page.goto(`${config.baseUrl}/time_entries/${entryId}/edit`, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });

    // Look for the delete link (data-method="delete")
    const deleteLink = page.locator('a[data-method="delete"]');
    const deleteBtn = page.getByRole('button', { name: /eliminar|borrar|delete/i });

    if (await deleteLink.count() > 0) {
      await deleteLink.click();
    } else if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
    } else {
      // Try any link/button pointing to delete
      const anyDelete = page.locator('a, button').filter({ hasText: /eliminar|borrar|delete/i });
      if (await anyDelete.count() > 0) {
        await anyDelete.first().click();
      } else {
        return { success: false, error: 'Delete button not found on page' };
      }
    }

    // Wait for redirect back to time entries
    await page.waitForURL('**/time_entries**', { timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function deleteMultiple(page, config, entryIds) {
  const results = [];
  for (const id of entryIds) {
    process.stdout.write(`  Deleting #${id}...`);
    const result = await deleteEntry(page, config, id);
    if (result.success) {
      console.log(' ✅');
    } else {
      console.log(` ❌ ${result.error}`);
    }
    results.push({ id, ...result });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// COMMAND: INTERACTIVE
// ═══════════════════════════════════════════════════════════════

async function interactiveMode(page, config, credentials) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         GESTIÓN DE HORAS — Listado + Borrado              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── Step 1: load entries ──
  const days = 7;
  const entries = await listEntries(page, config, days);

  if (entries.length === 0) {
    console.log('\n  📭 No hay entradas en los últimos 7 días.\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const wantMore = await rl.question('  ¿Querés ver más días atrás? (ej: 30) [N]: ');
    rl.close();
    const numDays = parseInt(wantMore, 10);
    if (numDays > 0) {
      const moreEntries = await listEntries(page, config, numDays);
      if (moreEntries.length === 0) {
        console.log('\n  📭 Tampoco hay entradas. Nada que hacer.\n');
        return;
      }
      displayEntries(moreEntries, `⏰ Últimos ${numDays} días:`);
      return await interactiveDelete(page, config, moreEntries);
    }
    return;
  }

  displayEntries(entries, `⏰ Últimos ${days} días:`);
  await interactiveDelete(page, config, entries);
}

async function interactiveDelete(page, config, entries) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // ── Step 2: ask which to delete ──
  console.log('  ────────────────────────────────────────────────────────');
  console.log('  ¿Qué entradas querés borrar?');
  console.log('  • Números separados por coma: 1,3,5');
  console.log('  • Rango: 1-3');
  console.log('  • Combinado: 1,3-5,7');
  console.log('  • "all" para borrar todas');
  console.log('  • Enter vacío para salir');
  console.log('  ────────────────────────────────────────────────────────\n');

  const answer = await rl.question('  → ');
  rl.close();

  if (!answer.trim()) {
    console.log('\n  👋 Sin cambios.\n');
    return;
  }

  // Parse selection
  const selected = parseSelection(answer, entries.length);
  if (selected.length === 0) {
    console.log('\n  ⚠️  No se seleccionó ninguna entrada válida.\n');
    return;
  }

  const toDelete = selected.map(i => entries[i]);
  console.log(`\n  🗑️  Se van a borrar ${toDelete.length} entrada(s):`);
  for (const e of toDelete) {
    console.log(`     • #${e.id} — ${e.date} · ${e.hours}h · ${e.activity} · ${e.comments.substring(0, 50) || 'sin comentario'}`);
  }

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await rl2.question('\n  ¿Confirmás el borrado? (y/N): ');
  rl2.close();

  if (!['y', 'yes', 's', 'si'].includes(confirm.toLowerCase().trim())) {
    console.log('  ❌ Borrado cancelado.\n');
    return;
  }

  // ── Step 3: delete ──
  console.log('');
  const results = await deleteMultiple(page, config, toDelete.map(e => e.id));
  const deletedCount = results.filter(r => r.success).length;

  console.log(`\n  ✅ ${deletedCount} eliminadas · ❌ ${results.length - deletedCount} fallaron\n`);

  // ── Step 4: offer reload ──
  if (deletedCount === 0) return;

  const rl3 = createInterface({ input: process.stdin, output: process.stdout });
  const reload = await rl3.question('  ¿Querés cargar horas corregidas para reemplazar las borradas? (y/N): ');
  rl3.close();

  if (!['y', 'yes', 's', 'si'].includes(reload.toLowerCase().trim())) {
    console.log('\n  ✅ Listo. Las entradas se borraron.\n');
    return;
  }

  // ── Step 5: reload with corrected data ──
  await interactiveReload(page, config, toDelete);
}

async function interactiveReload(page, config, deletedEntries) {
  const created = [];

  for (const old of deletedEntries) {
    console.log(`\n  ── Recargar para #${old.id} (${old.date}) ──`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const date = await rl.question(`  Fecha (YYYY-MM-DD) [${old.date}]: `);
    const hours = await rl.question(`  Horas [${old.hours}]: `);
    const activity = await rl.question(`  Actividad [${old.activity}]: `);
    const comment = await rl.question('  Comentario: ');
    const issueStr = await rl.question(`  Issue (Enter = ${config.issueId}): `);

    rl.close();

    const entry = {
      date: date.trim() || old.date,
      hours: parseFloat(hours) || parseFloat(old.hours) || config.defaultHours,
      activity: activity.trim() || old.activity || config.defaultActivity,
      comment: comment.trim() || old.comments || '',
      issueId: issueStr.trim() || config.issueId,
    };

    // Submit the entry
    process.stdout.write(`  Cargando ${entry.date} — ${entry.hours}h ${entry.activity}...`);
    try {
      await page.goto(`${config.baseUrl}/projects/${config.project}/time_entries/new`, {
        waitUntil: 'networkidle',
      });

      await page.locator('#time_entry_spent_on').fill(entry.date);
      await page.locator('#time_entry_hours').fill(String(entry.hours));
      if (entry.comment) {
        await page.locator('#time_entry_comments').fill(entry.comment);
      }
      await page.locator('#time_entry_activity_id').selectOption({ label: entry.activity });

      if (entry.issueId) {
        const issueField = page.getByRole('textbox', { name: 'Petición' });
        await issueField.fill('');
        await issueField.pressSequentially(String(entry.issueId), { delay: 60 });
        await page.waitForTimeout(1200);

        const dropdown = page.locator('.ui-menu-item');
        if (await dropdown.count() > 0) {
          await dropdown.first().click();
          await page.waitForTimeout(300);
        }
      }

      await page.getByRole('button', { name: 'Crear', exact: true }).click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });

      if (!page.url().includes('/time_entries/new')) {
        console.log(' ✅');
        created.push(entry);
      } else {
        console.log(' ❌ (error en formulario, revisar manualmente)');
      }
    } catch (err) {
      console.log(` ❌ ${err.message}`);
    }
  }

  // ── Summary ──
  console.log('\n  ────────────────────────────────────────────────────────');
  console.log(`  ✅ Se cargaron ${created.length} entrada(s) corregida(s):`);
  for (const e of created) {
    console.log(`     • ${e.date} · ${e.hours}h · ${e.activity} · ${e.comment || '—'}`);
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════
// UTILITY: parse selection string
// ═══════════════════════════════════════════════════════════════

function parseSelection(input, maxIndex) {
  const indices = new Set();

  // "all"
  if (input.trim().toLowerCase() === 'all') {
    for (let i = 0; i < maxIndex; i++) indices.add(i);
    return [...indices].sort((a, b) => a - b);
  }

  const parts = input.split(',').map(s => s.trim());

  for (const part of parts) {
    // Range: "1-3"
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10) - 1;
      const end = parseInt(rangeMatch[2], 10) - 1;
      for (let i = Math.max(0, start); i <= Math.min(end, maxIndex - 1); i++) {
        indices.add(i);
      }
      continue;
    }

    // Single number
    const num = parseInt(part, 10);
    if (!isNaN(num) && num >= 1 && num <= maxIndex) {
      indices.add(num - 1);
    }
  }

  return [...indices].sort((a, b) => a - b);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const flags = parseArgs();
  const fileConfig = loadJSON('config.json') || {};

  const CONFIG = {
    baseUrl: fileConfig.baseUrl || 'https://oneadmin.oneinfoconsulting.com',
    project: fileConfig.project || 'service-delivery-2026',
    issueId: fileConfig.issueId || '15464',
    issueLabel: fileConfig.issueLabel || 'Gestión Interna',
    defaultActivity: fileConfig.defaultActivity || 'Desarrollo',
    defaultHours: fileConfig.defaultHours || 8,
    headless: false, // always show browser for interactive/delete
  };

  // Override from flags
  if (flags.project) CONFIG.project = flags.project;
  if (flags.issue) CONFIG.issueId = flags.issue;
  if (flags.headless === 'false') CONFIG.headless = false;
  if (flags.headless === 'true') CONFIG.headless = true;

  const days = flags.days ? parseInt(flags.days, 10) : 7;

  // ── Show help ──
  if (!flags.list && !flags.delete && !flags.interactive) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║      Redmine Time Entries Manager              ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log('  Usage:');
    console.log('    node redmine-entries.js --list                  Last 7 days');
    console.log('    node redmine-entries.js --list --days 30        Last 30 days');
    console.log('    node redmine-entries.js --delete 12345          Delete entry');
    console.log('    node redmine-entries.js --delete 12345,12346    Delete multiple');
    console.log('    node redmine-entries.js --interactive           Interactive mode');
    console.log('');
    process.exit(0);
  }

  // ── Load credentials ──
  const credentials = loadCredentials();

  // ── Launch browser ──
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--no-sandbox'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    const page = await context.newPage();

    await login(page, CONFIG, credentials);

    // ── DELETE command ──
    if (flags.delete) {
      const ids = flags.delete.split(',').map(s => s.trim()).filter(Boolean);
      console.log(`\n  🗑️  Eliminando ${ids.length} entrada(s)...\n`);
      const results = await deleteMultiple(page, CONFIG, ids);
      const ok = results.filter(r => r.success).length;
      console.log(`\n  ✅ ${ok} eliminada(s) · ❌ ${results.length - ok} fallaron\n`);
    }

    // ── LIST command ──
    if (flags.list || flags.interactive) {
      if (flags.interactive) {
        await interactiveMode(page, CONFIG, credentials);
      } else {
        const entries = await listEntries(page, CONFIG, days);
        if (entries.length === 0) {
          console.log('\n  📭 No entries found in the last ' + days + ' days.\n');
        } else {
          displayEntries(entries, `⏰ Últimos ${days} días:`);
        }
      }
    }

  } finally {
    await browser.close();
    console.log('  🏁 Done.\n');
  }
}

main().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
