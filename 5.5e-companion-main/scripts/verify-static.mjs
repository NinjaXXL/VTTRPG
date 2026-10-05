import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const requiredFiles = [
  'index.html', 'player.html', '404.html', 'manifest.webmanifest', 'sw.js', 'js/pwa.js',
  'js/constants.js', 'js/db.js', 'js/peer.js', 'js/dm.js', 'js/player.js'
];

function fail(message) {
  failures.push(message);
}

function localPath(url, source) {
  if (!url || /^(?:https?:|data:|mailto:|tel:|#|\/\/)/i.test(url)) return null;
  const path = url.split(/[?#]/, 1)[0];
  if (!path || path.startsWith('/')) return path ? '__root_relative__' : null;
  return resolve(dirname(resolve(root, source)), path);
}

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) fail(`Missing required file: ${file}`);
}

for (const file of ['manifest.webmanifest', ...requiredFiles.filter((file) => file.startsWith('data/'))]) {
  if (!existsSync(resolve(root, file))) continue;
  try { JSON.parse(readFileSync(resolve(root, file), 'utf8')); }
  catch (error) { fail(`Invalid JSON in ${file}: ${error.message}`); }
}

const dataFiles = [
  'data/srd-5.2-class-features.json', 'data/srd-5.2-equipment.json', 'data/srd-5.2-feats.json',
  'data/srd-5.2-monsters.json', 'data/srd-5.2-species-traits.json', 'data/srd-5.2-spells.json'
];
for (const file of dataFiles) {
  try { JSON.parse(readFileSync(resolve(root, file), 'utf8')); }
  catch (error) { fail(`Invalid SRD data in ${file}: ${error.message}`); }
}

const jsFiles = ['sw.js', 'js/pwa.js', 'js/constants.js', 'js/db.js', 'js/peer.js', 'js/dm.js', 'js/player.js'];
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(`JavaScript syntax error in ${file}: ${result.stderr || result.stdout}`);
}

for (const htmlFile of ['index.html', 'player.html', '404.html']) {
  const html = readFileSync(resolve(root, htmlFile), 'utf8');
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
    const file = localPath(match[1], htmlFile);
    if (file === '__root_relative__') fail(`${htmlFile} uses a root-relative URL: ${match[1]}`);
    else if (file && !existsSync(file)) fail(`${htmlFile} references missing asset: ${match[1]}`);
  }
}

for (const htmlFile of ['index.html', 'player.html']) {
  const html = readFileSync(resolve(root, htmlFile), 'utf8');
  if (!html.includes('manifest.webmanifest')) fail(`${htmlFile} does not link the web manifest`);
  if (!html.includes('js/pwa.js')) fail(`${htmlFile} does not register the PWA helper`);
}

const worker = readFileSync(resolve(root, 'sw.js'), 'utf8');
for (const match of worker.matchAll(/['"](?!https?:\/\/)([^'"]+\.(?:html|js|css|json|png|ico|webmanifest))['"]/g)) {
  const asset = match[1];
  const file = resolve(root, asset);
  if (!existsSync(file)) fail(`sw.js precaches missing asset: ${asset}`);
}

if (failures.length) {
  console.error(`Verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Verified ${requiredFiles.length} required files, ${dataFiles.length} SRD datasets, and ${jsFiles.length} JavaScript files.`);
