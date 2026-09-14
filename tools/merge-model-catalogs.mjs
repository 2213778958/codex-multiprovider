// Builds a merged model catalog for the desktop client.
//
// `model_catalog_json` replaces the catalog the client fetches from the account, so the desktop
// picker only shows what that file contains. This script merges the account catalog cached in
// CODEX_HOME with one or more provider catalogs so both providers stay selectable.
//
// usage: node merge-model-catalogs.mjs <codexHome> <outputPath> <providerCatalog> [providerCatalog...]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [codexHome, outPath, ...providerCatalogs] = process.argv.slice(2);
if (!codexHome || !outPath || providerCatalogs.length === 0) {
  throw Error('usage: node merge-model-catalogs.mjs <codexHome> <outputPath> <providerCatalog> [...]');
}

const readCatalog = async (file) => {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw Error(`catalog has no models: ${file}`);
  }
  return models;
};

const account = await readCatalog(path.join(codexHome, 'models_cache.json'));
const extras = [];
for (const catalog of providerCatalogs) {
  extras.push(...(await readCatalog(catalog)));
}

const bySlug = new Map(account.map((model) => [model.slug, model]));
for (const model of extras) {
  bySlug.set(model.slug, model);
}

const merged = { models: [...bySlug.values()] };
await writeFile(outPath, JSON.stringify(merged, null, 2));
console.log(`merged ${merged.models.length} models -> ${outPath}`);
for (const model of merged.models) {
  console.log(`  ${model.slug}`);
}
