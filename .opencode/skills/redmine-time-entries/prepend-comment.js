#!/usr/bin/env node
/**
 * Prepend a prefix to Redmine time entry comments.
 *
 * Edits existing time entries IN PLACE (no delete/recreate):
 * - Navigates to /time_entries/{id}/edit
 * - Reads the current comment
 * - If the comment does NOT already start with the prefix, prepends it
 * - Saves the form
 *
 * Usage:
 *   node prepend-comment.js --ids 104186,104182,...
 *   node prepend-comment.js --prefix "Soporte a proyecto IA: "
 *
 * Credentials are read internally from .credentials (never exposed).
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJSON(filename) {
  const path = join(__dirname, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadCredentials() {
  if (process.env.REDMINE_USER && process.env.REDMINE_PASS) {
    return { user: process.env.REDMINE_USER, pass: process.env.REDMINE_PASS };
  }
  const raw = readFileSync(join(__dirname, '.credentials'), 'utf8');
  const user = raw.match(/REDMINE_USER=(.+)/)?.[1]?.trim();
  const pass = raw.match(/REDMINE_PASS=(.+)/)?.[1]?.trim();
  if (user && pass) return { user, pass };
  throw new Error('No credentials found. Run load-hours.js to set them up.');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, '');
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[key] = args[i + 1];
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

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

async function prependComment(page, config, entryId, prefix) {
  try {
    await page.goto(`${config.baseUrl}/time_entries/${entryId}/edit`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });

    const commentField = page.locator('#time_entry_comments');
    if ((await commentField.count()) === 0) {
      return { success: false, error: 'Comment field not found' };
    }

    const current = ((await commentField.inputValue()) || '').trim();
    const startsWithPrefix = current.toLowerCase().startsWith(prefix.trim().toLowerCase().split(':')[0]);

    if (startsWithPrefix) {
      return { success: true, skipped: true, current };
    }

    const updated = `${prefix}${current}`;
    await commentField.fill(updated);

    // Save — try common button names
    const saveBtn = page
      .getByRole('button', { name: /guardar|save|enviar/i })
      .first();
    if ((await saveBtn.count()) === 0) {
      return { success: false, error: 'Save button not found' };
    }
    await saveBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    return { success: true, skipped: false, current, updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function main() {
  const flags = parseArgs();
  const fileConfig = loadJSON('config.json') || {};
  const CONFIG = {
    baseUrl: fileConfig.baseUrl || 'https://oneadmin.oneinfoconsulting.com',
    project: fileConfig.project || 'service-delivery-2026',
    headless: false,
  };

  const ids = (flags.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const prefix = flags.prefix || 'Soporte a proyecto IA: ';

  if (ids.length === 0) {
    console.error('Usage: node prepend-comment.js --ids 104186,104182 --prefix "Soporte a proyecto IA: "');
    process.exit(1);
  }

  const credentials = loadCredentials();
  const browser = await chromium.launch({ headless: CONFIG.headless, args: ['--no-sandbox'] });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    const page = await context.newPage();
    await login(page, CONFIG, credentials);

    console.log(`\n  ✏️  Prefijo: "${prefix}"`);
    console.log(`  Entradas a revisar: ${ids.length}\n`);

    let modified = 0;
    let skipped = 0;
    let failed = 0;

    for (const id of ids) {
      process.stdout.write(`  #${id}...`);
      const result = await prependComment(page, CONFIG, id, prefix);
      if (!result.success) {
        console.log(` ❌ ${result.error}`);
        failed++;
      } else if (result.skipped) {
        console.log(' ⏭️  ya empieza con el prefijo (sin cambios)');
        skipped++;
      } else {
        console.log(' ✅ comentario actualizado');
        modified++;
      }
    }

    console.log(`\n  ✅ Modificadas: ${modified} · ⏭️  Ya estaban: ${skipped} · ❌ Fallaron: ${failed}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
