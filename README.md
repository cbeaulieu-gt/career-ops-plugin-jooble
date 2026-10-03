# career-ops-plugin-jooble

An opt-in, unlisted [Career-Ops](https://github.com/career-ops-hq/career-ops)
provider for Jooble's authenticated **US** jobs API.

Requires Career-Ops **1.35.0 or newer** for `ctx.normalizePostingUrl`, and Node.js
18 or newer. No runtime dependencies are required.

## Install

Install an exact commit you have reviewed:

```bash
node plugins.mjs add cbeaulieu-gt/career-ops-plugin-jooble --sha <40-character-commit-sha>
```

Put your US Jooble key in your local Career-Ops `.env`:

```env
JOOBLE_API_KEY=your_us_jooble_key
```

Then review the capability card and enable the provider:

```bash
node plugins.mjs enable jooble --confirm
```

## Search configuration

Add an entry under `job_boards:` or `tracked_companies:` in `portals.yml`:

```yaml
job_boards:
  - name: Jooble - Software Engineer
    provider: jooble
    careers_url: https://jooble.org
    keywords: software engineer
    location: United States
    results_per_page: 20
    max_pages: 1
    max_results: 100
    enabled: true
```

The normal scanner applies your configured title, content, and location filters:

```bash
node scan.mjs --company "Jooble - Software Engineer" --dry-run
```

`keywords` (or its alias `query`) and `location` must be non-empty strings.
Optional settings:

| Setting | Default | Limit / meaning |
|---|---|---|
| `results_per_page` | 20 | Maximum 50 requested; the API may return fewer |
| `max_pages` | 1 | Maximum 20; a smaller host-provided `ctx.maxPages` also applies |
| `max_results` | 400 | Maximum 400 unique normalized jobs |
| `radius` | Omitted | Kilometer radius: 0, 4, 8, 16, 26, 40, or 80 |
| `salary` | Omitted | Non-negative integer minimum salary sent as documented by Jooble |
| `search_mode` | Omitted | Non-negative integer sent as `SearchMode` |
| `companysearch` | Omitted | Boolean; true searches company names |

Pagination stops at an empty or repeated page, at the API's total count, or at
the configured page/result bound. A short page alone is not treated as proof
that the results have ended. IDs and canonical posting URLs remove duplicates.
Numeric Jooble IDs outside JavaScript's exact integer range use
`url:<canonical-posting-url>` as their identity, avoiding rounded-ID collisions.

## API limits and data semantics

Jooble's [REST API documentation](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation)
(checked 2026-10-03) says:

- Each country's domain requires a separate key. This version supports only
  `https://jooble.org/api/`, whose keys return US listings.
- The free API allowance is **500 requests total per key**, rather than a
  recurring monthly allowance. Default scans request one page per entry.
- Responses contain description **snippets**, not necessarily full job descriptions.
- `updated` records the last update, not original publication. This plugin
  exposes valid ISO timestamps as `updatedAt`, never `postedAt`. Timestamps
  lacking an offset are interpreted as UTC consistently. The normal scanner's
  posted-date filters therefore cannot establish recency for these results.
- The documented `link` is the Jooble posting URL. It is retained as returned;
  the plugin does not resolve redirects or claim it is the employer's direct URL.

Transient HTTP 429/5xx responses, recognized network failures, and aborts get
at most two retries. Each retry waits at most eight seconds; authentication and
other non-transient failures are not retried. Retries also consume API requests.
Malformed responses fail visibly rather than appearing to be an empty board.

## Credentials and scope

Only `ctx.env.JOOBLE_API_KEY` supplies the credential. Every request uses
Career-Ops' guarded `ctx.fetchJson` transport and the manifest restricts egress
to `jooble.org`. Redirects are rejected. Because the key is part of the URL,
errors expose only a safe failure message, HTTP status when available, and
attempt count; upstream error text and causes are discarded.

The provider returns jobs to Career-Ops. It does not submit applications or
write tracker, pipeline, or credential files.

## Distribution

This plugin intentionally remains unlisted. The current upstream
[contribution policy](https://github.com/career-ops-hq/career-ops/blob/main/CONTRIBUTING.md)
(checked 2026-10-03) excludes universal aggregation indexes from both core and
the plugin registry. A direct install has the `community-unverified` trust
badge; review the repository and pin the exact commit you trust.

Implementation and verification are tracked in
[cbeaulieu-gt/career-ops#64](https://github.com/cbeaulieu-gt/career-ops/issues/64).

## Tests

```bash
npm run check
npm test
node test/smoke.mjs
```

The tests run offline with synthetic data; they do not require or read a key.

## License

MIT. See [LICENSE](LICENSE).
