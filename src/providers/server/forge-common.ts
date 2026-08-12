/**
 * The two facts Forge and NeoForge share, and nothing else.
 *
 * Not a provider — a two-function helper beside the providers that use it, for
 * the same reason `mojang-meta.ts` is not one. Deliberately *small*: Forge and
 * NeoForge have different origins, different version schemes and different
 * artefact layouts, so a shared base class would be an abstraction over two
 * things that only rhyme. What they genuinely share is the shape of the argfile
 * their installers generate and the need to compare Minecraft versions.
 */

/**
 * The argfile the Forge-family installer generates for this platform.
 *
 * The installer writes both `unix_args.txt` and `win_args.txt` into the version
 * directory; which one is correct is a property of the *running* machine, not of
 * the server — they differ in path separators and in the classpath separator
 * (`:` vs `;`), so using the wrong one produces a JVM that cannot find its
 * modules.
 */
export function argFileName(platform: string = process.platform): string {
	return platform === "win32" ? "win_args.txt" : "unix_args.txt";
}

/**
 * Compare two Minecraft version strings numerically: `-1`, `0`, or `1`.
 *
 * Written by hand rather than with `localeCompare`, because a string comparison
 * puts `1.9` after `1.17` and every version cutoff in this file would then be
 * wrong for exactly the versions it exists to distinguish. Non-numeric suffixes
 * (`1.21.4-rc1`) compare as the release they precede, which is the right answer
 * for a "is this at least 1.17" question; an unparseable component sorts as 0.
 */
export function compareMinecraftVersions(a: string, b: string): number {
	const parts = (v: string) =>
		v.split(".").map((piece) => Number.parseInt(piece, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}
