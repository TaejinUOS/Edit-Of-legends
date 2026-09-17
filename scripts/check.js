import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
let count = 0;
for (const folder of ['engine', 'web', 'plugin', 'scripts', 'tests'])
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
if (manifest.host.minVersion !== '26.3.0') throw Error('Update documented minimum host version.');
console.log(`${count} JavaScript files: syntax OK. UXP manifest: OK.`);
