/**
 * Streaming file downloads with progress reporting and checksum verification.
 *
 * Leaf helper (`lib/`) — UI-free, provider-free, server-free. It knows nothing
 * about jars or JDKs; it moves bytes from a URL to a path and proves they are the
 * bytes that were promised.
 *
 * Deliberately **not** part of `lib/http.ts`: that module caches small manifest
 * *bodies* in memory and on disk, which is exactly the wrong thing to do with a
 * 60 MB server jar. Here the body is streamed straight to disk and never held.
 *
 * **Write discipline.** The bytes land in a sibling temp file, are hashed as they
 * stream, and are `rename`d over the destination only after the digest matches.
 * A failed or mismatched download therefore never leaves a plausible-looking but
 * corrupt jar behind — the caller sees an exception and no file.
 */

import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ensureDir, tempNameFor } from "./fs.ts";
import { log } from "./logger.ts";

const logger = log("download");

/** How often progress is reported at most, so a fast download can't flood the UI. */
const PROGRESS_INTERVAL_MS = 100;

/** Progress of an in-flight download. */
export interface DownloadProgress {
  /** Bytes written so far. */
  received: number;
  /** Total bytes, when the server sent `Content-Length` or the caller knew it. */
  total?: number;
  /** `received / total` in `0..1`, when `total` is known. */
  fraction?: number;
}

/** Options for {@link downloadFile}. */
export interface DownloadOptions {
  /** Expected hex SHA-256 digest. Verified before the file is moved into place. */
  sha256?: string;
  /** Expected hex SHA-1 digest, for origins that publish only SHA-1 (Mojang). */
  sha1?: string;
  /** Expected size in bytes, used for progress when there is no `Content-Length`. */
  size?: number;
  /** Called at most every ~100 ms, plus once at completion. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Abort the transfer (cancels the request and removes the temp file). */
  signal?: AbortSignal;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/** What was downloaded. */
export interface DownloadResult {
  /** Absolute path the file was written to. */
  path: string;
  /** Number of bytes written. */
  size: number;
  /** Hex SHA-256 of the received bytes — always computed, verified when expected. */
  sha256: string;
}

/** Thrown when a download's bytes do not match the digest upstream published. */
export class ChecksumError extends Error {
  constructor(
    readonly url: string,
    readonly algorithm: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `checksum mismatch for ${url}: expected ${algorithm} ${expected}, got ${actual}`,
    );
    this.name = "ChecksumError";
  }
}

/** Thrown when the origin refuses or the transfer fails mid-stream. */
export class DownloadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(`download failed for ${url}${status ? ` (HTTP ${status})` : ""}: ${message}`);
    this.name = "DownloadError";
  }
}

/**
 * Download `url` to `dest`, verifying any digest the caller supplies.
 *
 * @param url absolute URL to fetch.
 * @param dest absolute destination path; parent directories are created.
 * @throws {DownloadError} on a non-OK response or a stream failure.
 * @throws {ChecksumError} when a supplied digest does not match. The destination
 *   is left untouched in both cases.
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  await ensureDir(dirname(dest));
  const temp = join(dirname(dest), tempNameFor(basename(dest)));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: options.headers,
      signal: options.signal,
    });
  } catch (err) {
    throw new DownloadError(url, undefined, String(err));
  }
  if (!response.ok || !response.body) {
    throw new DownloadError(url, response.status, response.statusText);
  }

  const header = response.headers.get("content-length");
  const total = header ? Number(header) : options.size;

  // Both digests are computed in the same pass: which one upstream publishes is
  // the origin's choice (Mojang: SHA-1, PaperMC: SHA-256) and hashing twice over
  // a stream we are already touching costs nothing measurable.
  const sha256 = createHash("sha256");
  const sha1 = createHash("sha1");
  const sink = Bun.file(temp).writer();

  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      sha256.update(chunk);
      sha1.update(chunk);
      sink.write(chunk);
      received += chunk.byteLength;

      const now = Date.now();
      if (options.onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        // Flush periodically rather than per chunk: the sink buffers, and an
        // unflushed multi-hundred-MB download would otherwise grow memory.
        await sink.flush();
        options.onProgress(progressOf(received, total));
      }
    }
    await sink.end();
  } catch (err) {
    // `end()` may return a number (bytes written) rather than a promise, so it
    // is awaited rather than chained; a failure closing a doomed temp file is
    // irrelevant next to the error we are about to throw.
    try {
      await sink.end();
    } catch {
      // Ignored on purpose — see above.
    }
    await removeQuietly(temp);
    throw new DownloadError(url, undefined, String(err));
  }

  const actual256 = sha256.digest("hex");
  const actual1 = sha1.digest("hex");

  if (options.sha256 && !digestEquals(options.sha256, actual256)) {
    await removeQuietly(temp);
    throw new ChecksumError(url, "sha256", options.sha256, actual256);
  }
  if (options.sha1 && !digestEquals(options.sha1, actual1)) {
    await removeQuietly(temp);
    throw new ChecksumError(url, "sha1", options.sha1, actual1);
  }

  // Only now is the file allowed to appear at its real name. The temp file is a
  // sibling, so this rename stays within one filesystem and is atomic.
  await rename(temp, dest);

  options.onProgress?.(progressOf(received, received));
  logger.info({ url, dest, size: received }, "downloaded file");
  return { path: dest, size: received, sha256: actual256 };
}

/** Build a progress record, filling `fraction` only when a total is known. */
function progressOf(received: number, total?: number): DownloadProgress {
  return {
    received,
    total,
    fraction: total && total > 0 ? Math.min(1, received / total) : undefined,
  };
}

/** Case-insensitive hex digest comparison — origins differ on casing. */
function digestEquals(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.toLowerCase();
}

/** Best-effort temp-file cleanup; a leftover temp file must not mask the real error. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone, or never created — nothing to report.
  }
}
