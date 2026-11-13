import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Codex marketplace exposes a separate, self-contained Codex package', () => {
  const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
  const claude = JSON.parse(read('.claude-plugin/marketplace.json'));
  const [entry] = marketplace.plugins;
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.source.path, './plugins/cc-po-codex');
  assert.ok(claude.plugins.every((plugin) => plugin.name !== entry.name));
  const root = entry.source.path.slice(2);
  const manifest = JSON.parse(read(`${root}/plugin.json`));
  assert.equal(manifest.name, entry.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(read(`${root}/skills/product-owner/SKILL.md`), /^---\nname: product-owner\ndescription: Use when /);
});

test('every local skill reference is available in the installable package', () => {
  const root = 'plugins/cc-po-codex/skills/product-owner';
  const skill = read(`${root}/SKILL.md`);
  const links = [...skill.matchAll(/\]\((\.\/[^)]+)\)/g)].map((link) => link[1]);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.ok(link.slice(2).split('/').every((segment) => segment && segment !== '..'));
    assert.ok(read(`${root}/${link.slice(2)}`).length);
  }
});
