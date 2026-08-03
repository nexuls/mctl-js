/**
 * Gives every element **terminal-relative dimensions**: a negative `width` or
 * `height` means "the terminal's size *minus* that many cells".
 *
 * ```tsx
 * <box width={-4} />           // terminal width - 4
 * <scrollbox height={-2} />    // terminal height - 2
 * ```
 *
 * OpenTUI has no such notion. `width`/`height` accept `number | "auto" |
 * "<n>%"`, and a percentage resolves against the *parent*, not the screen — so
 * "full width less a fixed gutter" otherwise has to be counted out by hand from
 * `useTerminalDimensions()` at every call site (`NavRail` and `Tabs` both do
 * exactly that for their rule rows). A negative number had no meaning before:
 * upstream's `validateOptions` throws `Invalid width for Renderable <id>: -4`
 * on it.
 *
 * Two seams are needed, because the two ways a dimension reaches a renderable
 * do not share a code path:
 *
 * 1. **Construction** — `Renderable`'s constructor validates and consumes
 *    `options.width` itself; the `width` setter is never involved, and the
 *    validation throws before any prototype method we could wrap runs. So the
 *    options are rewritten *before* `super()`, by re-registering the React
 *    component catalogue as thin subclasses. This is the same seam
 *    `selection-opt-in.ts` uses, and for the same reason: the constructor is
 *    the only place to get in front of it.
 * 2. **Updates** — React's reconciler applies changed props as plain
 *    assignments (`instance.width = value`), so the `width`/`height` accessors
 *    on `Renderable.prototype` are wrapped too. (That path does *not* validate,
 *    so a negative silently reached yoga as undefined behaviour.)
 *
 * A renderable using a negative dimension is remembered along with the raw
 * negative value and **re-resolved on every terminal resize**, which is the
 * whole point — a size baked in at construction would be stale after the first
 * SIGWINCH. Entries drop out when the renderable is destroyed or its dimension
 * is set to something non-negative.
 *
 * Install once, before the first render — `renderApp()` does this. Because the
 * construction seam is the catalogue, this covers **JSX elements**; a renderable
 * built by hand (`new BoxRenderable(...)`) is not affected on construction, only
 * on assignment.
 *
 * UI-layer module: no I/O, no domain knowledge.
 */

import type { RenderContext, Renderable } from "@opentui/core";
import { Renderable as RenderableClass } from "@opentui/core";
import {
	extend,
	getComponentCatalogue,
	type RenderableConstructor,
} from "@opentui/react";

/** The two axes this patch understands. */
type Axis = "width" | "height";

/** The raw negative values a renderable was given, per axis. */
type NegativeSpec = Partial<Record<Axis, number>>;

/** Just the constructor options this patch reads or rewrites. */
interface DimensionOptions {
	width?: unknown;
	height?: unknown;
}

/**
 * A catalogue entry seen structurally. `RenderableConstructor` resolves to the
 * *abstract* `BaseRenderable`, which TypeScript refuses to subclass in a class
 * expression, so the base is narrowed to just what this wrapper touches.
 */
type DimensionConstructor = new (
	ctx: RenderContext,
	options: DimensionOptions,
) => Renderable;

/**
 * Live renderables using at least one negative dimension, with the raw values
 * they were given. Re-resolved on terminal resize. A plain `Map` rather than a
 * `WeakMap` because it must be *iterated*; entries are removed on the
 * renderable's `destroyed` event, so it does not leak.
 */
const specs = new Map<Renderable, NegativeSpec>();

/** Contexts whose `resize` event is already wired to {@link reapplyAll}. */
const wiredContexts = new WeakSet<RenderContext>();

/** Original accessors, kept so the resize sweep does not re-enter the patch. */
let originalWidthSet: (this: Renderable, value: unknown) => void;
let originalHeightSet: (this: Renderable, value: unknown) => void;

let patched = false;

/** A dimension is terminal-relative when it is a finite negative number. */
function isNegativeDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value < 0;
}

/**
 * Resolve a negative dimension against the live terminal size. Clamped at 0 —
 * a terminal smaller than the requested inset yields an empty element rather
 * than a negative one, which upstream rejects.
 */
function resolve(ctx: RenderContext, axis: Axis, raw: number): number {
	const terminal = axis === "width" ? ctx.width : ctx.height;
	return Math.max(0, terminal + raw);
}

/**
 * Record (or forget) a renderable's raw negative value for one axis. Passing
 * `undefined` clears the axis — a caller that sets a real width has opted back
 * out of terminal-relative sizing.
 */
function track(r: Renderable, axis: Axis, raw: number | undefined): void {
	const existing = specs.get(r);

	if (raw === undefined) {
		if (!existing) return;
		delete existing[axis];
		if (existing.width === undefined && existing.height === undefined) {
			specs.delete(r);
		}
		return;
	}

	if (existing) {
		existing[axis] = raw;
		return;
	}

	specs.set(r, { [axis]: raw });
	// `Renderable.destroy()` emits this; without it the map would keep the whole
	// subtree of every unmounted page alive.
	r.once("destroyed", () => specs.delete(r));
	wireResize(r.ctx);
}

/**
 * Subscribe a context's terminal-resize event once. The renderer updates its own
 * `width`/`height` *before* emitting, so `ctx` is already current in the sweep.
 */
function wireResize(ctx: RenderContext): void {
	if (wiredContexts.has(ctx)) return;
	wiredContexts.add(ctx);
	ctx.on("resize", reapplyAll);
}

/** Push freshly resolved sizes into every tracked renderable. */
function reapplyAll(): void {
	for (const [r, spec] of specs) {
		if (spec.width !== undefined) {
			originalWidthSet.call(r, resolve(r.ctx, "width", spec.width));
		}
		if (spec.height !== undefined) {
			originalHeightSet.call(r, resolve(r.ctx, "height", spec.height));
		}
	}
}

/**
 * Replace negative `width`/`height` in a fresh renderable's options with sizes
 * resolved against `ctx`. Returns the original object when there is nothing to
 * do, and a copy otherwise — the reconciler keeps the props object it hands us
 * for the next diff, so it must not be mutated.
 */
function resolveOptions<T extends DimensionOptions>(
	ctx: RenderContext,
	options: T,
): T {
	const negWidth = isNegativeDimension(options?.width)
		? options.width
		: undefined;
	const negHeight = isNegativeDimension(options?.height)
		? options.height
		: undefined;

	if (negWidth === undefined && negHeight === undefined) return options;

	const resolved = { ...options };
	if (negWidth !== undefined) resolved.width = resolve(ctx, "width", negWidth);
	if (negHeight !== undefined) {
		resolved.height = resolve(ctx, "height", negHeight);
	}
	return resolved;
}

/**
 * Wrap the accessors so an assignment (`instance.width = -4`) is resolved and
 * tracked the same way a construction-time prop is.
 */
function patchAccessors(): void {
	const proto = RenderableClass.prototype;

	for (const axis of ["width", "height"] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(proto, axis);
		const originalSet = descriptor?.set;
		if (!descriptor || !originalSet) {
			throw new Error(
				`installNegativeDimensionPatch: Renderable.prototype.${axis} has no setter — @opentui/core changed shape`,
			);
		}

		if (axis === "width") originalWidthSet = originalSet;
		else originalHeightSet = originalSet;

		Object.defineProperty(proto, axis, {
			...descriptor,
			set(this: Renderable, value: unknown) {
				if (isNegativeDimension(value)) {
					track(this, axis, value);
					originalSet.call(this, resolve(this.ctx, axis, value));
					return;
				}
				track(this, axis, undefined);
				originalSet.call(this, value);
			},
		});
	}
}

/**
 * Re-register the component catalogue so a negative `width`/`height` prop is
 * resolved before upstream's constructor validates it.
 *
 * Wraps whatever is **currently registered** rather than the pristine
 * `baseComponents`, so this composes with `installSelectionOptIn()` in either
 * order instead of one silently replacing the other.
 */
function patchCatalogue(): void {
	const wrapped: Record<string, RenderableConstructor> = {};

	for (const [name, Base] of Object.entries(getComponentCatalogue()) as [
		string,
		DimensionConstructor,
	][]) {
		wrapped[name] = class extends Base {
			constructor(ctx: RenderContext, options: DimensionOptions) {
				super(ctx, resolveOptions(ctx, options));

				// Remember the raw request so resizes can re-resolve it. Done after
				// `super()` because `this` is what gets tracked.
				if (isNegativeDimension(options?.width)) {
					track(this, "width", options.width);
				}
				if (isNegativeDimension(options?.height)) {
					track(this, "height", options.height);
				}
			}
		} as unknown as RenderableConstructor;
	}

	extend(wrapped);
}

/**
 * Teach the TUI that a negative `width`/`height` means `terminal size - n`.
 * Call once, before the first render; a second call is a no-op.
 */
export function installNegativeDimensionPatch(): void {
	if (patched) return;
	patched = true;

	patchAccessors();
	patchCatalogue();
}
