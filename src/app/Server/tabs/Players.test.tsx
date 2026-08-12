/**
 * PlayerCard — the promises the card's layout makes.
 *
 * The card is pure presentation over an already-tested read path
 * (`core/server/players.ts`), so what is worth pinning is the *shape*: a card is
 * six interior rows whatever the player's data looks like (a ragged row of cards
 * reads as a broken grid), the meters draw ten icons whose filled count agrees
 * with the percentage beside them, and the wireframe's fields are actually on
 * screen. All of those are claims about a rendered frame, which is why these
 * mount the component instead of asserting on props.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { iconsFor, resolveIconSet } from "../../../core/icons/index.ts";
import { ThemeRegistry } from "../../../core/theme/registry.ts";
import type { PlayerProfile } from "../../../core/server/players.ts";
import { ThemeProvider } from "../../../hooks/use-theme.tsx";
import { PlayerCard } from "./Players.tsx";

/**
 * The glyphs the card will actually draw. Resolved the same way `useIcons` does
 * without a provider — a developer running the suite in a Nerd Font terminal
 * gets the PUA hearts, one in a plain one gets `♥`, and hardcoding either would
 * make this suite pass or fail on the *runner's* terminal rather than on the
 * component.
 */
const icons = iconsFor(resolveIconSet("auto", process.env));

/** The meter's glyph run for `filled` of ten icons. */
function meter(filled: number, full: string, empty: string): string {
	return full.repeat(filled) + empty.repeat(10 - filled);
}

/** A fully-populated player — the wireframe's `BeardStone`, minus the clock. */
function player(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
	return {
		key: "beard",
		name: "BeardStone",
		uuid: "11111111-2222-3333-4444-555555555555",
		online: false,
		whitelisted: false,
		op: { level: 4, bypassesPlayerLimit: false },
		lastSeen: Date.now() - 2 * 24 * 3600_000,
		stats: { playTimeMs: 6 * 60_000, playerKills: 1, deaths: 1 },
		state: {
			health: 10,
			maxHealth: 20,
			food: 14,
			xpLevel: 3,
			gameMode: "survival",
			dimension: "minecraft:overworld",
			position: { x: -2, y: 56, z: 105 },
		},
		...overrides,
	};
}

/**
 * Mount one card and return its frame as lines.
 *
 * The heads render into a frame buffer of half blocks, so the terminal is sized
 * generously and the caller reads the card's own rows out of the top of it.
 */
async function render(
	profile: PlayerProfile,
	kind: "online" | "offline" | "banned",
	options: { showHead?: boolean; width?: number } = {},
): Promise<string[]> {
	const registry = new ThemeRegistry();
	await registry.load();
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 60,
		height: 12,
	});
	createRoot(renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<PlayerCard
				player={profile}
				kind={kind}
				selected={false}
				showHead={options.showHead ?? true}
				head={undefined}
				width={options.width ?? 50}
				onSelect={() => {}}
				onActivate={() => {}}
			/>
		</ThemeProvider>,
	);
	renderOnce();
	// React's commit reaches the renderer a frame later; one render is a blank tree.
	await Bun.sleep(80);
	renderOnce();
	return captureCharFrame()
		.split("\n")
		.map((line) => line.trimEnd());
}

/** The rows of the card itself: its two borders and the six between them. */
function cardRows(frame: string[]): string[] {
	const top = frame.findIndex((line) => line.includes("╭"));
	const bottom = frame.findIndex((line) => line.includes("╰"));
	return frame.slice(top, bottom + 1);
}

test("a full player draws the wireframe's fields", async () => {
	const frame = await render(player(), "offline");
	const card = cardRows(frame).join("\n");

	expect(card).toContain("BeardStone");
	expect(card).toContain("Last Online: 2d ago");
	expect(card).toContain("6m Played");
	expect(card).toContain("Last Position: Overworld(-2, 56, 105)");
	expect(card).toContain("Survival 1 Kill 1 Death");
	expect(card).toContain("Health:");
	expect(card).toContain("Food:");
	// Standing rides the top border, right-aligned, and the game mode does not —
	// it moved into the body when the card was redesigned.
	expect(cardRows(frame)[0]).toContain("OP");
});

test("counts are singular at one and plural elsewhere", async () => {
	const card = (
		await render(
			player({ stats: { playTimeMs: 1000, playerKills: 2, deaths: 0 } }),
			"offline",
		)
	)
		.join("\n")
		.replace(/\s+/g, " ");
	expect(card).toContain("2 Kills 0 Deaths");
});

test("the meters draw ten icons and a percentage that agrees with them", async () => {
	const card = cardRows(await render(player(), "offline"));
	const health = card.find((line) => line.includes("Health:")) ?? "";
	const food = card.find((line) => line.includes("Food:")) ?? "";

	// 10/20 health ⇒ five hearts of ten; 14/20 food ⇒ seven of ten.
	expect(health).toContain(meter(5, icons.heartFull, icons.heartEmpty));
	expect(health).toContain("50%");
	expect(food).toContain(meter(7, icons.foodFull, icons.foodEmpty));
	expect(food).toContain("70%");
});

test("a nearly-dead player keeps a heart, and a nearly-full one loses one", async () => {
	const dying = cardRows(
		await render(player({ state: { health: 1, food: 19 } }), "offline"),
	);
	const health = dying.find((line) => line.includes("Health:")) ?? "";
	const food = dying.find((line) => line.includes("Food:")) ?? "";

	// Rounding alone would empty the first meter and fill the second, which is
	// exactly the pair of misreadings the bias exists to prevent.
	expect(health).toContain(meter(1, icons.heartFull, icons.heartEmpty));
	expect(food).toContain(meter(9, icons.foodFull, icons.foodEmpty));
});

test("a card is six interior rows with data, without data, and without a head", async () => {
	const full = cardRows(await render(player(), "offline"));
	const bare = cardRows(
		await render(
			{ key: "n", name: "Noob", online: true, whitelisted: false },
			"online",
		),
	);
	const headless = cardRows(
		await render(player(), "offline", { showHead: false, width: 34 }),
	);

	expect(full).toHaveLength(8);
	expect(bare).toHaveLength(8);
	expect(headless).toHaveLength(8);
	// The player with nothing on disk says so rather than drawing empty meters,
	// which would read as a player on 0 health.
	expect(bare.join("\n")).toContain("No player data written yet");
	expect(bare.join("\n")).not.toContain("Health:");
});

test("a banned player's card carries the ban, not the meters' story", async () => {
	const card = cardRows(
		await render(
			player({
				ban: {
					source: "Server",
					created: "2026-08-01",
					expires: "forever",
					reason: "griefing",
				},
			}),
			"banned",
		),
	).join("\n");

	expect(card).toContain("Banned by Server");
	expect(card).toContain("griefing");
	expect(card).toContain("Expires: forever");
	// The body state is still real, so the meters stay — a ban does not delete
	// the player's data file.
	expect(card).toContain("Health:");
});
