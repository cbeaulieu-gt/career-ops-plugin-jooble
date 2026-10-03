// @ts-check

const API_ROOT = 'https://jooble.org/api/';
const PAGE_LIMIT = 20;
const RESULT_LIMIT = 400;
const RADII = new Set([0, 4, 8, 16, 26, 40, 80]);
const NETWORK_CODES = /^(EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)$/;

/** Return trimmed string data, treating other types as absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Clamp a positive integer budget; use the default for invalid values. */
function bounded(value, fallback, limit) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, limit) : fallback;
}

/** Validate an optional integer search field without coercing null or booleans. */
function optionalNumber(entry, field, minimum) {
  if (entry[field] === undefined) return undefined;
  const value = entry[field];
  if (value === null || value === '' || typeof value === 'boolean') {
    throw new Error(`jooble: ${field} must be an integer >= ${minimum}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`jooble: ${field} must be an integer >= ${minimum}`);
  }
  return number;
}

/** Build the documented Jooble search payload or reject invalid configuration. */
function requestBody(entry, perPage) {
  const keywords = text(entry?.keywords ?? entry?.query);
  const location = text(entry?.location);
  if (!keywords) throw new Error('jooble: non-empty keywords (or query) are required');
  if (!location) throw new Error('jooble: a non-empty location is required');
  const body = { keywords, location, page: 1, ResultOnPage: perPage };
  const radius = optionalNumber(entry, 'radius', 0);
  if (radius !== undefined) {
    if (!RADII.has(radius)) throw new Error('jooble: radius must be 0, 4, 8, 16, 26, 40, or 80');
    body.radius = String(radius);
  }
  const salary = optionalNumber(entry, 'salary', 0);
  if (salary !== undefined) body.salary = salary;
  const mode = optionalNumber(entry, 'search_mode', 0);
  if (mode !== undefined) body.SearchMode = mode;
  if (entry.companysearch !== undefined) {
    if (typeof entry.companysearch !== 'boolean') throw new Error('jooble: companysearch must be a boolean');
    body.companysearch = entry.companysearch;
  }
  return body;
}

/** Normalize a listing, preserving update semantics and exact URL identities. */
function normalizeResult(row, normalizeUrl) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'number' && Number.isFinite(row.id) ? String(row.id) : text(row.id);
  const title = text(row.title);
  const url = text(row.link);
  if (!id || !title || !url) return null;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  // The API emits 64-bit numeric IDs that JSON.parse can round. Never dedup
  // distinct URLs on a rounded number; canonical URLs are exact stable keys.
  const identity = typeof row.id === 'number' && !Number.isSafeInteger(row.id)
    ? `url:${normalizeUrl(url) || url}` : id;
  const job = { id: identity, title, url, company: text(row.company), location: text(row.location),
    description: text(row.snippet), salaryText: text(row.salary), publisher: text(row.source),
    employmentType: text(row.type) };
  // Jooble documents this as last modification, not original publication.
  // Require an ISO timestamp; ignore localized/invalid/non-positive values.
  const updated = text(row.updated);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(updated)) {
    // No timezone is supplied in Jooble's official example: interpret it as UTC
    // consistently, rather than using the local machine's timezone.
    const iso = /(?:Z|[+-]\d{2}:\d{2})$/.test(updated) ? updated : `${updated}Z`;
    const milliseconds = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
    if (Number.isFinite(milliseconds) && milliseconds > 0) job.updatedAt = milliseconds;
  }
  return job;
}

/** Recognize transient HTTP and transport errors eligible for bounded retries. */
function retryable(error) {
  const status = error?.status;
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  return error?.name === 'AbortError' || NETWORK_CODES.test(String(error?.code ?? error?.cause?.code ?? ''));
}

/** Honor Retry-After or exponential backoff with an eight-second ceiling. */
function retryDelay(error, attempt) {
  const value = error?.retryAfter;
  if (value !== undefined && value !== null && value !== '') {
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 8000);
  }
  if (error?.status === 429) return 8000;
  return Math.min(500 * 2 ** attempt, 8000);
}

/** Fetch one page with at most three attempts and credential-safe final errors. */
async function fetchPage(ctx, url, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await ctx.fetchJson(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      if (attempt < 2 && retryable(error)) {
        const delay = retryDelay(error, attempt);
        await (typeof ctx.sleep === 'function' ? ctx.sleep(delay)
          : new Promise(resolve => setTimeout(resolve, delay)));
        continue;
      }
      // Never forward upstream text, URLs, or error causes: the credential is
      // part of the URL path and can be echoed in transport errors.
      const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
        ? error.status : undefined;
      const safe = new Error(`jooble: API request failed${status ? ` (HTTP ${status})` : ''}`);
      if (status !== undefined) safe.status = status;
      safe.attempts = attempt + 1;
      throw safe;
    }
  }
}

export default {
  provider: {
    id: 'jooble',
    /** Require an explicit provider entry; never claim arbitrary career URLs. */
    detect() { return null; },
    /** Fetch bounded pages through the engine context and return deduplicated jobs. */
    fetch: async (entry, ctx) => {
      const key = text(ctx?.env?.JOOBLE_API_KEY);
      if (!key) throw new Error('jooble: JOOBLE_API_KEY must be set in .env');
      if (typeof ctx?.fetchJson !== 'function') {
        throw new Error('jooble: context requires fetchJson (Career-Ops >= 1.35.0)');
      }
      // Some engine contexts omit the canonical helper.
      // Exact URLs still provide stable identities without copying engine rules.
      const normalizeUrl = typeof ctx.normalizePostingUrl === 'function'
        ? ctx.normalizePostingUrl : value => value;
      const configuredPages = bounded(entry?.max_pages, 1, PAGE_LIMIT);
      // Older hosts discard the scanner's context. Fail closed to one page
      // rather than bypassing an unavailable host budget with the entry limit.
      const maxPages = bounded(ctx.maxPages, 1, configuredPages);
      const resultLimit = bounded(entry?.max_results, RESULT_LIMIT, RESULT_LIMIT);
      const body = requestBody(entry, bounded(entry?.results_per_page, 20, 50));
      const url = `${API_ROOT}${encodeURIComponent(key)}`;
      const jobs = [];
      const seenIds = new Set();
      const seenUrls = new Set();
      const rawSeen = new Set();
      for (let page = 1; page <= maxPages; page += 1) {
        const payload = await fetchPage(ctx, url, { ...body, page });
        if (!payload || Array.isArray(payload) || !Array.isArray(payload.jobs)
          || (payload.totalCount !== undefined && (!Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0))) {
          throw new Error(`jooble: malformed API response on page ${page}`);
        }
        if (payload.jobs.length === 0) break;
        let newRaw = 0;
        for (const row of payload.jobs) {
          const job = normalizeResult(row, normalizeUrl);
          const rawKey = job ? job.id : JSON.stringify(row);
          if (!rawSeen.has(rawKey)) { rawSeen.add(rawKey); newRaw += 1; }
          if (!job) continue;
          const urlKey = normalizeUrl(job.url);
          if (seenIds.has(job.id) || (urlKey && seenUrls.has(urlKey))) continue;
          seenIds.add(job.id);
          if (urlKey) seenUrls.add(urlKey);
          jobs.push(job);
          if (jobs.length >= resultLimit) return jobs;
        }
        if (newRaw === 0 || (Number.isSafeInteger(payload.totalCount) && rawSeen.size >= payload.totalCount)) break;
      }
      return jobs;
    },
  },
};
