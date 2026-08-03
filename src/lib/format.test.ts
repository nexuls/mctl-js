/**
 * Tests for the humanizers both front-ends format view-model values with.
 *
 * These are pure and cheap, and they are load-bearing for layout: a duration or
 * size that is one character wider than its column silently truncates a table
 * cell, so the shapes they can produce matter as much as the values.
 */

import { describe, expect, test } from "bun:test";
import { formatBytes, formatDuration, parseMemorySize } from "./format.ts";

describe("formatDuration", () => {
	test("steps through seconds, minutes, hours, days", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(90_000)).toBe("1m");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(12_600_000)).toBe("3h 30m");
		expect(formatDuration(200_000_000)).toBe("2d 7h");
	});

	test("drops the second unit when it is zero", () => {
		expect(formatDuration(7_200_000)).toBe("2h");
		expect(formatDuration(172_800_000)).toBe("2d");
	});

	test("never exceeds the width a table column budgets for it", () => {
		// The dashboard's uptime column is 8 cells wide; every representable
		// duration up to a decade has to fit inside it.
		for (const ms of [0, 999, 59_999, 3_599_999, 86_399_999, 3.2e11]) {
			expect(formatDuration(ms).length).toBeLessThanOrEqual(8);
		}
	});

	test("renders an unknown quantity rather than a bogus number", () => {
		expect(formatDuration(-1)).toBe("—");
		expect(formatDuration(Number.NaN)).toBe("—");
	});
});

describe("parseMemorySize", () => {
	test("reads the JVM heap suffixes", () => {
		expect(parseMemorySize("2G")).toBe(2 * 1024 ** 3);
		expect(parseMemorySize("512M")).toBe(512 * 1024 ** 2);
		expect(parseMemorySize("1024K")).toBe(1024 * 1024);
		expect(parseMemorySize("4g")).toBe(4 * 1024 ** 3);
		expect(parseMemorySize(" 1GB ")).toBe(1024 ** 3);
	});

	test("treats a bare number as bytes", () => {
		expect(parseMemorySize("1024")).toBe(1024);
	});

	test("returns undefined for anything else, so callers can hide the meter", () => {
		expect(parseMemorySize("lots")).toBeUndefined();
		expect(parseMemorySize("")).toBeUndefined();
		expect(parseMemorySize("2X")).toBeUndefined();
	});

	test("round-trips through formatBytes", () => {
		expect(formatBytes(parseMemorySize("2G") as number)).toBe("2 GB");
	});
});
