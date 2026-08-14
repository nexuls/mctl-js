/**
 * A minimal ZIP **writer**, for tests only.
 *
 * MCTL never writes an archive — `lib/zip.ts` is read-only by design — but its
 * reader, and everything built on it (`core/server/content.ts`), has to be
 * tested against real archives rather than against hand-mocked bytes. This
 * builds them: valid local headers, a valid central directory, real CRC-32s and
 * genuinely deflated members, so a test that passes here proves the reader
 * handles a file `unzip` would also accept.
 *
 * Not imported by any application module, and it must stay that way — it lives
 * beside its subject rather than in a test file so that both `zip.test.ts` and
 * `core/server/content.test.ts` can build fixtures without one test file
 * importing another (which would re-register the other's tests).
 *
 * Format reference: PKWARE APPNOTE 6.3.10 § 4.3.
 */

import { deflateRawSync } from "node:zlib";

/** One member of a fixture archive. */
export interface ZipFixtureEntry {
	/** Entry path inside the archive, e.g. `META-INF/mods.toml`. */
	name: string;
	/** Contents; a string is encoded as UTF-8. */
	data: string | Uint8Array;
	/** 0 stored, 8 deflated (the default — jars deflate everything). */
	method?: 0 | 8;
}

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let value = i;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[i] = value >>> 0;
	}
	return table;
})();

/** CRC-32 of a byte string, as ZIP stores it. */
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive holding `entries`.
 *
 * @returns the whole archive, ready to be written to disk as a `.jar` or `.zip`.
 */
export function buildZip(entries: readonly ZipFixtureEntry[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const raw =
			typeof entry.data === "string"
				? new Uint8Array(Buffer.from(entry.data, "utf8"))
				: entry.data;
		const method = entry.method ?? 8;
		const body =
			method === 8 ? new Uint8Array(deflateRawSync(raw)) : new Uint8Array(raw);
		const name = Buffer.from(entry.name, "utf8");
		const crc = crc32(raw);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8); // flags
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);

		locals.push(local, Buffer.from(body));
		centrals.push(central);
		offset += local.length + body.length;
	}

	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);

	return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}
