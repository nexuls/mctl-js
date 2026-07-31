/**
 * Tests for the toast scheduler, driven through a real (in-memory) OpenTUI
 * renderer so the assertions cover what is actually painted, not just state.
 *
 * The behaviours worth pinning are the ones a caller relies on and cannot see
 * from the outside: a toast appears, expires on its own, honours a delay, stays
 * put when sticky, and queues beyond `maxVisible`.
 *
 * Must live inside `src/` — a test outside it resolves a different copy of
 * `@opentui/core` (see memory.md).
 */

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { useEffect } from "react";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { ThemeProvider } from "./use-theme.tsx";
import { ToastProvider, useToast, type ToastApi, type ToastProviderProps } from "./use-toast.tsx";

/** Mount a tree that hands the raising callback the toast API, and render it. */
async function mount(
	raise: (toast: ToastApi) => void,
	options?: Omit<ToastProviderProps, "children">,
) {
	const registry = await new ThemeRegistry().load();
	const harness = await createTestRenderer({ width: 60, height: 20 });

	function Trigger() {
		const toast = useToast();
		// Raise once, after mount, so the first frame is the "no toasts" state.
		// (Braces matter: an arrow returning the toast id would be read as a
		// cleanup function.)
		useEffect(() => {
			raise(toast);
		}, []);
		return <box flexGrow={1} />;
	}

	createRoot(harness.renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<ToastProvider {...options}>
				<Trigger />
			</ToastProvider>
		</ThemeProvider>,
	);
	await harness.renderOnce();
	return harness;
}

/** Render repeatedly for `ms`, so timers fire and their effects reach a frame. */
async function advance(harness: { renderOnce: () => Promise<unknown> }, ms: number) {
	const until = Date.now() + ms;
	do {
		await Bun.sleep(20);
		await harness.renderOnce();
	} while (Date.now() < until);
	await harness.renderOnce();
}

describe("ToastProvider", () => {
	test("shows a toast and clears it when its time to live elapses", async () => {
		const harness = await mount((toast) =>
			toast.success("Settings saved", { duration: 300 }),
		);

		await advance(harness, 60);
		expect(harness.captureCharFrame()).toContain("Settings saved");

		await advance(harness, 400);
		expect(harness.captureCharFrame()).not.toContain("Settings saved");

		harness.renderer.destroy();
	});

	test("holds a sticky toast until it is dismissed", async () => {
		let id = "";
		let api: ToastApi | undefined;
		const harness = await mount((toast) => {
			api = toast;
			id = toast.error("Start failed", { duration: 0 });
		});

		await advance(harness, 400);
		expect(harness.captureCharFrame()).toContain("Start failed");

		api?.dismiss(id);
		await advance(harness, 60);
		expect(harness.captureCharFrame()).not.toContain("Start failed");

		harness.renderer.destroy();
	});

	test("withholds a delayed toast until its delay elapses", async () => {
		const harness = await mount((toast) =>
			toast.info("Still installing", { delay: 300, duration: 0 }),
		);

		await advance(harness, 60);
		expect(harness.captureCharFrame()).not.toContain("Still installing");

		await advance(harness, 400);
		expect(harness.captureCharFrame()).toContain("Still installing");

		harness.renderer.destroy();
	});

	test("queues beyond maxVisible, then shows the queued toast", async () => {
		const harness = await mount(
			(toast) => {
				toast.info("first alpha", { duration: 250 });
				toast.info("second beta", { duration: 0 });
			},
			{ maxVisible: 1 },
		);

		await advance(harness, 60);
		let frame = harness.captureCharFrame();
		expect(frame).toContain("first alpha");
		expect(frame).not.toContain("second beta");

		// The queued toast's own countdown starts only once it is on screen, which
		// is why it can be asserted after the first one expires.
		await advance(harness, 350);
		frame = harness.captureCharFrame();
		expect(frame).not.toContain("first alpha");
		expect(frame).toContain("second beta");

		harness.renderer.destroy();
	});

	test("an action's key runs it and closes the toast", async () => {
		let ran = 0;
		const reasons: string[] = [];
		const harness = await mount((toast) =>
			toast.error("Start failed", {
				duration: 0,
				position: "top-center",
				action: { label: "Retry", key: "r", onAction: () => ran++ },
				onDismiss: (reason) => reasons.push(reason),
			}),
		);

		await advance(harness, 60);
		expect(harness.captureCharFrame()).toContain("Retry");

		harness.mockInput.pressKey("r");
		await advance(harness, 60);
		expect(ran).toBe(1);
		expect(reasons).toEqual(["action"]);
		expect(harness.captureCharFrame()).not.toContain("Start failed");

		harness.renderer.destroy();
	});

	test("renders the description and reports the dismissal reason", async () => {
		const reasons: string[] = [];
		const harness = await mount((toast) =>
			toast.warning("Disk almost full", {
				description: "only 2 GB left",
				duration: 200,
				onDismiss: (reason) => reasons.push(reason),
			}),
		);

		await advance(harness, 60);
		expect(harness.captureCharFrame()).toContain("only 2 GB left");

		await advance(harness, 300);
		expect(reasons).toEqual(["timeout"]);

		harness.renderer.destroy();
	});
});
