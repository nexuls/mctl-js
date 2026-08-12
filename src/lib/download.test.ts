/**
 * Tests for {@link downloadFile}'s verification and resume, driven against a
 * **real local HTTP server** rather than a mocked `fetch`.
 *
 * Resume is an HTTP conversation — a `Range` request, a `206` with a shorter
 * body, and a partial file that must be hashed from disk — and a stubbed fetch
 * would let all three drift out of agreement while the test kept passing. The
 * server here also has a mode that *ignores* `Range`, because an origin that
 * answers `200` to a range request is the case that corrupts a resumed file if
 * it is not detected.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChecksumError, downloadFile } from "./download.ts";

/** Body big enough that a partial prefix is unambiguous. */
const BODY = "0123456789".repeat(200);
const MD5 = createHash("md5").update(BODY).digest("hex");
const SHA256 = createHash("sha256").update(BODY).digest("hex");

/** Set to make the next response ignore `Range` and send the whole body. */
let ignoreRange = false;
/** Ranges the server was asked for, so the test can prove one was sent. */
const rangesSeen: string[] = [];

const server = Bun.serve({
	port: 0,
	fetch(request) {
		const range = request.headers.get("range");
		if (range) rangesSeen.push(range);
		if (range && !ignoreRange) {
			const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
			return new Response(BODY.slice(from), {
				status: 206,
				headers: {
					"content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
				},
			});
		}
		return new Response(BODY);
	},
});
const url = `http://localhost:${server.port}/artifact.bin`;

afterAll(() => server.stop(true));

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-download-"));
	ignoreRange = false;
	rangesSeen.length = 0;
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("checksums", () => {
	test("accepts an artefact matching its published MD5", async () => {
		const dest = join(dir, "ok.bin");
		const result = await downloadFile(url, dest, { md5: MD5 });
		expect(result.size).toBe(BODY.length);
		expect(await Bun.file(dest).text()).toBe(BODY);
	});

	test("rejects a wrong MD5 and leaves no file behind", async () => {
		// Purpur publishes only MD5, so this is the only integrity check there is
		// for that kind — a mismatch must not leave a plausible-looking jar.
		const dest = join(dir, "bad.bin");
		await expect(
			downloadFile(url, dest, { md5: "0".repeat(32) }),
		).rejects.toThrow(ChecksumError);
		expect(await Bun.file(dest).exists()).toBe(false);
	});

	test("digest comparison is case-insensitive", async () => {
		await downloadFile(url, join(dir, "upper.bin"), { md5: MD5.toUpperCase() });
	});
});

describe("resume", () => {
	test("continues from a partial file with a Range request", async () => {
		const dest = join(dir, "resumed.bin");
		const part = join(dir, ".resumed.bin.part");
		await writeFile(part, BODY.slice(0, 500));

		const result = await downloadFile(url, dest, {
			resume: true,
			sha256: SHA256,
		});

		expect(rangesSeen).toEqual(["bytes=500-"]);
		// The digest covers the whole artefact, so the bytes already on disk must
		// have been replayed through it — a resumed download that hashed only the
		// new bytes would fail here.
		expect(result.size).toBe(BODY.length);
		expect(await Bun.file(dest).text()).toBe(BODY);
	});

	test("starts over when the origin ignores Range", async () => {
		// A 200 to a range request means the body is the *whole* artefact; appending
		// it to the partial file would silently produce a corrupt one.
		ignoreRange = true;
		const dest = join(dir, "ignored.bin");
		await writeFile(join(dir, ".ignored.bin.part"), BODY.slice(0, 500));

		const result = await downloadFile(url, dest, {
			resume: true,
			sha256: SHA256,
		});
		expect(result.size).toBe(BODY.length);
		expect(await Bun.file(dest).text()).toBe(BODY);
	});

	test("a fresh resumable download needs no Range", async () => {
		await downloadFile(url, join(dir, "fresh.bin"), { resume: true });
		expect(rangesSeen).toEqual([]);
	});

	test("without resume, the temp file is unique and removed", async () => {
		const dest = join(dir, "plain.bin");
		await downloadFile(url, dest, {});
		expect(await Bun.file(join(dir, ".plain.bin.part")).exists()).toBe(false);
		expect((await stat(dest)).size).toBe(BODY.length);
	});
});
