/**
 * MinecraftHead — the head must paint the exact colours it was handed, whether
 * they came from a built-in face or from a player's real skin.
 *
 * These assert against real rendered spans rather than against the component's
 * props: the half-block trick means every visible colour is an SGR attribute,
 * so "did the right pixel end up on screen" cannot be answered any other way.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { HeadSkin } from "../types/skin.ts";
import { faceSignature, MinecraftHead, SKINS } from "./MinecraftHead.tsx";

/** Mount `node` and return the rendered spans as one searchable string. */
async function render(node: React.ReactNode): Promise<string> {
	const { renderer, renderOnce, captureSpans } = await createTestRenderer({
		width: 12,
		height: 6,
	});
	createRoot(renderer).render(node);
	renderOnce();
	// React's commit reaches the renderer a frame later; one render is a blank tree.
	await Bun.sleep(50);
	renderOnce();
	return JSON.stringify(captureSpans());
}

/**
 * `#rrggbb` as it appears inside a captured span. Colours are serialized as the
 * renderable's RGBA buffer (`{"0":r,"1":g,"2":b,"3":a}`), so the assertion has
 * to match that shape rather than a hex string.
 */
function triple(hex: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	const r = (value >> 16) & 0xff;
	const g = (value >> 8) & 0xff;
	const b = value & 0xff;
	return `"0":${r},"1":${g},"2":${b},"3":255`;
}

/** A face of one flat colour, so the assertion is about plumbing, not pixels. */
function flatFace(colour: string): HeadSkin {
	return { palette: { A: colour }, face: Array(8).fill("AAAAAAAA") };
}

test("draws four cell rows of half blocks", async () => {
	const spans = await render(<MinecraftHead skin="steve" />);
	// 8 pixels wide, 2 pixel rows per cell ⇒ 8×4 cells of "▀".
	expect(spans).toContain("▀");
	expect(spans.split("▀").length - 1).toBeGreaterThanOrEqual(4);
});

test("paints a built-in skin's own palette", async () => {
	const spans = await render(<MinecraftHead skin="creeper" />);
	// The creeper's mouth black is the one colour no other built-in shares as its
	// dominant tone, so its presence proves the named skin was the one drawn.
	expect(spans).toContain(triple(SKINS.creeper.palette.A as string));
});

test("paints a fetched HeadSkin, not a built-in", async () => {
	// A colour that appears in no built-in face, so a fallback would be visible.
	const spans = await render(<MinecraftHead skin={flatFace("#123456")} />);
	expect(spans).toContain(triple("#123456"));
});

test("repaints when the face changes", async () => {
	// The frame buffer is built imperatively in an effect; a stale dependency
	// would leave the first face on screen forever.
	const { renderer, renderOnce, captureSpans } = await createTestRenderer({
		width: 12,
		height: 6,
	});
	const root = createRoot(renderer);
	root.render(<MinecraftHead skin={flatFace("#010203")} />);
	renderOnce();
	await Bun.sleep(50);
	renderOnce();
	expect(JSON.stringify(captureSpans())).toContain(triple("#010203"));

	root.render(<MinecraftHead skin={flatFace("#0a0b0c")} />);
	renderOnce();
	await Bun.sleep(50);
	renderOnce();
	const after = JSON.stringify(captureSpans());
	expect(after).toContain(triple("#0a0b0c"));
	expect(after).not.toContain(triple("#010203"));
});

test("faceSignature keys the draw effect on content, not identity", () => {
	// The roster hands back a fresh face object on every poll; without this, every
	// head on screen would rebuild its frame buffer several times a minute.
	expect(faceSignature(flatFace("#445566"))).toBe(
		faceSignature(flatFace("#445566")),
	);
	expect(faceSignature(flatFace("#445566"))).not.toBe(
		faceSignature(flatFace("#445567")),
	);
	// Palette code order is an artefact of extraction order, not of the picture.
	expect(
		faceSignature({
			palette: { A: "#000000", B: "#ffffff" },
			face: Array(8).fill("ABABABAB"),
		}),
	).toBe(
		faceSignature({
			palette: { B: "#ffffff", A: "#000000" },
			face: Array(8).fill("ABABABAB"),
		}),
	);
	// A built-in id can never collide with a fetched face's signature.
	expect(faceSignature("steve")).toBe("builtin:steve");
});
