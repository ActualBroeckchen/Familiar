/**
 * Google Calendar source adapters — the FETCH half of inbound sync.
 *
 * Network + the calendar URL live in Node (consistent with every other
 * adapter: websearch, the Discord token), so Unruh stays pure
 * parse-and-store and unit-tests against fixture `.ics` strings with no
 * network (build spec §1.5). This module only fetches bytes; Unruh's
 * `gcal_ingest` does all parsing and reconciliation.
 *
 * Pass 1 ships the link adapter (an out-of-the-box iCal URL — Google's
 * "secret address in iCal format"). The authenticated gogcli/gcalcli
 * adapters (Pass 4) are interchangeable behind the same one seam: each
 * produces input for `gcal_ingest`, neither forks the pipeline.
 */

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Normalise a user-pasted calendar address to an https URL we can fetch.
 * Google offers the secret iCal address as `https://…/basic.ics`, but
 * calendar apps frequently hand out the `webcal://` scheme — same bytes,
 * different prefix. Returns null for anything that isn't an http(s)/webcal
 * URL so a fat-fingered value fails fast instead of throwing mid-fetch.
 */
export function normalizeIcalUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('webcal://')) return 'https://' + trimmed.slice('webcal://'.length);
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return null;
}

/**
 * Fetch the raw `.ics` text from an iCal URL. Returns
 * `{ ok: true, icsText }` or `{ ok: false, error }` — it never throws, so
 * the sync loop degrades silently (CLAUDE.md graceful-degradation): a bad
 * URL, a network blip, an HTTP error, or a body that isn't iCal all become
 * a structured `ok:false` the loop logs and moves past, never a crash and
 * never a chat-path error.
 *
 * @param {string} url             the iCal / webcal URL from settings
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn] injectable fetch (tests pass a stub)
 * @param {number} [opts.timeoutMs]
 */
export async function fetchIcal(url, { fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const normalized = normalizeIcalUrl(url);
  if (!normalized) return { ok: false, error: 'invalid or empty iCal URL' };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch unavailable in this runtime' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchFn(normalized, {
      signal: controller.signal,
      headers: { Accept: 'text/calendar, text/plain, */*' },
      redirect: 'follow',
    });
    if (!res || !res.ok) {
      return { ok: false, error: `fetch failed: HTTP ${res?.status ?? '??'}` };
    }
    const text = await res.text();
    // Cheap sanity gate: a real feed contains a VCALENDAR. An auth wall or
    // an error page (HTML) must NOT be treated as "the calendar is empty"
    // — that would let the deletion-reconcile cancel everything (§1.3).
    if (!text || !/BEGIN:VCALENDAR/i.test(text)) {
      return { ok: false, error: 'response is not an iCalendar feed' };
    }
    return { ok: true, icsText: text };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err));
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
