/**
 * PaperProvider — PaperMC's high-performance Bukkit/Spigot fork.
 *
 * A concrete provider, and a thin one: everything about the upstream API lives in
 * `fill.ts`, which Velocity shares. Paper is the plain case — the project id, a
 * `server.jar`, and `nogui`.
 */

import { FillProvider } from "./fill.ts";

export class PaperProvider extends FillProvider {
	readonly id = "paper";
	readonly displayName = "Paper";
	readonly description =
		"Fast Bukkit/Spigot fork — plugins, no client-side mods";
	readonly content = { mods: false, plugins: true, datapacks: true };
	protected readonly project = "paper";
}
