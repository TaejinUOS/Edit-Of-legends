import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
let count = 0;
for (const folder of ['engine', 'plugin', 'scripts', 'tests'])
  for (const file of await readdir(folder))
    if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path.join(folder, file)], {
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        console.error(result.stderr);
        process.exit(1);
      }
      count++;
    }
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.host.minVersion !== '26.3.0') throw Error('Update documented minimum host version.');
if (manifest.version !== packageJson.version) throw Error('Plugin and package versions differ.');
if (!manifest.requiredPermissions.network.domains.includes('http://localhost:4317'))
  throw Error('Local engine is missing from UXP network permissions.');
if (!manifest.requiredPermissions.launchProcess.schemes.includes('editoflegends'))
  throw Error('Companion launcher scheme is missing from UXP launch permissions.');
const panel = await readFile('plugin/panel.js', 'utf8');
const panelHtml = await readFile('plugin/index.html', 'utf8');
const core = await readFile('engine/core.js', 'utf8');
if (!panel.includes(`const ENGINE_VERSION = '${manifest.version}'`))
  throw Error('Panel and manifest versions differ.');
if (!core.includes(`export const VERSION = '${manifest.version}'`))
  throw Error('Engine and manifest versions differ.');
for (const entrypoint of manifest.entrypoints.filter((entrypoint) => entrypoint.type === 'panel'))
  if (!panel.includes(`${entrypoint.id}:`))
    throw Error(`Missing UXP lifecycle registration for panel: ${entrypoint.id}`);
for (const [, id] of panel.matchAll(/\$\('([^']+)'\)/g))
  if (!panelHtml.includes(`id="${id}"`)) throw Error(`Panel element is missing: ${id}`);
console.log(`${count} JavaScript files: syntax OK. UXP manifest: OK.`);
