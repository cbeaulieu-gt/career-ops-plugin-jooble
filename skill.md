# Jooble provider

Use this plugin only to discover public job listings through its provider hook.
It returns candidates to the Career-Ops scanner for the user's review.

## Prerequisites

- Career-Ops 1.35.0 or newer.
- The user has explicitly enabled and consented to `jooble`.
- A US Jooble API key is configured as `JOOBLE_API_KEY` in the local `.env`.

Never display the credential or a URL containing it. This version uses only
the US endpoint on `jooble.org`. Each country's API requires its own key.
The documented free allowance is 500 requests over the key's lifetime, so
prefer the one-page default unless the user requests broader coverage.

## Scanner entry

```yaml
  - name: Jooble - Software Engineer
    provider: jooble
    careers_url: https://jooble.org
    keywords: software engineer
    location: United States
    max_pages: 1
    results_per_page: 20
    enabled: true
```

Both `keywords` (or `query`) and `location` are required. The scanner's existing
filters determine which results fit the user's targeting. Preview the entry:

```bash
node scan.mjs --company "Jooble - Software Engineer" --dry-run
```

The provider returns snippets and Jooble posting links. Its `updatedAt` field
records an update; it is not proof of the original publication date. Keep
those limits visible when assessing recency or description completeness.

Errors contain a safe status and attempt count. HTTP 403 generally means the
key is invalid or missing. Do not paste the key or raw request URL into a
report. The plugin performs no application submission.
