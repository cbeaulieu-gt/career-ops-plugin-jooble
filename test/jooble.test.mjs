import { strict as assert } from 'node:assert';
import plugin from '../index.mjs';

// The plugin static audit permits node:assert but not node:test. Keep the
// offline tests runnable without importing a module the installer rejects.
const cases = [];
/** Register an offline test for the serial runner below. */
function test(name, run) { cases.push({ name, run }); }

const entry = { keywords: 'software engineer', location: 'United States' };
/** Create a valid API listing fixture with per-case overrides. */
const row = (id = 1, overrides = {}) => ({
  id, title: ' Software Engineer ', company: ' Acme ', location: ' Remote, US ',
  link: `https://jooble.org/jdp/${id}`, snippet: ' A short snippet ',
  salary: '$100,000 - $120,000', source: 'Employer', type: 'Full-time',
  updated: '2026-10-01T12:00:00.000Z', ...overrides,
});
/** Create a fake engine context that records requests and retry delays. */
function context(responses = [{ totalCount: 1, jobs: [row()] }], overrides = {}) {
  const calls = [];
  const delays = [];
  const ctx = {
    env: { JOOBLE_API_KEY: 'test/key?with secret' },
    maxPages: 20,
    /** Model canonical URL deduplication by dropping tracking parameters. */
    normalizePostingUrl(value) {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
      return url.href;
    },
    /** Record retry waits without delaying the offline suite. */
    sleep: async (ms) => { delays.push(ms); },
    /** Return the next fixture page or throw a controlled transport failure. */
    fetchJson: async (url, opts) => {
      calls.push({ url: String(url), opts, body: JSON.parse(opts.body) });
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (response instanceof Error) throw response;
      return response;
    },
    ...overrides,
  };
  return { ctx, calls, delays };
}

test('requires the scoped credential before making a request', async () => {
  const { ctx, calls } = context([], { env: {} });
  await assert.rejects(plugin.provider.fetch(entry, ctx), /JOOBLE_API_KEY/);
  assert.equal(calls.length, 0);
});

test('is an explicit provider and never auto-detects boards', () => {
  assert.equal(plugin.provider.id, 'jooble');
  assert.equal(plugin.provider.detect({ careers_url: 'https://jooble.org' }), null);
});

test('uses the pinned US host, an encoded key, and documented request fields', async () => {
  const { ctx, calls } = context();
  await plugin.provider.fetch({ ...entry, radius: 80, salary: 100000, companysearch: false, search_mode: 0 }, ctx);
  assert.equal(calls[0].url, 'https://jooble.org/api/test%2Fkey%3Fwith%20secret');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.redirect, undefined);
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { keywords: 'software engineer', location: 'United States', page: 1,
    ResultOnPage: 20, radius: '80', salary: 100000, companysearch: false, SearchMode: 0 });
});

test('maps fields and preserves last-updated time without inventing a posted date', async () => {
  const { ctx } = context();
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.deepEqual(jobs, [{ id: '1', title: 'Software Engineer', url: 'https://jooble.org/jdp/1',
    company: 'Acme', location: 'Remote, US', description: 'A short snippet',
    salaryText: '$100,000 - $120,000', publisher: 'Employer', employmentType: 'Full-time',
    updatedAt: Date.parse('2026-10-01T12:00:00.000Z') }]);
  assert.equal(jobs[0].postedAt, undefined);
});

test('accepts query as an alias for keywords and trims inputs', async () => {
  const { ctx, calls } = context();
  await plugin.provider.fetch({ query: ' backend engineer ', location: ' US ' }, ctx);
  assert.equal(calls[0].body.keywords, 'backend engineer');
  assert.equal(calls[0].body.location, 'US');
});

for (const invalid of [{ keywords: '', location: 'US' }, { keywords: 'engineer', location: '' },
  { keywords: [], location: 'US' }, { keywords: 'engineer', location: 10 }, null]) {
  test(`rejects invalid search inputs: ${JSON.stringify(invalid)}`, async () => {
    const { ctx, calls } = context();
    await assert.rejects(plugin.provider.fetch(invalid, ctx), /keywords|location/);
    assert.equal(calls.length, 0);
  });
}

test('rejects contexts that cannot fetch', async () => {
  for (const overrides of [{ fetchJson: undefined }]) {
    const { ctx } = context([], overrides);
    await assert.rejects(plugin.provider.fetch(entry, ctx), /context/);
  }
});

test('defaults to one page even when more results exist', async () => {
  const { ctx, calls } = context([{ totalCount: 1000, jobs: [row()] }]);
  assert.equal((await plugin.provider.fetch(entry, ctx)).length, 1);
  assert.equal(calls.length, 1);
});

test('paginates and stops once the raw result count reaches totalCount', async () => {
  const { ctx, calls } = context([{ totalCount: 2, jobs: [row()] }, { totalCount: 2, jobs: [row(2)] }]);
  assert.equal((await plugin.provider.fetch({ ...entry, max_pages: 5 }, ctx)).length, 2);
  assert.deepEqual(calls.map(c => c.body.page), [1, 2]);
});

test('does not assume a short response is the last page', async () => {
  const { ctx, calls } = context([{ totalCount: 2, jobs: [row()] }, { totalCount: 2, jobs: [row(2)] }]);
  await plugin.provider.fetch({ ...entry, max_pages: 3, results_per_page: 50 }, ctx);
  assert.equal(calls.length, 2);
});

test('stops on an empty page', async () => {
  const { ctx, calls } = context([{ totalCount: 30, jobs: [] }]);
  assert.deepEqual(await plugin.provider.fetch({ ...entry, max_pages: 10 }, ctx), []);
  assert.equal(calls.length, 1);
});

test('deduplicates IDs and canonical URLs and stops a repeated page', async () => {
  const jobs = [row(), row(2, { link: 'https://jooble.org/jdp/1?utm_source=board' }),
    row(1, { link: 'https://jooble.org/jdp/other' })];
  const { ctx, calls } = context([{ totalCount: 100, jobs }, { totalCount: 100, jobs }]);
  assert.equal((await plugin.provider.fetch({ ...entry, max_pages: 10 }, ctx)).length, 1);
  assert.equal(calls.length, 2);
});

test('hard-caps pages, per-page size, and total returned results', async () => {
  let n = 0;
  const { ctx, calls } = context([], { fetchJson: async (url, opts) => {
    calls.push({ body: JSON.parse(opts.body) });
    return { totalCount: 100000, jobs: [row(++n)] };
  } });
  assert.equal((await plugin.provider.fetch({ ...entry, max_pages: 9999, results_per_page: 9999 }, ctx)).length, 20);
  assert.equal(calls.length, 20);
  assert.equal(calls[0].body.ResultOnPage, 50);
  const limited = context([{ totalCount: 500, jobs: [row(1), row(2), row(3)] }]);
  assert.equal((await plugin.provider.fetch({ ...entry, max_pages: 20, max_results: 2 }, limited.ctx)).length, 2);
  assert.equal(limited.calls.length, 1);
});

test('honors a smaller host-provided page budget', async () => {
  let id = 0;
  const { ctx, calls } = context([], { maxPages: 2, fetchJson: async () => {
    calls.push({}); return { totalCount: 500, jobs: [row(++id)] };
  } });
  await plugin.provider.fetch({ ...entry, max_pages: 5 }, ctx);
  assert.equal(calls.length, 2);
});

test('bounds invalid numeric limits to conservative defaults', async () => {
  const { ctx, calls } = context([{ totalCount: 50, jobs: [row()] }]);
  await plugin.provider.fetch({ ...entry, max_pages: -1, max_results: 0, results_per_page: 'bad' }, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.ResultOnPage, 20);
});

test('drops malformed rows, unsafe links, blank IDs and titles, and credential-bearing URLs', async () => {
  const jobs = [null, row('', {}), row(2, { title: '' }), row(3, { link: 'javascript:alert(1)' }),
    row(4, { link: 'https://user:password@example.org/job' }), row(5, { link: '//example.org/job' }),
    row(6, { link: 'file:///job' }), row(7)];
  const { ctx } = context([{ totalCount: jobs.length, jobs }]);
  assert.deepEqual((await plugin.provider.fetch(entry, ctx)).map(j => j.id), ['7']);
});

test('ignores invalid timestamps and normalizes fractional ISO seconds', async () => {
  const { ctx } = context([{ totalCount: 2, jobs: [row(1, { updated: '2026-10-01T12:00:00.1230000Z' }),
    row(2, { updated: 'not a date' })] }]);
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.equal(jobs[0].updatedAt, Date.parse('2026-10-01T12:00:00.123Z'));
  assert.equal(jobs[1].updatedAt, undefined);
});

for (const response of [null, [], { jobs: null }, { jobs: {} }, { error: 'bad key' }]) {
  test(`fails visibly on a malformed payload: ${JSON.stringify(response)}`, async () => {
    const { ctx } = context([response]);
    await assert.rejects(plugin.provider.fetch(entry, ctx), /malformed/);
  });
}

for (const status of [429, 500, 503]) {
  test(`retries transient HTTP ${status}`, async () => {
    const error = Object.assign(new Error('temporary'), { status, retryAfter: '1' });
    const { ctx, calls, delays } = context([error, { totalCount: 1, jobs: [row()] }]);
    assert.equal((await plugin.provider.fetch(entry, ctx)).length, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [1000]);
  });
}

test('retries network resets but not SSRF guard errors', async () => {
  const network = Object.assign(new TypeError('network failed'), { cause: { code: 'ECONNRESET' } });
  const good = context([network, { totalCount: 1, jobs: [row()] }]);
  await plugin.provider.fetch(entry, good.ctx);
  assert.equal(good.calls.length, 2);
  const blocked = context([new Error('host not allowed')]);
  await assert.rejects(plugin.provider.fetch(entry, blocked.ctx), /request failed/);
  assert.equal(blocked.calls.length, 1);
});

for (const status of [400, 401, 403, 404]) {
  test(`does not retry HTTP ${status} or leak a key in the error`, async () => {
    const key = 'secret/key?value';
    const error = Object.assign(new Error(`POST https://jooble.org/api/${encodeURIComponent(key)} ${key}`),
      { status, cause: new Error(key) });
    const { ctx, calls } = context([error], { env: { JOOBLE_API_KEY: key } });
    await assert.rejects(plugin.provider.fetch(entry, ctx), (safe) => {
      assert.equal(safe.status, status);
      assert.equal(safe.attempts, 1);
      assert.equal(safe.cause, undefined);
      assert.ok(!String(safe.stack).includes(key));
      assert.ok(!String(safe.stack).includes(encodeURIComponent(key)));
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('retries at most twice and caps extreme Retry-After delays', async () => {
  const error = Object.assign(new Error('temporary'), { status: 503, retryAfter: '99999999' });
  const { ctx, calls, delays } = context([error]);
  await assert.rejects(plugin.provider.fetch(entry, ctx), (safe) => safe.attempts === 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [8000, 8000]);
});

test('never exposes the key through raw malformed payload messages', async () => {
  const { ctx } = context([{ error: 'test/key?with secret' }]);
  await assert.rejects(plugin.provider.fetch(entry, ctx), (safe) => {
    assert.match(safe.message, /malformed/);
    assert.ok(!safe.message.includes(ctx.env.JOOBLE_API_KEY));
    return true;
  });
});

test('does not lose distinct postings when numeric source IDs exceed exact integer precision', async () => {
  // JSON parsing rounds these distinct 64-bit source IDs to the same Number.
  const first = JSON.parse('{"id":9223372036854775800}').id;
  const second = JSON.parse('{"id":9223372036854775801}').id;
  assert.equal(first, second);
  const { ctx } = context([{ totalCount: 2, jobs: [row(first, { link: 'https://jooble.org/jdp/first' }),
    row(second, { link: 'https://jooble.org/jdp/second' })] }]);
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => j.id), ['url:https://jooble.org/jdp/first', 'url:https://jooble.org/jdp/second']);
});

test('normalizes timezone-free source dates consistently as UTC', async () => {
  const { ctx } = context([{ totalCount: 1, jobs: [row(1, { updated: '2026-10-01T12:00:00.1230000' })] }]);
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.equal(jobs[0].updatedAt, Date.parse('2026-10-01T12:00:00.123Z'));
});

test('validates optional API fields before consuming a request', async () => {
  for (const invalid of [{ radius: 9 }, { radius: '' }, { salary: -1 }, { search_mode: true },
    { companysearch: 'false' }]) {
    const { ctx, calls } = context();
    await assert.rejects(plugin.provider.fetch({ ...entry, ...invalid }, ctx));
    assert.equal(calls.length, 0);
  }
});

test('rejects malformed total counts without disclosing response text', async () => {
  for (const totalCount of [-1, 'bad', 1.5, null]) {
    const { ctx } = context([{ totalCount, jobs: [row()] }]);
    await assert.rejects(plugin.provider.fetch(entry, ctx), /malformed/);
  }
});

test('supports older engine contexts without the optional canonical URL helper', async () => {
  const unsafeId = Number('9223372036854775807');
  const { ctx } = context([{ totalCount: 3, jobs: [row(unsafeId), row(unsafeId),
    row(unsafeId, { link: 'https://jooble.org/jdp/different' })] }], { normalizePostingUrl: undefined });
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, `url:${row(unsafeId).link}`);
});

test('uses a conservative eight-second 429 wait when the engine omits Retry-After', async () => {
  const error = Object.assign(new Error('limited'), { status: 429 });
  const { ctx, delays } = context([error, { totalCount: 1, jobs: [row()] }]);
  await plugin.provider.fetch(entry, ctx);
  assert.deepEqual(delays, [8000]);
});

test('continues past distinct malformed pages whose rows lack both identity fields', async () => {
  const { ctx, calls } = context([{ totalCount: 3, jobs: [{ title: 'Malformed first' }] },
    { totalCount: 3, jobs: [{ title: 'Malformed second' }] },
    { totalCount: 3, jobs: [row()] }]);
  const jobs = await plugin.provider.fetch({ ...entry, max_pages: 3 }, ctx);
  assert.equal(calls.length, 3);
  assert.equal(jobs.length, 1);
});

test('limits older engine contexts to one page when the host budget is unavailable', async () => {
  const { ctx, calls } = context([{ totalCount: 100, jobs: [row()] }], { maxPages: undefined });
  await plugin.provider.fetch({ ...entry, max_pages: 20 }, ctx);
  assert.equal(calls.length, 1);
});

test('counts unique raw rows before stopping at totalCount across overlapping pages', async () => {
  const { ctx, calls } = context([{ totalCount: 4, jobs: [row(1), row(2)] },
    { totalCount: 4, jobs: [row(2), row(3)] }, { totalCount: 4, jobs: [row(4)] }]);
  const jobs = await plugin.provider.fetch({ ...entry, max_pages: 3 }, ctx);
  assert.equal(calls.length, 3);
  assert.equal(jobs.length, 4);
});

test('continues past malformed pages with null or blank identity fields', async () => {
  for (const identity of [{ id: null, link: null }, { id: '', link: ' ' }, { id: [], link: {} }]) {
    const { ctx, calls } = context([{ totalCount: 3, jobs: [{ ...identity, title: 'First' }] },
      { totalCount: 3, jobs: [{ ...identity, title: 'Second' }] },
      { totalCount: 3, jobs: [row()] }]);
    const jobs = await plugin.provider.fetch({ ...entry, max_pages: 3 }, ctx);
    assert.equal(calls.length, 3);
    assert.equal(jobs.length, 1);
  }
});

test('does not count a stable ID twice when its link changes between pages', async () => {
  const { ctx, calls } = context([{ totalCount: 4, jobs: [row(1), row(2)] },
    { totalCount: 4, jobs: [row(2, { link: 'https://jooble.org/jdp/2?utm_source=other' }), row(3)] },
    { totalCount: 4, jobs: [row(4)] }]);
  const jobs = await plugin.provider.fetch({ ...entry, max_pages: 3 }, ctx);
  assert.equal(calls.length, 3);
  assert.equal(jobs.length, 4);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}`, error); }
}
console.log(`${cases.length - failures}/${cases.length} Jooble tests passed`);
if (failures) throw new Error(`${failures} Jooble tests failed`);
