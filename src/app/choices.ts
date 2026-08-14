/**
 * The server kinds and runtimes the *defaults* pickers offer, with the one-line
 * descriptions shown beside them.
 *
 * Pure UI data — no I/O, no provider imports (AGENTS.md § 3). It exists because
 * the wizard's Defaults step and the Settings page ask the same question and had
 * drifted into two hand-maintained copies of the answer, both of which still
 * listed Vanilla alone long after other providers had landed.
 *
 * **Why this is not read from the `ProviderRegistry`**, which is where the
 * authoritative list lives and where `app/ServerCreate` correctly gets it: these
 * two screens pick a **`ServerKind`** — a value written into `config.json` and
 * validated by its schema — and the setup wizard runs before there is a config
 * or a context to hold a registry. Typing the tables as
 * `Record<ServerKind, …>` keeps them honest instead: adding a kind to the enum
 * without describing it here is a compile error, not a picker quietly missing an
 * entry.
 */

import type { SelectItem } from "../components/index.ts";
import { RuntimeKind, ServerKind } from "../types/config.ts";

/**
 * Display name and one-line description for each server kind.
 *
 * The authoritative description of a kind is `ServerProvider.description`, which
 * is what the create form renders. These are the same facts written for a screen
 * that cannot reach a registry; keep them in step, and prefer the provider's
 * wording when they disagree.
 */
const KIND_INFO: Record<ServerKind, { label: string; description: string }> = {
	vanilla: { label: "Vanilla", description: "Mojang's official server" },
	paper: { label: "Paper", description: "fast Bukkit fork; plugins" },
	purpur: { label: "Purpur", description: "Paper fork; more gameplay tuning" },
	fabric: { label: "Fabric", description: "lightweight mod loader" },
	quilt: { label: "Quilt", description: "Fabric fork; mod loader" },
	forge: { label: "Forge", description: "the long-standing mod loader" },
	neoforge: { label: "NeoForge", description: "community fork of Forge" },
	velocity: { label: "Velocity", description: "proxy, not a server" },
};

/** Server kinds a default may be set to, in the enum's declared order. */
export const KIND_ITEMS: SelectItem<ServerKind>[] = ServerKind.options.map(
	(value) => ({ value, ...KIND_INFO[value] }),
);

/** How each runtime relates to the MCTL process's lifetime. */
const RUNTIME_INFO: Record<RuntimeKind, string> = {
	foreground: "tied to MCTL; ends when you quit",
	tmux: "detached; survives quitting, re-attachable",
	docker: "containerised (Phase 5)",
};

/** Runtimes a default may be set to, with their trade-off stated. */
export const RUNTIME_ITEMS = RuntimeKind.options.map((value) => ({
	value,
	label: value,
	description: RUNTIME_INFO[value],
}));
