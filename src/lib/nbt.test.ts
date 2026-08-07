/**
 * Tests for the NBT reader.
 *
 * There is no writer in `lib/nbt.ts` on purpose (MCTL never modifies world
 * data), so these tests carry a minimal encoder of their own — which also means
 * the fixtures are readable in the test rather than being an opaque blob.
 */

import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
	NbtParseError,
	nbtGet,
	nbtNumber,
	nbtString,
	parseNbt,
} from "./nbt.ts";

// ---------------------------------------------------------------------------
// A tiny encoder, sufficient for the tags player data actually uses.
// ---------------------------------------------------------------------------

const str = (value: string): Buffer => {
	const bytes = Buffer.from(value, "utf8");
	const length = Buffer.alloc(2);
	length.writeUInt16BE(bytes.length);
	return Buffer.concat([length, bytes]);
};

const named = (type: number, name: string, payload: Buffer): Buffer =>
	Buffer.concat([Buffer.from([type]), str(name), payload]);

const i8 = (value: number) => Buffer.from([value & 0xff]);
const i16 = (value: number) => {
	const b = Buffer.alloc(2);
	b.writeInt16BE(value);
	return b;
};
const i32 = (value: number) => {
	const b = Buffer.alloc(4);
	b.writeInt32BE(value);
	return b;
};
const i64 = (value: bigint) => {
	const b = Buffer.alloc(8);
	b.writeBigInt64BE(value);
	return b;
};
const f32 = (value: number) => {
	const b = Buffer.alloc(4);
	b.writeFloatBE(value);
	return b;
};
const f64 = (value: number) => {
	const b = Buffer.alloc(8);
	b.writeDoubleBE(value);
	return b;
};
const compound = (...children: Buffer[]) =>
	Buffer.concat([...children, Buffer.from([0])]);
const list = (itemType: number, ...items: Buffer[]) =>
	Buffer.concat([Buffer.from([itemType]), i32(items.length), ...items]);

/** Wrap children as a complete NBT file (root compound, empty name). */
const file = (...children: Buffer[]): Uint8Array =>
	new Uint8Array(
		Buffer.concat([Buffer.from([10]), str(""), compound(...children)]),
	);

describe("parseNbt", () => {
	test("decodes every tag type the player data uses", () => {
		const bytes = file(
			named(5, "Health", f32(17.5)),
			named(1, "foodLevel", i8(14)),
			named(3, "XpLevel", i32(34)),
			named(4, "Age", i64(1_717_171_717_171n)),
			named(2, "SelectedItemSlot", i16(3)),
			named(8, "Dimension", str("minecraft:overworld")),
			named(9, "Pos", list(6, f64(100.5), f64(64), f64(-20.25))),
			named(10, "bukkit", compound(named(4, "lastPlayed", i64(1234n)))),
		);

		const root = parseNbt(bytes);
		expect(nbtNumber(root.Health)).toBeCloseTo(17.5, 3);
		expect(root.foodLevel).toBe(14);
		expect(root.XpLevel).toBe(34);
		// A 64-bit tag stays a bigint: a millisecond timestamp does not survive a
		// double, which is exactly why `nbtNumber` is a separate step.
		expect(root.Age).toBe(1_717_171_717_171n);
		expect(root.SelectedItemSlot).toBe(3);
		expect(nbtString(root.Dimension)).toBe("minecraft:overworld");
		expect(root.Pos).toEqual([100.5, 64, -20.25]);
		expect(nbtNumber(nbtGet(root, "bukkit", "lastPlayed"))).toBe(1234);
	});

	test("transparently gunzips a compressed file", () => {
		const raw = file(named(3, "XpLevel", i32(7)));
		const compressed = new Uint8Array(gzipSync(raw));
		// The magic number, not the caller, decides — real player data is gzipped.
		expect(compressed[0]).toBe(0x1f);
		expect(parseNbt(compressed).XpLevel).toBe(7);
		expect(parseNbt(raw).XpLevel).toBe(7);
	});

	test("an empty list decodes as empty whatever its declared length", () => {
		// A writer with no elements has no element type to name, so it writes
		// TAG_End and a length that must not be trusted.
		const bytes = file(
			named(9, "Inventory", Buffer.concat([Buffer.from([0]), i32(99)])),
		);
		expect(parseNbt(bytes).Inventory).toEqual([]);
	});

	test("rejects a truncated file rather than returning half a compound", () => {
		const bytes = file(named(4, "Age", i64(5n)));
		expect(() => parseNbt(bytes.slice(0, bytes.length - 4))).toThrow(
			NbtParseError,
		);
	});

	test("rejects a buffer whose root is not a compound", () => {
		expect(() => parseNbt(new Uint8Array([3, 0, 0, 0, 0, 0, 1]))).toThrow(
			NbtParseError,
		);
		expect(() => parseNbt(new Uint8Array())).toThrow(NbtParseError);
	});
});

describe("nbtGet", () => {
	const root = parseNbt(
		file(named(10, "Paper", compound(named(4, "LastSeen", i64(42n))))),
	);

	test("walks a path and stops at the first missing step", () => {
		expect(nbtNumber(nbtGet(root, "Paper", "LastSeen"))).toBe(42);
		expect(nbtGet(root, "Paper", "Nope")).toBeUndefined();
		expect(nbtGet(root, "bukkit", "lastPlayed")).toBeUndefined();
		// Descending *through* a scalar is a miss, not a crash — the shape varies
		// by server implementation, so callers must never have to guard each level.
		expect(nbtGet(root, "Paper", "LastSeen", "deeper")).toBeUndefined();
	});
});
