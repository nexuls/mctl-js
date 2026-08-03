/**
 * Human-formatting leaf helpers: turn raw numbers into display strings.
 *
 * UI-free, provider-free, no I/O — pure string/number formatting. The TUI and
 * the CLI both format the same view-model values, so shared humanizers live here
 * rather than being re-implemented per front-end.
 */

/** Binary size units, ascending. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Format a byte count as a compact human string (`1536` → `"1.5 KB"`). Uses
 * binary (1024) steps, one decimal place below 100 of a unit and none at or
 * above it, so values read cleanly at any magnitude. Non-finite or negative
 * inputs render as `"—"` — the caller passed an unknown quantity, not a size.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		unit === 0 || value >= 100
			? Math.round(value)
			: Math.round(value * 10) / 10;
	return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * Format a duration in milliseconds as a compact uptime string: `"45s"`,
 * `"12m"`, `"3h 20m"`, `"2d 4h"`.
 *
 * Two units at most, and the second only while it is significant — a server up
 * for nine days does not need its minutes, and a column three cells wider for
 * them costs another column its place on a narrow terminal. Negative or
 * non-finite input renders as `"—"`.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	// Past a hundred days the hours are noise, and keeping them would push the
	// string to nine cells — one more than the uptime column budgets for it.
	return rest === 0 || days >= 100 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * Parse a JVM heap string (`"2G"`, `"512M"`, `"1024K"`, or a bare byte count)
 * into bytes, or `undefined` when it is not one. Used to show a server's
 * resident memory against the heap it was *allowed*, which is the only heap
 * figure available from outside the JVM.
 */
export function parseMemorySize(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i.exec(value.trim());
	if (!match?.[1]) return undefined;
	const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
	const suffix = match[2]?.toLowerCase() as keyof typeof scale | undefined;
	return Number(match[1]) * (suffix ? scale[suffix] : 1);
}
