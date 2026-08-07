/**
 * MinecraftHead — renders a blocky Minecraft head face into an OpenTUI
 * {@link FrameBufferRenderable}, at a chosen skin.
 *
 * **Pure-UI, page-layer rules apply** (AGENTS.md § 3): this component only draws
 * to a render surface via {@link useRenderer}; it never touches the filesystem,
 * spawns processes, or calls `Bun.*` I/O.
 *
 * Rendering technique — a terminal cell is ~twice as tall as it is wide, so the
 * classic trick for square "pixels" is the upper-half-block glyph "▀": paint it
 * with fg = the top pixel's colour and bg = the bottom pixel's colour, and one
 * cell becomes two vertically-stacked pixels, each keeping its own exact colour
 * (lossless). One pixel per cell horizontally, two per cell vertically, so an
 * 8×8 face maps to an 8-wide × 4-tall cell buffer that renders as a true square.
 */

import { type BoxRenderable, FrameBufferRenderable, RGBA } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useId, useRef } from "react";

/** The available head skins. */
export type MinecraftSkin =
	| "steve"
	| "herobrine"
	| "alex"
	| "villager"
	| "creeper"
	| "zombie"
	| "cow"
	| "bee"
	| "drowned"
	| "enderman"
	| "fox"
	| "sheep";

/**
 * A skin is a colour palette keyed by single-char pixel codes plus an 8×8 face
 * grid (top row first) whose characters index that palette.
 */
interface Skin {
	palette: Record<string, string>;
	/** 8 rows of 8 chars each; every char must be a key in {@link Skin.palette}. */
	face: string[];
}

export const SKINS: Record<MinecraftSkin, Skin> = {
	steve: {
		palette: {
			A: "#2b1e0d",
			B: "#a87e66",
			C: "#9c6345",
			D: "#694030",
			E: "#c7967f",
			F: "#fffffe",
			G: "#523d88",
		},
		face: [
			"AAAAAAAA",
			"AAAAAAAA",
			"ABBEEEBA",
			"BBBBBEBB",
			"BFGBEGFB",
			"CBBDDBCD",
			"CCACCACD",
			"DDAAAACD",
		],
	},
	herobrine: {
		palette: {
			A: "#2b1e0d",
			B: "#a87e66",
			C: "#9c6345",
			D: "#694030",
			E: "#c7967f",
			F: "#fffffe",
			G: "#523d88",
		},
		face: [
			"AAAAAAAA",
			"AAAAAAAA",
			"ABBEEEBA",
			"BBBBBEBB",
			"BFFBEFFB",
			"CBBDDBCD",
			"CCACCACD",
			"DDAAAACD",
		],
	},
	alex: {
		palette: {
			A: "#f1daba",
			B: "#e59241",
			C: "#db9542",
			D: "#ecd2b4",
			E: "#e3cba8",
			F: "#e39b4d",
			G: "#266125",
			H: "#efbbb0",
			I: "#e1a158",
			J: "#e6a761",
			K: "#eddfcc",
			L: "#c8d6ca",
			M: "#f9fbfa",
		},
		face: [
			"BBBBBBBB",
			"BBBBIJBB",
			"BBBCDDFB",
			"CCCDAEEF",
			"KLGAAGME",
			"AAAAAAAA",
			"AAAHHAAD",
			"AAAAAAAA",
		],
	},
	villager: {
		palette: {
			A: "#b07764",
			B: "#8a5b41",
			C: "#b6876f",
			D: "#322212",
			E: "#f4f6f4",
			F: "#049011",
			G: "#723f35",
		},
		face: [
			"CACAAACA",
			"CAAAAACA",
			"CAAAAACA",
			"ADDDDDDA",
			"CEFAAFEC",
			"BACBBCAB",
			"BAGBBGAB",
			"BAABBAAB",
		],
	},
	creeper: {
		palette: {
			A: "#010101",
			B: "#a3cd9c",
			C: "#70dc5d",
			D: "#2e9546",
			E: "#45c538",
			F: "#a4bf9f",
			G: "#618966",
			H: "#079208",
			I: "#1bd745",
			J: "#aeaeae",
			K: "#0aba09",
			L: "#7ee08a",
		},
		face: [
			"BEBBCCBD",
			"DGHEDCHF",
			"EAABIAAJ",
			"KAADHAAC",
			"CECAAFCE",
			"BDAAAAGB",
			"FGAAAABD",
			"DBALFAEC",
		],
	},
	zombie: {
		palette: {
			A: "#446d35",
			B: "#375a24",
			C: "#6c955b",
			D: "#638550",
			E: "#4f7d3d",
			F: "#1a1a1b",
			G: "#59953d",
		},
		face: [
			"AAAABBAA",
			"AAAEGGAA",
			"ADCCCCDE",
			"DCDDECEE",
			"CFFDCFFD",
			"EDCBBCEB",
			"AAAAABAA",
			"BBBBABAB",
		],
	},
	cow: {
		palette: {
			A: "#403227",
			B: "#b5b5b5",
			C: "#000000",
			D: "#625f58",
			E: "#847f7b",
			F: "#ffffff",
			G: "#4a4a4a",
			H: "#a6a19d",
		},
		face: [
			"AAABBEEA",
			"AAABBBAA",
			"BBABBABB",
			"CFAHAAFC",
			"AAAAAAAA",
			"AABBBBAA",
			"ABCDDCBA",
			"ABDGGDBA",
		],
	},
	drowned: {
		palette: {
			A: "#56857f",
			B: "#49726c",
			C: "#91f0d8",
			D: "#2a8105",
			E: "#329402",
			F: "#4da581",
			G: "#66e0dc",
			H: "#54ba73",
			I: "#27524c",
			J: "#3a5854",
		},
		face: [
			"EDEFAABD",
			"EBDAFAHA",
			"DABAAAIB",
			"BAAAAAAA",
			"ACCAACCA",
			"AAJGGBBA",
			"AACCCCAA",
			"BABBBBAB",
		],
	},
	enderman: {
		palette: {
			A: "#000000",
			B: "#161616",
			C: "#e078f8",
			D: "#cb02fa",
		},
		face: [
			"ABAAAABA",
			"ABBAABBA",
			"BABBBBAB",
			"AABBBBAA",
			"CDCBBCDC",
			"BAABBAAB",
			"ABBAABBA",
			"AAAAAAAA",
		],
	},
	fox: {
		palette: {
			A: "#df7e1f",
			B: "#ffffff",
			C: "#e9d7d1",
			D: "#06050d",
			E: "#b38f80",
			F: "#ae5222",
			G: "#e78e43",
		},
		face: [
			"BBBBBBBB",
			"BEBBBBEB",
			"AAAAAAAA",
			"AAAAAAAA",
			"FAAAAAAF",
			"DBAGGABD",
			"AACDDCAA",
			"CCBBBBCC",
		],
	},
	sheep: {
		palette: {
			A: "#f4f4f4",
			B: "#d79e87",
			C: "#030203",
			D: "#f193b6",
			E: "#f1c6d7",
		},
		face: [
			"AAAAAAAA",
			"AAAAAAAA",
			"ABBBBBBA",
			"ACABBACA",
			"ABBBBBBA",
			"AABDDBAA",
			"AABEEBAA",
			"AAAAAAAA",
		],
	},
	bee: {
		palette: {
			A: "#edc144",
			B: "#cf8f47",
			C: "#fed767",
			D: "#2f2b35",
			E: "#dab546",
			F: "#1f1f27",
			G: "#f5cc55",
			H: "#654936",
			I: "#a4b894",
			J: "#61929c",
			K: "#af903d",
			L: "#bfa359",
			M: "#d9c15c",
			N: "#c2b561",
		},
		face: [
			"CCAGCCAC",
			"ADLGAEDC",
			"BBEAAGBB",
			"HIMAAGIH",
			"FJNAAEJF",
			"DFKAAEFD",
			"FDKAAEDF",
			"BBBBEBBB",
		],
	},
};

/** Every skin id, in a fixed order so {@link skinFor} is stable across runs. */
export const SKIN_IDS = Object.keys(SKINS) as MinecraftSkin[];

/**
 * Pick a skin from an arbitrary seed — a player's uuid or name.
 *
 * **Deterministic, not random.** The Players tab wants each player to have a
 * distinct-looking head, but a genuinely random pick would hand the same player
 * a new face on every poll (the tab re-reads every five seconds), which reads as
 * a glitch. Hashing the seed gives the same variety with none of the flicker,
 * and the same player looks the same in every MCTL instance.
 *
 * FNV-1a: one multiply and one xor per character, no dependency, and well enough
 * distributed that two adjacent names do not collide.
 */
export function skinFor(seed: string): MinecraftSkin {
	let hash = 0x811c9dc5;
	for (let i = 0; i < seed.length; i += 1) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	const index = Math.abs(hash) % SKIN_IDS.length;
	return SKIN_IDS[index] as MinecraftSkin;
}

/** Upper half block: fg fills the top pixel of the cell, bg the bottom pixel. */
const HALF_BLOCK = "▀";

// Cache RGBA objects per hex — never mint colours inside the draw loop.
const rgbaCache = new Map<string, RGBA>();
const rgba = (hex: string): RGBA => {
	let c = rgbaCache.get(hex);
	if (!c) {
		c = RGBA.fromHex(hex);
		rgbaCache.set(hex, c);
	}
	return c;
};

/** Paint an 8×8 skin face into an 8×4 cell buffer using half blocks. */
function drawHead(fb: FrameBufferRenderable["frameBuffer"], skin: Skin): void {
	for (let cy = 0; cy < 4; cy++) {
		// The two pixel rows stacked into this cell row. Faces are a fixed 8×8, so
		// both indices are always in bounds.
		const topRow = skin.face[cy * 2] as string;
		const botRow = skin.face[cy * 2 + 1] as string;
		for (let cx = 0; cx < 8; cx++) {
			const top = skin.palette[topRow[cx] as string] as string;
			const bot = skin.palette[botRow[cx] as string] as string;
			fb.setCell(cx, cy, HALF_BLOCK, rgba(top), rgba(bot));
		}
	}
}

/** Props for {@link MinecraftHead}. */
export interface MinecraftHeadProps {
	/** Which skin to draw. Defaults to `"steve"`. */
	skin?: MinecraftSkin;
}

/**
 * Renders a Minecraft head face occupying an 8×4 terminal-cell area.
 *
 * The React binding has no `<frame-buffer>` intrinsic, so the buffer is created
 * imperatively and attached via the host box's ref. React never renders children
 * into that box, so there is no reconciler conflict with the manual child. The
 * buffer is rebuilt whenever `skin` changes.
 */
export function MinecraftHead({ skin = "steve" }: MinecraftHeadProps) {
	const renderer = useRenderer();
	const hostRef = useRef<BoxRenderable | null>(null);
	// Unique per instance so multiple heads on screen don't collide on buffer id.
	const bufferId = useId();

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const canvas = new FrameBufferRenderable(renderer, {
			id: `mc-head-${bufferId}`,
			width: 8,
			height: 4,
		});
		drawHead(canvas.frameBuffer, SKINS[skin]);
		host.add(canvas);

		return () => {
			host.remove(canvas);
			canvas.destroy();
		};
	}, [renderer, skin, bufferId]);

	return <box ref={hostRef} width={8} height={4} />;
}
