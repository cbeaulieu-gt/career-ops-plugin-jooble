import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import plugin from '../index.mjs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.id, plugin.provider.id);
assert.equal(manifest.humanInTheLoop, true);
assert.deepEqual(manifest.hooks, ['provider']);
assert.deepEqual(manifest.requiredEnv, ['JOOBLE_API_KEY']);
assert.deepEqual(manifest.allowedHosts, ['jooble.org']);
const jobs = await plugin.provider.fetch({ query: 'engineer', location: 'US' }, {
  env: { JOOBLE_API_KEY: 'smoke-key' }, normalizePostingUrl: url => url,
  fetchJson: async () => ({ totalCount: 1, jobs: [{ id: '1', title: 'Engineer',
    link: 'https://jooble.org/jdp/1', company: 'Example', location: 'US' }] }),
});
assert.equal(jobs.length, 1);
assert.equal(jobs[0].company, 'Example');
console.log('Jooble offline smoke passed');
