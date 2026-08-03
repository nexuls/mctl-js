/**
 * Work-around for an upstream OpenTUI bug: box borders are not clipped by
 * ancestor scissor rects.
 *
 * `BoxRenderable.renderSelf` draws through the native `bufferDrawBox`, and that
 * call — unlike every other native draw path (`drawText`, `drawTextBuffer`,
 * `fillRect`, `drawFrameBuffer`) — ignores the buffer's scissor-rect stack. The
 * visible symptom: put a bordered `<box>` inside a `<scrollbox>` and scroll; the
 * box's text is clipped to the viewport correctly but its border glyphs keep
 * drawing, painting over whatever surrounds the scrollbox (top bar, nav rail,
 * hint strip). Reproduced against `@opentui/core` 0.4.5 (latest at the time of
 * writing) with a plain `<box overflow="hidden">` too — it is not scrollbox
 * specific.
 *
 * The fix keeps native rendering — no glyph/title/border-style logic is
 * reimplemented here, so partial border sides, alignments and focus colours stay
 * exactly as upstream draws them. When a box is only partially inside its
 * ancestors' clip, we let the *original* `renderSelf` draw into a scratch buffer
 * at the origin, then blit that buffer with `drawFrameBuffer`, which *does*
 * honour the scissor stack. Fully-visible boxes (the overwhelming majority) take
 * the untouched native fast path, so this costs nothing until a box straddles a
 * clip edge.
 *
 * Install once, before the first render — `renderApp()` does this. Remove the
 * whole module when upstream clips `bufferDrawBox`; the call site is the only
 * other thing to delete.
 *
 * UI-layer module: no I/O, no domain knowledge.
 */

import {
	BoxRenderable,
	OptimizedBuffer,
	RGBA,
	type Renderable,
} from "@opentui/core";

/** Rect in screen cells. */
interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * One process-wide scratch buffer, resized to whichever box currently needs it.
 * Safe to share: renderables are drawn sequentially within a single render pass,
 * and the buffer's contents are consumed by the `drawFrameBuffer` call that
 * immediately follows the draw into it.
 */
let scratch: OptimizedBuffer | null = null;
let patched = false;

/** Fully transparent — cells the box does not paint must not overwrite the destination. */
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0);

function ensureScratch(
	widthMethod: "wcwidth" | "unicode",
	width: number,
	height: number,
): OptimizedBuffer {
	if (!scratch) {
		scratch = OptimizedBuffer.create(width, height, widthMethod, {
			respectAlpha: true,
		});
	} else {
		// No-op inside OptimizedBuffer when the dimensions already match.
		scratch.resize(width, height);
	}
	scratch.clear(TRANSPARENT);
	return scratch;
}

/**
 * Intersection of every clipping ancestor's scissor rect, or `null` when nothing
 * above this renderable clips (the fast path).
 *
 * Mirrors what `Renderable.updateLayout` pushes onto the native scissor stack:
 * an ancestor contributes a rect only when its `overflow` is not `"visible"`.
 * A `buffered` ancestor is treated as a stop — its scissor rect is expressed in
 * frame-buffer-local coordinates, which we cannot compare against screen
 * coordinates, so we bail to the native path rather than clip against the wrong
 * origin.
 */
function ancestorClip(node: Renderable): Rect | null {
	let clip: Rect | null = null;
	// Casts throughout: `parent`, `overflow` and `getScissorRect` are protected
	// on Renderable, but this module is deliberately reaching into internals.
	let current = (node as unknown as { parent: Renderable | null }).parent;

	while (current) {
		const internals = current as unknown as {
			buffered: boolean;
			overflow: string;
			getScissorRect(): Rect;
			parent: Renderable | null;
		};
		if (internals.buffered) return clip;

		if (
			internals.overflow !== "visible" &&
			current.width > 0 &&
			current.height > 0
		) {
			const rect = internals.getScissorRect();
			clip = clip ? intersect(clip, rect) : rect;
			if (clip.width <= 0 || clip.height <= 0) return clip;
		}
		current = internals.parent;
	}
	return clip;
}

function intersect(a: Rect, b: Rect): Rect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	return {
		x,
		y,
		width: Math.min(a.x + a.width, b.x + b.width) - x,
		height: Math.min(a.y + a.height, b.y + b.height) - y,
	};
}

function contains(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

function overlaps(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

/**
 * Monkey-patch `BoxRenderable.prototype.renderSelf` so box borders respect
 * ancestor clipping. Idempotent; call once before the first render.
 *
 * Subclasses that override `renderSelf` and call `super.renderSelf(buffer)`
 * (inputs, scrollbox internals, …) go through the patch too, since the patch
 * lives on the prototype they delegate to.
 *
 * Caveat: the scratch draw does not see the destination buffer's opacity stack,
 * so a partially-clipped box nested under an `opacity < 1` ancestor renders at
 * full opacity. Nothing in MCTL does that today (the only opacity user is the
 * Dialog backdrop, which is unclipped).
 */
export function installBoxClipPatch(): void {
	if (patched) return;
	patched = true;

	type BoxInternals = {
		_screenX: number;
		_screenY: number;
		_ctx: { widthMethod: "wcwidth" | "unicode" };
		width: number;
		height: number;
	};
	const prototype = BoxRenderable.prototype as unknown as {
		renderSelf(buffer: OptimizedBuffer, deltaTime: number): void;
	};
	const original = prototype.renderSelf;

	prototype.renderSelf = function patchedRenderSelf(
		this: BoxRenderable & BoxInternals,
		buffer: OptimizedBuffer,
		deltaTime: number,
	): void {
		const width = this.width;
		const height = this.height;
		if (width <= 0 || height <= 0) return;

		const clip = ancestorClip(this);
		if (!clip) {
			original.call(this, buffer, deltaTime);
			return;
		}

		const screenX = this._screenX;
		const screenY = this._screenY;
		const bounds: Rect = { x: screenX, y: screenY, width, height };

		// Fully visible: nothing to clip, keep the native single-call fast path.
		if (contains(clip, bounds)) {
			original.call(this, buffer, deltaTime);
			return;
		}
		// Fully clipped: the blit would draw nothing, so skip the work entirely.
		if (!overlaps(clip, bounds)) return;

		// Straddling a clip edge — draw at the origin of a scratch buffer and blit.
		const target = ensureScratch(this._ctx.widthMethod, width, height);
		this._screenX = 0;
		this._screenY = 0;
		try {
			original.call(this, target, deltaTime);
		} finally {
			this._screenX = screenX;
			this._screenY = screenY;
		}
		buffer.drawFrameBuffer(screenX, screenY, target, 0, 0, width, height);
	};
}
