/**
 * Shared HTTP layer with on-disk ETag caching (plan.md § Download Manager,
 * Recommended Libraries). Upstream manifests (Mojang, PaperMC, Fabric, Adoptium,
 * …) are fetched through here so every provider gets conditional-request caching
 * for free and we stay polite to upstream APIs.
 *
 * Leaf helper (`lib/`) — UI-free, provider-free, server-free. It knows nothing
 * about servers; it caches bytes keyed by URL. Callers validate the parsed body
 * with Zod at their boundary (AGENTS.md § "Zod at every boundary").
 *
 * **Caching model.** Each URL maps to one cache file under `~/.cache/mctl/api/`
 * holding the last body plus its `ETag`/`Last-Modified`. A request:
 *  1. Within `ttlMs` of the last fetch → serve the cached body without a network
 *     call at all (cheap revalidation avoidance).
 *  2. Otherwise send a conditional GET (`If-None-Match` / `If-Modified-Since`).
 *     `304 Not Modified` → serve cache (and refresh its timestamp); `200` →
 *     store the new body + validators and serve it.
 *  3. On a network error with a cached body present → serve stale rather than
 *     fail (upstream flakiness must not break a create). A hard failure with no
 *     cache throws {@link HttpError}.
 *
 * The cache directory is under `~/.cache/` and is safe to delete at any time —
 * a wiped cache just means the next request is a full fetch.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { apiCacheDir } from "./paths.ts";
import { readJsonIfExists, writeJsonAtomic } from "./fs.ts";
import { log } from "./logger.ts";

const logger = log("http");

/** Default revalidation window: within this, the cached body is served as-is. */
const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes

/** Thrown when a request fails and there is no cached body to fall back to. */
export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(`HTTP ${status ?? "error"} for ${url}: ${message}`);
    this.name = "HttpError";
  }
}

/** Options for {@link fetchText} / {@link fetchJson}. */
export interface FetchOptions {
  /**
   * Serve the cached body without any network call when the last fetch was
   * within this many ms. Set `0` to always revalidate conditionally. Default 5m.
   */
  ttlMs?: number;
  /** Extra request headers (e.g. a `User-Agent` or `Accept`). */
  headers?: Record<string, string>;
  /** Bypass the cache entirely (force a fresh fetch and overwrite the entry). */
  noCache?: boolean;
}

/** One cache entry, persisted as JSON under `~/.cache/mctl/api/<hash>.json`. */
interface CacheEntry {
  url: string;
  /** `ETag` response header, when the origin sent one. */
  etag?: string;
  /** `Last-Modified` response header, when the origin sent one. */
  lastModified?: string;
  /** Epoch ms of the last successful fetch/revalidation. */
  fetchedAt: number;
  /** The cached response body. */
  body: string;
}

/** Cache file path for a URL (sha-256 of the URL keeps names filesystem-safe). */
function cacheFile(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return join(apiCacheDir(), `${hash}.json`);
}

async function readEntry(url: string): Promise<CacheEntry | undefined> {
  try {
    const raw = await readJsonIfExists(cacheFile(url));
    return raw as CacheEntry | undefined;
  } catch {
    // A corrupt cache file is disposable — treat as a miss.
    return undefined;
  }
}

/**
 * Fetch a URL as text, using the on-disk ETag cache. See the module doc for the
 * caching model. Serves stale cache on network failure; throws {@link HttpError}
 * only when there is nothing cached to fall back to.
 */
export async function fetchText(
  url: string,
  options: FetchOptions = {},
): Promise<string> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cached = options.noCache ? undefined : await readEntry(url);

  // Fresh within the TTL — no network call needed.
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.body;
  }

  const headers: Record<string, string> = { ...options.headers };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    if (cached) {
      logger.warn({ url, err: String(err) }, "fetch failed; serving stale cache");
      return cached.body;
    }
    throw new HttpError(url, undefined, String(err));
  }

  // Not modified — our cache is still good. Refresh its timestamp so we don't
  // revalidate again until the next TTL window.
  if (response.status === 304 && cached) {
    await writeJsonAtomic(cacheFile(url), {
      ...cached,
      fetchedAt: Date.now(),
    } satisfies CacheEntry);
    return cached.body;
  }

  if (!response.ok) {
    if (cached) {
      logger.warn(
        { url, status: response.status },
        "non-ok response; serving stale cache",
      );
      return cached.body;
    }
    throw new HttpError(url, response.status, response.statusText);
  }

  const body = await response.text();
  const entry: CacheEntry = {
    url,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    fetchedAt: Date.now(),
    body,
  };
  if (!options.noCache) await writeJsonAtomic(cacheFile(url), entry);
  return body;
}

/**
 * Fetch a URL and parse it as JSON. The result is `unknown` — the caller
 * **must** validate it with Zod before use (upstream API responses are untrusted
 * off-network data). Caching behaviour is identical to {@link fetchText}.
 */
export async function fetchJson(
  url: string,
  options: FetchOptions = {},
): Promise<unknown> {
  return JSON.parse(await fetchText(url, options));
}
