/**
 * zip — a minimal, read-only reader for named entries inside a ZIP archive.
 *
 * Leaf helper (`lib/`): it knows nothing about servers, mods or Minecraft — it
 * turns an archive plus a list of entry names into bytes. UI-free; no
 * `Bun.spawn`.
 *
 * **Why hand-rolled rather than a dependency.** A jar is a ZIP, and the only
 * thing MCTL ever wants out of one is a metadata file of a few hundred bytes
 * (`fabric.mod.json`, `META-INF/mods.toml`, `plugin.yml`). Neither Bun nor Node
 * ships a ZIP reader, and pulling one in to read one small member of a file we
 * otherwise never open is more dependency than the ~120 lines below.
 *
 * **It reads only what is asked for.** A mod jar is routinely tens of megabytes;
 * loading one into memory to fish out a 400-byte manifest — for every jar in a
 * `mods/` directory, on a poll — is exactly the kind of cost that has no reason
 * to exist. So this seeks: the end-of-central-directory record from the tail,
 * then the central directory, then the local header and compressed bytes of the
 * wanted entries alone.
 *
 * **What is supported:** stored (method 0) and deflated (method 8) entries,
 * which between them cover every jar and datapack zip in practice.
 *
 * **What is not:** ZIP64 (archives past 4 GiB or 65535 entries) and encrypted
 * entries, both of which throw {@link ZipError}, and every other compression
 * method. A caller decorating a listing should treat a throw as "no metadata",
 * not as a failure of the listing.
 *
 * Format reference: PKWARE APPNOTE 6.3.10 § 4.3.6–4.3.16
 * (https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
 */

import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/** Thrown when an archive is not readable as a ZIP, or uses an unsupported feature. */
export class ZipError extends Error {
	constructor(message: string) {
		super(`invalid or unsupported zip: ${message}`);
		this.name = "ZipError";
	}
}

/** Signature of the end-of-central-directory record (§ 4.3.16). */
const EOCD_SIGNATURE = 0x06054b50;

/** Signature of a central-directory file header (§ 4.3.12). */
const CENTRAL_SIGNATURE = 0x02014b50;

/** Signature of a local file header (§ 4.3.7). */
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * How far back from the end of the file the EOCD record is searched for. The
 * record is 22 bytes plus a comment of at most 65535, so this is its largest
 * legal distance from the end.
 */
const EOCD_SEARCH_BYTES = 22 + 0xffff;

/** The `general purpose bit flag` bit that marks an entry as encrypted (§ 4.4.4). */
const FLAG_ENCRYPTED = 0x1;

/** One entry as described by the archive's central directory. */
export interface ZipEntry {
	/** Entry path inside the archive, e.g. `META-INF/mods.toml`. */
	name: string;
	/** Compression method: 0 stored, 8 deflated. */
	method: number;
	/** Bytes the entry occupies compressed. */
	compressedSize: number;
	/** Bytes the entry expands to. */
	size: number;
	/** Offset of the entry's *local* header from the start of the file. */
	offset: number;
	/** Raw general-purpose bit flag, used here only to detect encryption. */
	flags: number;
}

/** Read exactly `length` bytes at `position`, or as many as the file holds. */
async function readAt(
	handle: FileHandle,
	position: number,
	length: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

/**
 * Parse the central directory of an open archive.
 *
 * @throws {@link ZipError} when no EOCD record is found (not a ZIP, or
 *   truncated) or when the archive needs ZIP64 to be addressed.
 */
async function readCentralDirectory(
	handle: FileHandle,
	fileSize: number,
): Promise<ZipEntry[]> {
	const tailLength = Math.min(fileSize, EOCD_SEARCH_BYTES);
	const tail = await readAt(handle, fileSize - tailLength, tailLength);

	// Scan backwards: the record is at the very end unless the archive carries a
	// comment, and a comment can itself contain the signature bytes — the *last*
	// match is the real record.
	let eocd = -1;
	for (let i = tail.length - 22; i >= 0; i -= 1) {
		if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError("no end-of-central-directory record");

	const count = tail.readUInt16LE(eocd + 10);
	const size = tail.readUInt32LE(eocd + 12);
	const offset = tail.readUInt32LE(eocd + 16);
	// 0xffff/0xffffffff are the "look in the ZIP64 record" sentinels. MCTL never
	// meets one in a mod jar, and guessing past it would read garbage offsets.
	if (offset === 0xffffffff || size === 0xffffffff || count === 0xffff) {
		throw new ZipError("zip64 archives are not supported");
	}

	const directory = await readAt(handle, offset, size);
	const entries: ZipEntry[] = [];
	let cursor = 0;
	while (cursor + 46 <= directory.length) {
		if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
		const nameLength = directory.readUInt16LE(cursor + 28);
		const extraLength = directory.readUInt16LE(cursor + 30);
		const commentLength = directory.readUInt16LE(cursor + 32);
		entries.push({
			flags: directory.readUInt16LE(cursor + 8),
			method: directory.readUInt16LE(cursor + 10),
			compressedSize: directory.readUInt32LE(cursor + 20),
			size: directory.readUInt32LE(cursor + 24),
			offset: directory.readUInt32LE(cursor + 42),
			name: directory
				.subarray(cursor + 46, cursor + 46 + nameLength)
				.toString("utf8"),
		});
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** Read and decompress one entry, given its central-directory record. */
async function readEntry(
	handle: FileHandle,
	entry: ZipEntry,
): Promise<Uint8Array> {
	if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
		throw new ZipError(`entry is encrypted: ${entry.name}`);
	}
	// The local header repeats the name and carries its *own* extra field, which
	// is frequently a different length from the central one — so the data offset
	// has to be computed from the local header, never from the central record.
	const header = await readAt(handle, entry.offset, 30);
	if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
		throw new ZipError(`no local header for ${entry.name}`);
	}
	const dataOffset =
		entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
	const raw = await readAt(handle, dataOffset, entry.compressedSize);

	if (entry.method === 0) return new Uint8Array(raw);
	if (entry.method === 8) return new Uint8Array(inflateRawSync(raw));
	throw new ZipError(`unsupported compression method ${entry.method}`);
}

/**
 * Read the named entries out of a ZIP archive.
 *
 * Only the requested entries are read; names the archive does not hold are
 * simply absent from the result rather than being an error, so a caller can ask
 * for every metadata file it knows about in one pass.
 *
 * @param path archive on disk (a jar is a ZIP).
 * @param names exact entry paths, case-sensitive, e.g. `["fabric.mod.json"]`.
 * @throws {@link ZipError} when the file is not a readable ZIP, plus any
 *   filesystem error from opening it.
 */
export async function readZipEntries(
	path: string,
	names: readonly string[],
): Promise<Map<string, Uint8Array>> {
	const wanted = new Set(names);
	const found = new Map<string, Uint8Array>();
	if (wanted.size === 0) return found;

	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		for (const entry of await readCentralDirectory(handle, size)) {
			if (!wanted.has(entry.name) || found.has(entry.name)) continue;
			found.set(entry.name, await readEntry(handle, entry));
		}
		return found;
	} finally {
		await handle.close();
	}
}

/**
 * The UTF-8 twin of {@link readZipEntries}, for the text manifests that are the
 * only thing MCTL reads out of an archive.
 */
export async function readZipText(
	path: string,
	names: readonly string[],
): Promise<Map<string, string>> {
	const entries = await readZipEntries(path, names);
	const text = new Map<string, string>();
	for (const [name, bytes] of entries) {
		text.set(name, Buffer.from(bytes).toString("utf8"));
	}
	return text;
}
