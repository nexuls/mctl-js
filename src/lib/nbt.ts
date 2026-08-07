/**
 * NBT — a minimal reader for Minecraft's Named Binary Tag format.
 *
 * Leaf-level helper (AGENTS.md § 3): pure decoding over a byte buffer. It knows
 * nothing about servers, players, or providers — a caller hands it bytes and
 * gets plain JavaScript values back.
 *
 * **Why this exists.** Everything a Minecraft server knows about a *player's
 * body* — health, hunger, experience, position, game mode — lives in
 * `<world>/playerdata/<uuid>.dat`, which is a gzipped NBT compound. There is no
 * JSON form of it and no way to ask a running server for it without RCON or a
 * mod, so reading the file is the only route to those numbers.
 *
 * **Format** (https://minecraft.wiki/w/NBT_format): every value is
 * `tag-type byte | name (only inside a compound) | payload`, all integers
 * big-endian, all strings length-prefixed UTF-8 (technically Java's *modified*
 * UTF-8; the difference only shows up for the NUL character and surrogate pairs,
 * neither of which appears in the fields MCTL reads). A file's root is a single
 * unnamed-in-practice compound.
 *
 * **Scope, deliberately:** read-only, and no writer. MCTL never modifies a
 * server's world data — worlds are irreplaceable user data (AGENTS.md
 * § "Secrets and user data"), and every mutation MCTL performs on players goes
 * through the server's own console instead.
 */

import { gunzipSync, inflateSync } from "node:zlib";

/** Numeric ids of the NBT tag types, in the order the format defines them. */
const TAG = {
	end: 0,
	byte: 1,
	short: 2,
	int: 3,
	long: 4,
	float: 5,
	double: 6,
	byteArray: 7,
	string: 8,
	list: 9,
	compound: 10,
	intArray: 11,
	longArray: 12,
} as const;

/**
 * A decoded NBT value.
 *
 * `long`/`longArray` decode to `bigint` because a 64-bit tag does not survive a
 * `number` — Minecraft stores timestamps in milliseconds and world seeds there,
 * both of which exceed `Number.MAX_SAFE_INTEGER`. Use {@link nbtNumber} at the
 * point of use rather than coercing on the way in.
 */
export type NbtValue =
	| number
	| bigint
	| string
	| Uint8Array
	| BigInt64Array
	| Int32Array
	| NbtValue[]
	| NbtCompound;

/** A decoded `TAG_Compound`: named children in the order they were written. */
export interface NbtCompound {
	[name: string]: NbtValue;
}

/** Thrown when a buffer is not decodable NBT. */
export class NbtParseError extends Error {
	constructor(message: string) {
		super(`invalid NBT: ${message}`);
		this.name = "NbtParseError";
	}
}

/** A cursor over the buffer; every read advances {@link Reader.offset}. */
class Reader {
	offset = 0;
	readonly #view: DataView;
	readonly #bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	#need(count: number): void {
		if (this.offset + count > this.#bytes.byteLength) {
			throw new NbtParseError(
				`truncated: wanted ${count} bytes at ${this.offset} of ${this.#bytes.byteLength}`,
			);
		}
	}

	i8(): number {
		this.#need(1);
		const value = this.#view.getInt8(this.offset);
		this.offset += 1;
		return value;
	}

	u8(): number {
		this.#need(1);
		const value = this.#view.getUint8(this.offset);
		this.offset += 1;
		return value;
	}

	i16(): number {
		this.#need(2);
		const value = this.#view.getInt16(this.offset);
		this.offset += 2;
		return value;
	}

	u16(): number {
		this.#need(2);
		const value = this.#view.getUint16(this.offset);
		this.offset += 2;
		return value;
	}

	i32(): number {
		this.#need(4);
		const value = this.#view.getInt32(this.offset);
		this.offset += 4;
		return value;
	}

	i64(): bigint {
		this.#need(8);
		const value = this.#view.getBigInt64(this.offset);
		this.offset += 8;
		return value;
	}

	f32(): number {
		this.#need(4);
		const value = this.#view.getFloat32(this.offset);
		this.offset += 4;
		return value;
	}

	f64(): number {
		this.#need(8);
		const value = this.#view.getFloat64(this.offset);
		this.offset += 8;
		return value;
	}

	string(): string {
		const length = this.u16();
		this.#need(length);
		const text = new TextDecoder().decode(
			this.#bytes.subarray(this.offset, this.offset + length),
		);
		this.offset += length;
		return text;
	}

	bytes(count: number): Uint8Array {
		this.#need(count);
		// `slice` copies: the returned array must not alias a buffer the caller may
		// later reuse, and these are small (an inventory, not a chunk).
		const out = this.#bytes.slice(this.offset, this.offset + count);
		this.offset += count;
		return out;
	}
}

/** Read one tag payload of the given type. */
function readPayload(reader: Reader, type: number): NbtValue {
	switch (type) {
		case TAG.byte:
			return reader.i8();
		case TAG.short:
			return reader.i16();
		case TAG.int:
			return reader.i32();
		case TAG.long:
			return reader.i64();
		case TAG.float:
			return reader.f32();
		case TAG.double:
			return reader.f64();
		case TAG.byteArray:
			return reader.bytes(reader.i32());
		case TAG.string:
			return reader.string();
		case TAG.list: {
			const itemType = reader.u8();
			const length = reader.i32();
			const items: NbtValue[] = [];
			// A list of TAG_End is how an *empty* list is written (the writer has no
			// element type to name), so the length is skipped rather than trusted.
			if (itemType === TAG.end) return items;
			for (let i = 0; i < length; i += 1)
				items.push(readPayload(reader, itemType));
			return items;
		}
		case TAG.compound: {
			const compound: NbtCompound = {};
			for (;;) {
				const childType = reader.u8();
				if (childType === TAG.end) return compound;
				const name = reader.string();
				compound[name] = readPayload(reader, childType);
			}
		}
		case TAG.intArray: {
			const length = reader.i32();
			const out = new Int32Array(length);
			for (let i = 0; i < length; i += 1) out[i] = reader.i32();
			return out;
		}
		case TAG.longArray: {
			const length = reader.i32();
			const out = new BigInt64Array(length);
			for (let i = 0; i < length; i += 1) out[i] = reader.i64();
			return out;
		}
		default:
			throw new NbtParseError(`unknown tag type ${type}`);
	}
}

/**
 * Decompress `bytes` if they carry a gzip or zlib header.
 *
 * Player data is gzipped on disk, but region-extracted and hand-made files turn
 * up raw or zlib-deflated, so the magic number decides rather than the caller.
 * `1f 8b` is gzip; a `78` first byte whose two-byte big-endian value is a
 * multiple of 31 is a zlib stream (that check is the zlib header's own checksum
 * rule, and is what tells `78 9c` apart from a raw NBT compound).
 */
function decompress(bytes: Uint8Array): Uint8Array {
	const first = bytes[0];
	const second = bytes[1];
	if (first === 0x1f && second === 0x8b)
		return new Uint8Array(gunzipSync(bytes));
	if (
		first === 0x78 &&
		second !== undefined &&
		((first << 8) | second) % 31 === 0
	) {
		return new Uint8Array(inflateSync(bytes));
	}
	return bytes;
}

/**
 * Parse an NBT file into its root compound, transparently decompressing gzip or
 * zlib payloads.
 *
 * @param bytes the whole file's contents.
 * @returns the root compound's children.
 * @throws {NbtParseError} when the buffer is truncated, uses an unknown tag
 *   type, or does not begin with a compound.
 */
export function parseNbt(bytes: Uint8Array): NbtCompound {
	if (bytes.byteLength === 0) throw new NbtParseError("empty buffer");
	const reader = new Reader(decompress(bytes));
	const type = reader.u8();
	if (type !== TAG.compound) {
		throw new NbtParseError(`root tag is ${type}, expected a compound`);
	}
	reader.string(); // Root name — conventionally empty, and never meaningful.
	const root = readPayload(reader, TAG.compound);
	return root as NbtCompound;
}

/**
 * Read a nested value by path, e.g. `nbtGet(root, "abilities", "flying")`.
 * Returns `undefined` as soon as any step is missing or is not a compound, so a
 * caller never has to guard each level — which matters here because the shape
 * varies by Minecraft version and by server implementation.
 */
export function nbtGet(
	root: NbtCompound,
	...path: string[]
): NbtValue | undefined {
	let current: NbtValue | undefined = root;
	for (const key of path) {
		if (current === undefined || typeof current !== "object") return undefined;
		if (Array.isArray(current) || ArrayBuffer.isView(current)) return undefined;
		current = (current as NbtCompound)[key];
	}
	return current;
}

/**
 * Coerce an NBT value to a `number`, or `undefined` when it is not numeric.
 * Handles `bigint` (every 64-bit tag) by narrowing — safe for the timestamps and
 * counters MCTL reads, all of which are far inside the safe-integer range.
 */
export function nbtNumber(value: NbtValue | undefined): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return undefined;
}

/** Coerce an NBT value to a `string`, or `undefined` when it is not one. */
export function nbtString(value: NbtValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}
