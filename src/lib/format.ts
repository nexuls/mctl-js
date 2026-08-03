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
