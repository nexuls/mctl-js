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
 *
 * **Resume.** With `resume: true` the temp file is *named after the destination*
 * rather than randomly, so a transfer interrupted halfway can be continued with
 * an HTTP `Range` request instead of restarting. That matters at this file's
 * scale — a Forge installer pulls Minecraft's whole library tree and a JDK is
 * ~200 MB — and it is the reason the digest is computed by re-reading the
 * partial file rather than only from the live stream: the bytes already on disk
 * were hashed by a previous process, or possibly a previous week.
 */

import { createHash } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
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
	/** Expected hex MD5 digest, for origins that publish only MD5 (PurpurMC). */
	md5?: string;
	/** Expected size in bytes, used for progress when there is no `Content-Length`. */
	size?: number;
	/**
	 * Keep a partial transfer and continue it on a later call (see the module
	 * doc). Off by default: a predictable temp name is only safe when the caller
	 * knows two downloads of the same destination are the same artefact.
	 */
	resume?: boolean;
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
		super(
			`download failed for ${url}${status ? ` (HTTP ${status})` : ""}: ${message}`,
		);
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
	// A resumable transfer needs a *stable* temp name so a later call can find the
	// partial file; a one-shot one gets a unique name so two concurrent downloads
	// of the same destination cannot interleave into one corrupt file.
	const temp = options.resume
		? join(dirname(dest), `.${basename(dest)}.part`)
		: join(dirname(dest), tempNameFor(basename(dest)));

	const already = options.resume ? await fileSize(temp) : 0;
	const headers = { ...options.headers };
	if (already > 0) headers.Range = `bytes=${already}-`;

	let response: Response;
	try {
		response = await fetch(url, { headers, signal: options.signal });
	} catch (err) {
		throw new DownloadError(url, undefined, String(err));
	}
	if (!response.ok || !response.body) {
		throw new DownloadError(url, response.status, response.statusText);
	}

	// A server that ignores `Range` answers 200 with the whole body — then the
	// partial file is worthless and the transfer starts over. Only a 206 means the
	// bytes on disk are a genuine prefix of what is arriving now.
	const resumed = already > 0 && response.status === 206;
	if (already > 0 && !resumed) {
		logger.info({ url, already }, "origin ignored Range; restarting download");
		await removeQuietly(temp);
	}

	const header = response.headers.get("content-length");
	const streamed = header ? Number(header) : undefined;
	const total =
		streamed !== undefined ? streamed + (resumed ? already : 0) : options.size;

	// Every digest is computed in one pass: which one upstream publishes is the
	// origin's choice (Mojang: SHA-1, PaperMC: SHA-256, Purpur: MD5) and hashing
	// three times over a stream we are already touching costs nothing measurable.
	const sha256 = createHash("sha256");
	const sha1 = createHash("sha1");
	const md5 = createHash("md5");
	const update = (chunk: Uint8Array) => {
		sha256.update(chunk);
		sha1.update(chunk);
		md5.update(chunk);
	};

	// The bytes a previous attempt wrote were never hashed by this process, so a
	// resumed transfer replays the partial file through the digests before the
	// stream continues them.
	let received = 0;
	if (resumed) {
		for await (const chunk of Bun.file(
			temp,
		).stream() as unknown as AsyncIterable<Uint8Array>) {
			update(chunk);
			received += chunk.byteLength;
		}
		logger.info({ url, resumedAt: received }, "resuming download");
	}

	// `Bun.file().writer()` truncates, which is exactly wrong for a resumed
	// transfer, so the sink is a plain append-mode file handle in both cases —
	// `"a"` for a continuation, `"w"` for a fresh start.
	const handle = await open(temp, resumed ? "a" : "w");

	let lastReport = 0;
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			update(chunk);
			await handle.write(chunk);
			received += chunk.byteLength;

			const now = Date.now();
			if (options.onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
				lastReport = now;
				options.onProgress(progressOf(received, total));
			}
		}
		await handle.close();
	} catch (err) {
		await handle.close().catch(() => {});
		// A partial file is kept only when the caller asked for resume; otherwise it
		// is exactly the plausible-looking corrupt artefact this module exists to
		// prevent.
		if (!options.resume) await removeQuietly(temp);
		throw new DownloadError(url, undefined, String(err));
	}

	const actual256 = sha256.digest("hex");
	const actual1 = sha1.digest("hex");
	const actualMd5 = md5.digest("hex");

	if (options.sha256 && !digestEquals(options.sha256, actual256)) {
		await removeQuietly(temp);
		throw new ChecksumError(url, "sha256", options.sha256, actual256);
	}
	if (options.sha1 && !digestEquals(options.sha1, actual1)) {
		await removeQuietly(temp);
		throw new ChecksumError(url, "sha1", options.sha1, actual1);
	}
	if (options.md5 && !digestEquals(options.md5, actualMd5)) {
		// A mismatch always removes the partial file, resume or not: continuing a
		// transfer whose bytes are already known to be wrong would never converge.
		await removeQuietly(temp);
		throw new ChecksumError(url, "md5", options.md5, actualMd5);
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

/** Size of a file in bytes, or 0 when it does not exist — never throws. */
async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

/** Best-effort temp-file cleanup; a leftover temp file must not mask the real error. */
async function removeQuietly(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// Already gone, or never created — nothing to report.
	}
}
