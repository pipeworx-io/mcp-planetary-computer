interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Shared client for STAC APIs (SpatioTemporal Asset Catalog, stacspec.org).
 *
 * STAC is one wire format spoken by many independent satellite/geodata
 * catalogues — Microsoft Planetary Computer, Element 84's Earth Search over
 * AWS Open Data, the Copernicus Data Space Ecosystem, swisstopo/MeteoSwiss.
 * Every one of them serves `GET /collections`, `GET /collections/{id}` and
 * `POST /search` with the same bbox/datetime/collections vocabulary, so the
 * per-pack code is an endpoint definition and nothing else. "Build once,
 * improve everything": a paging fix or a better error lands in all of them.
 *
 * SELF-CONTAINED ON PURPOSE. `scripts/publish-pack.sh` inlines this file into
 * a pack's standalone npm bundle by stripping its `import` lines and its
 * `export` keywords (SHARED_HELPER_FILES). A helper that imports from another
 * shared module therefore ships with a dangling identifier that the monorepo
 * typecheck cannot see. So: no imports here, ever — not even from './http.js'.
 *
 * ── Three traps this file exists to absorb ────────────────────────────────
 *
 * 1. SOME CATALOGUES REQUIRE `collections` ON SEARCH, AND SAY SO DIFFERENTLY.
 *    Measured 2026-09-17: Planetary Computer answers 422 `collection is
 *    required`; the Copernicus Data Space answers 400
 *    `CollectionInQuerryIsMissingError` (their spelling). Earth Search and
 *    data.geo.admin.ch accept a catalogue-wide search. A caller who omits it
 *    gets an upstream error string that names no fix, so `collectionsRequired`
 *    turns that into a message naming the pack's own collections tool.
 *
 * 2. THE COLLECTIONS LIST PAGES, AND THE PAGE SIZE IS THE UPSTREAM'S CHOICE.
 *    The Copernicus catalogue returns 10 collections per page and
 *    data.geo.admin.ch 513 collections over 6 pages. A single un-paged GET
 *    reads as "this catalogue has ten datasets" — a confident wrong answer
 *    rather than an error. `stacCollections` follows `rel="next"` and reports
 *    `truncated` when it stops.
 *
 * 3. AN EMPTY SEARCH IS NOT EVIDENCE OF ABSENCE. A bbox in the wrong
 *    hemisphere, a datetime before the mission launched, or a collection id
 *    that exists in a sibling catalogue under another name all return a clean
 *    200 with `features: []` (docs/silent-zero-policy.md). Every zero-result
 *    search carries a `note` saying which constraint to relax first.
 */

/** One STAC API root. Packs define exactly one of these and nothing else. */
interface StacEndpoint {
  /** API root with no trailing slash, e.g. `https://earth-search.aws.element84.com/v1`. */
  baseUrl: string;
  /** Operator name, used verbatim in error text so a failure names its upstream. */
  name: string;
  /** Sent on every request; several catalogues 403 a request with no User-Agent. */
  userAgent: string;
  /** True when POST /search rejects a body without `collections` (see trap 1). */
  collectionsRequired?: boolean;
  /** Name of the pack's own collections tool, quoted when trap 1 fires. */
  collectionsToolName?: string;
  /** Appended to every payload: how assets are actually fetched, auth included. */
  assetAccessNote?: string;
}

interface StacAsset {
  key: string;
  title: string | null;
  type: string | null;
  href: string;
  roles: string[];
}

interface StacItemSummary {
  id: string;
  collection: string | null;
  title: string | null;
  datetime: string | null;
  updated: string | null;
  start_datetime: string | null;
  end_datetime: string | null;
  bbox: number[] | null;
  cloud_cover: number | null;
  platform: string | null;
  assets: StacAsset[];
  asset_count: number;
  self_href: string | null;
}

interface StacCollectionSummary {
  id: string;
  title: string | null;
  description: string | null;
  license: string | null;
  keywords: string[];
  bbox: number[] | null;
  temporal_start: string | null;
  temporal_end: string | null;
}

const STAC_TIMEOUT_MS = 30_000;
/** Hard ceiling on `rel="next"` follows, so a mis-paging upstream cannot spin. */
const STAC_MAX_PAGES = 12;

function stacTrim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function stacNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One bounded request. The Workers runtime puts no ceiling on a bare `fetch`,
 * so an upstream that accepts the connection and then goes quiet would hold
 * the Worker until its own execution budget kills it — reported to the caller
 * as a timeout naming nobody.
 */
async function stacFetch(
  ep: StacEndpoint,
  url: string,
  init?: { method?: string; body?: string },
): Promise<unknown> {
  const headers: Record<string, string> = {
    'User-Agent': ep.userAgent,
    Accept: 'application/json',
  };
  if (init?.body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
      signal: AbortSignal.timeout(STAC_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ep.name} did not answer within ${STAC_TIMEOUT_MS / 1000}s (${msg}).`);
  }

  if (!res.ok) {
    const body = stacTrim(await res.text().catch(() => ''), 300) ?? '(no body)';
    throw new Error(`${ep.name} returned HTTP ${res.status} for ${url} — ${body}`);
  }
  return res.json();
}

function stacNextHref(payload: unknown): string | null {
  const links = (payload as { links?: unknown })?.links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    const l = link as { rel?: unknown; href?: unknown; method?: unknown };
    // GET-only: a POST `next` carries a body token, which the collections
    // listing never uses. Following it with GET would silently re-read page 1.
    if (l.rel === 'next' && typeof l.href === 'string' && (l.method ?? 'GET') === 'GET') {
      return l.href;
    }
  }
  return null;
}

function stacSelfHref(payload: unknown): string | null {
  const links = (payload as { links?: unknown })?.links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    const l = link as { rel?: unknown; href?: unknown };
    if (l.rel === 'self' && typeof l.href === 'string') return l.href;
  }
  return null;
}

function stacShapeCollection(raw: unknown): StacCollectionSummary {
  const c = (raw ?? {}) as Record<string, unknown>;
  const extent = (c.extent ?? {}) as Record<string, unknown>;
  const spatial = (extent.spatial ?? {}) as { bbox?: unknown };
  const temporal = (extent.temporal ?? {}) as { interval?: unknown };
  const bbox = Array.isArray(spatial.bbox) && Array.isArray(spatial.bbox[0])
    ? (spatial.bbox[0] as number[])
    : null;
  const interval = Array.isArray(temporal.interval) && Array.isArray(temporal.interval[0])
    ? (temporal.interval[0] as (string | null)[])
    : [];
  return {
    id: String(c.id ?? ''),
    title: stacTrim(c.title, 200),
    description: stacTrim(c.description, 400),
    license: stacTrim(c.license, 80),
    keywords: Array.isArray(c.keywords) ? c.keywords.map(String).slice(0, 20) : [],
    bbox,
    temporal_start: typeof interval[0] === 'string' ? interval[0] : null,
    temporal_end: typeof interval[1] === 'string' ? interval[1] : null,
  };
}

function stacShapeItem(raw: unknown, maxAssets: number): StacItemSummary {
  const f = (raw ?? {}) as Record<string, unknown>;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const assetsRaw = (f.assets ?? {}) as Record<string, unknown>;
  const keys = Object.keys(assetsRaw);
  const assets: StacAsset[] = keys.slice(0, maxAssets).map((key) => {
    const a = (assetsRaw[key] ?? {}) as Record<string, unknown>;
    return {
      key,
      title: stacTrim(a.title, 120),
      type: stacTrim(a.type, 120),
      href: typeof a.href === 'string' ? a.href : '',
      roles: Array.isArray(a.roles) ? a.roles.map(String) : [],
    };
  });
  return {
    id: String(f.id ?? ''),
    collection: typeof f.collection === 'string' ? f.collection : null,
    title: stacTrim(props.title, 200),
    datetime: typeof props.datetime === 'string' ? props.datetime : null,
    updated: typeof props.updated === 'string' ? props.updated : null,
    start_datetime: typeof props.start_datetime === 'string' ? props.start_datetime : null,
    end_datetime: typeof props.end_datetime === 'string' ? props.end_datetime : null,
    bbox: Array.isArray(f.bbox) ? (f.bbox as number[]) : null,
    cloud_cover: stacNumber(props['eo:cloud_cover']),
    platform: stacTrim(props.platform, 80),
    assets,
    asset_count: keys.length,
    self_href: stacSelfHref(f),
  };
}

/**
 * List the catalogue's collections, following `rel="next"` so the answer is
 * the whole catalogue rather than page one (trap 2).
 *
 * `contains` filters case-insensitively across id, title and description —
 * the only practical way to find something in a 513-collection catalogue
 * without reading all of it.
 */
async function stacCollections(
  ep: StacEndpoint,
  opts: { contains?: string; prefix?: string; limit?: number } = {},
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const needle = opts.contains?.trim().toLowerCase() ?? '';
  const prefix = opts.prefix?.trim().toLowerCase() ?? '';

  let url = `${ep.baseUrl}/collections?limit=100`;
  const shaped: StacCollectionSummary[] = [];
  let scanned = 0;
  let pages = 0;
  let truncated = false;

  while (pages < STAC_MAX_PAGES) {
    const payload = await stacFetch(ep, url);
    const page = (payload as { collections?: unknown })?.collections;
    if (!Array.isArray(page)) break;
    pages++;
    for (const raw of page) {
      scanned++;
      const c = stacShapeCollection(raw);
      if (prefix && !c.id.toLowerCase().startsWith(prefix)) continue;
      if (needle) {
        const hay = `${c.id} ${c.title ?? ''} ${c.description ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      shaped.push(c);
    }
    if (shaped.length >= limit) break;
    const next = stacNextHref(payload);
    if (!next) break;
    url = next;
    if (pages === STAC_MAX_PAGES - 1) truncated = true;
  }

  const collections = shaped.slice(0, limit);
  const out: Record<string, unknown> = {
    source: ep.name,
    endpoint: `${ep.baseUrl}/collections`,
    scanned_collections: scanned,
    matched: shaped.length,
    returned: collections.length,
    truncated: truncated || shaped.length > collections.length,
    collections,
  };
  if (collections.length === 0) {
    out.note = needle || prefix
      ? `No collection in ${ep.name} matched ${needle ? `contains="${opts.contains}"` : ''}${needle && prefix ? ' and ' : ''}${prefix ? `prefix="${opts.prefix}"` : ''} across ${scanned} collections scanned. Try a shorter or different word — this is a substring match over id, title and description, not a semantic search.`
      : `${ep.name} returned no collections, which is not normal for a live STAC catalogue — treat it as an upstream fault rather than an empty catalogue.`;
  }
  return out;
}

/** Full detail for one collection id, including its providers and asset summary. */
async function stacCollection(
  ep: StacEndpoint,
  id: string,
): Promise<Record<string, unknown>> {
  const trimmed = id?.trim();
  if (!trimmed) {
    throw new Error(
      `A collection id is required. List the ids with ${ep.collectionsToolName ?? 'the collections tool'}.`,
    );
  }
  const url = `${ep.baseUrl}/collections/${encodeURIComponent(trimmed)}`;
  let payload: unknown;
  try {
    payload = await stacFetch(ep, url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 404/.test(msg)) {
      throw new Error(
        `${ep.name} has no collection "${trimmed}". Collection ids differ between STAC catalogues for the same mission — list this catalogue's own ids with ${ep.collectionsToolName ?? 'the collections tool'}.`,
      );
    }
    throw err;
  }

  const c = (payload ?? {}) as Record<string, unknown>;
  const providers = Array.isArray(c.providers)
    ? (c.providers as Record<string, unknown>[]).map((p) => ({
        name: stacTrim(p.name, 120),
        roles: Array.isArray(p.roles) ? p.roles.map(String) : [],
        url: typeof p.url === 'string' ? p.url : null,
      }))
    : [];
  const itemAssets = c.item_assets && typeof c.item_assets === 'object'
    ? Object.keys(c.item_assets as Record<string, unknown>).slice(0, 60)
    : [];

  const out: Record<string, unknown> = {
    source: ep.name,
    endpoint: url,
    ...stacShapeCollection(c),
    stac_version: typeof c.stac_version === 'string' ? c.stac_version : null,
    providers,
    item_asset_keys: itemAssets,
    items_href: `${ep.baseUrl}/collections/${encodeURIComponent(trimmed)}/items`,
  };
  if (ep.assetAccessNote) out.asset_access = ep.assetAccessNote;
  return out;
}

interface StacSearchArgs {
  collections?: string[] | string;
  bbox?: number[] | string;
  datetime?: string;
  ids?: string[] | string;
  limit?: number;
  max_assets?: number;
}

function stacList(value: string[] | string | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return arr.map((v) => String(v).trim()).filter(Boolean);
}

function stacBbox(value: number[] | string | undefined): number[] | null {
  if (value === undefined || value === null || value === '') return null;
  const arr = Array.isArray(value)
    ? value.map(Number)
    : String(value).split(',').map((v) => Number(v.trim()));
  if (arr.length !== 4 && arr.length !== 6) {
    throw new Error(
      `bbox must be 4 numbers [west, south, east, north] in WGS84 degrees (or 6 with elevation); got ${arr.length}.`,
    );
  }
  if (arr.some((n) => !Number.isFinite(n))) {
    throw new Error('bbox must be numeric: [west, south, east, north] in WGS84 degrees.');
  }
  return arr;
}

/**
 * POST /search over the catalogue. Returns shaped items — id, datetime, bbox
 * and asset href/type — rather than raw STAC, which runs to tens of kilobytes
 * per item and buries the two fields a caller actually wants.
 */
async function stacSearch(
  ep: StacEndpoint,
  args: StacSearchArgs,
): Promise<Record<string, unknown>> {
  const collections = stacList(args.collections);
  const ids = stacList(args.ids);
  const bbox = stacBbox(args.bbox);
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 100);
  const maxAssets = Math.min(Math.max(Number(args.max_assets ?? 8) || 8, 1), 50);

  if (ep.collectionsRequired && collections.length === 0 && ids.length === 0) {
    throw new Error(
      `${ep.name} rejects a catalogue-wide search: at least one collection id is required. List the ids with ${ep.collectionsToolName ?? 'the collections tool'}, then pass e.g. collections=["sentinel-2-l2a"].`,
    );
  }

  const body: Record<string, unknown> = { limit };
  if (collections.length) body.collections = collections;
  if (ids.length) body.ids = ids;
  if (bbox) body.bbox = bbox;
  if (args.datetime?.trim()) body.datetime = args.datetime.trim();

  const payload = await stacFetch(ep, `${ep.baseUrl}/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const features = (payload as { features?: unknown })?.features;
  const items = Array.isArray(features)
    ? features.map((f) => stacShapeItem(f, maxAssets))
    : [];
  const ctx = ((payload as { context?: unknown })?.context ?? {}) as Record<string, unknown>;

  const out: Record<string, unknown> = {
    source: ep.name,
    endpoint: `${ep.baseUrl}/search`,
    query: body,
    matched: stacNumber((payload as { numberMatched?: unknown })?.numberMatched)
      ?? stacNumber(ctx.matched),
    returned: items.length,
    items,
  };
  if (ep.assetAccessNote) out.asset_access = ep.assetAccessNote;
  if (items.length === 0) {
    const relax: string[] = [];
    if (args.datetime?.trim()) relax.push(`the datetime window (${args.datetime.trim()})`);
    if (bbox) relax.push(`the bbox (${bbox.join(',')}) — it must be WGS84 lon/lat, west,south,east,north`);
    if (collections.length) relax.push(`the collection ids (${collections.join(', ')}) — ids differ between STAC catalogues`);
    out.note = relax.length
      ? `No items matched. This is an empty result, not evidence the data does not exist: relax ${relax.join('; then ')}.`
      : `No items matched an unconstrained search of ${ep.name}, which is not normal for a live catalogue — treat it as an upstream fault.`;
  }
  return out;
}
/**
 * Earth-observation imagery catalogue from Microsoft's Planetary Computer — search its open satellite and environmental collections (Sentinel, Landsat, NAIP, Daymet, ERA5, biodiversity) by area and date and get item ids, footprints, dates and asset URLs.
 *
 * Upstream: https://planetarycomputer.microsoft.com/api/stac/v1 (STAC API 1.0).
 * Metadata search is keyless. Asset BYTES are a separate step — see below.
 *
 * TRAPS, measured 2026-09-17:
 *
 * - `POST /search` REJECTS A CATALOGUE-WIDE QUERY: with no `collections` it
 *   answers HTTP 422 with the bare string `collection is required`, which names
 *   no fix. Always call planetary_computer_collections first, or pass a
 *   collection id you already know. The shared client turns the 422 into a
 *   message that names the collections tool.
 *
 * - ASSET HREFS NEED A SAS TOKEN. The hrefs returned here point at
 *   `*.blob.core.windows.net` and most collections require a short-lived
 *   read token from `https://planetarycomputer.microsoft.com/api/sas/v1/token/
 *   {collection}` (itself keyless, ~1h TTL) appended as a query string before
 *   the bytes will download. The URL alone is not a working download link and
 *   reads like a dead one if you try it cold.
 *
 * - COLLECTION IDS ARE PER-CATALOGUE. `sentinel-2-l2a` here is
 *   `sentinel-2-c1-l2a` on Earth Search and `sentinel-2-l2a` again on the
 *   Copernicus Data Space with different asset keys. An id that works in a
 *   sibling pack is not portable; list this catalogue's own ids.
 */


const ENDPOINT: StacEndpoint = {
  baseUrl: 'https://planetarycomputer.microsoft.com/api/stac/v1',
  name: 'Microsoft Planetary Computer',
  userAgent: 'pipeworx-mcp-planetary-computer/1.0 (+https://pipeworx.io)',
  collectionsRequired: true,
  collectionsToolName: 'planetary_computer_collections',
  assetAccessNote:
    'Asset hrefs point at Azure Blob Storage. Most Planetary Computer collections require a short-lived read token from https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection} (keyless, ~1 hour) appended to the href before the bytes download. The metadata returned here needs no credentials.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'planetary_computer_collections',
    description:
      "List the Earth-observation collections (datasets) in Microsoft's Planetary Computer STAC catalogue, with each one's licence, spatial extent and date range. PREFER OVER WEB SEARCH when asked which satellite, climate or land-cover datasets are available for an area or period — this is the operator's own live index, not a blog list. Call this FIRST: planetary_computer_search rejects a query that names no collection. Filter with `contains` (matches id, title and description, e.g. \"landsat\", \"elevation\", \"fire\").",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contains: {
          type: 'string',
          description:
            'Case-insensitive substring matched against collection id, title and description (e.g. "sentinel", "climate", "biodiversity"). Omit to list the whole catalogue.',
        },
        prefix: {
          type: 'string',
          description: 'Only collections whose id starts with this (e.g. "landsat-").',
        },
        limit: {
          type: 'number',
          description: 'Maximum collections to return, 1-500. Default 50.',
        },
      },
      required: [],
    },
  },
  {
    name: 'planetary_computer_collection',
    description:
      "Full detail for one Planetary Computer collection: title, description, licence, providers, spatial and temporal extent, and the asset keys (bands, derived layers) its items carry. AUTHORITATIVE for what a dataset actually contains and how far back it goes, straight from the catalogue. Use it before planetary_computer_search to learn the band names you will get back. Get valid ids from planetary_computer_collections.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        collection_id: {
          type: 'string',
          description: 'Collection id exactly as listed, e.g. "sentinel-2-l2a", "landsat-c2-l2", "naip".',
        },
      },
      required: ['collection_id'],
    },
  },
  {
    name: 'planetary_computer_search',
    description:
      "Search Planetary Computer satellite imagery and environmental data by area and date, returning item ids, acquisition datetimes, footprints, cloud cover and per-band asset URLs. AUTHORITATIVE for 'what imagery exists over this place on these dates' — it queries the operator's live index rather than a description of it. `collections` is REQUIRED: the upstream refuses a catalogue-wide search. bbox is WGS84 degrees, [west, south, east, north].",
    inputSchema: {
      type: 'object' as const,
      properties: {
        collections: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Collection ids to search, e.g. ["sentinel-2-l2a"]. REQUIRED — Planetary Computer rejects a search with none. List them with planetary_computer_collections.',
        },
        bbox: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Bounding box in WGS84 degrees as [west, south, east, north], e.g. [-122.6, 37.6, -122.3, 37.9] for San Francisco. Longitude first.',
        },
        datetime: {
          type: 'string',
          description:
            'RFC 3339 instant or closed/open interval, e.g. "2026-06-01T00:00:00Z/2026-07-01T00:00:00Z" or "2026-06-01T00:00:00Z/..". Omit for any date.',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fetch specific item ids instead of searching by area/date.',
        },
        limit: { type: 'number', description: 'Items to return, 1-100. Default 10.' },
        max_assets: {
          type: 'number',
          description:
            'Asset entries per item, 1-50. Default 8 — a Sentinel-2 item carries ~30 bands and returning all of them for 100 items is a very large payload.',
        },
      },
      required: ['collections'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'planetary_computer_collections':
      return stacCollections(ENDPOINT, {
        contains: args.contains as string | undefined,
        prefix: args.prefix as string | undefined,
        limit: args.limit as number | undefined,
      });
    case 'planetary_computer_collection':
      return stacCollection(ENDPOINT, String(args.collection_id ?? ''));
    case 'planetary_computer_search':
      return stacSearch(ENDPOINT, {
        collections: args.collections as string[] | string | undefined,
        bbox: args.bbox as number[] | string | undefined,
        datetime: args.datetime as string | undefined,
        ids: args.ids as string[] | string | undefined,
        limit: args.limit as number | undefined,
        max_assets: args.max_assets as number | undefined,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
