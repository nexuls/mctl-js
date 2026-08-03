/**
 * Terminal-relative dimensions: a negative `width`/`height` must resolve to
 * `terminal size - n`, follow the terminal across resizes, and leave every other
 * dimension form (positive, `"auto"`, `"<n>%"`) exactly as upstream handles it.
 *
 * The tests mount real JSX through `createRoot`, because the patch's two seams
 * are the reconciler's construction path and its prop-assignment path — a unit
 * test over a fake object would exercise neither. Without the patch the first
 * test does not merely fail, it *throws* (`Invalid width for Renderable …`),
 * which is upstream's behaviour for a negative dimension.
 */

import { test, expect, beforeAll } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { BoxRenderable } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { installNegativeDimensionPatch } from "./negative-dimension-patch.ts";
import { installSelectionOptIn } from "./selection-opt-in.ts";

beforeAll(() => {
  // Installed together, in the app's order, so the test also proves the two
  // catalogue patches compose rather than replacing one another.
  installSelectionOptIn();
  installNegativeDimensionPatch();
});

/** Mount `node` at a given terminal size and hand back the renderer + helpers. */
async function mount(
  node: React.ReactNode,
  width = 40,
  height = 12,
): Promise<{
  renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"];
  /** Commit any pending React work and lay the tree out. */
  settle: () => Promise<void>;
  /** The renderable with the given id, as a box (searched depth-first). */
  box: (id: string) => BoxRenderable;

}> {
  const { renderer, renderOnce } = await createTestRenderer({ width, height });
  createRoot(renderer).render(node);

  const settle = async () => {
    renderOnce();
    // React's commit reaches the renderer a frame later; one render is a blank tree.
    await Bun.sleep(20);
    renderOnce();
  };
  await settle();

  return {
    renderer,
    settle,
    box: (id: string) =>
      renderer.root.findDescendantById(id) as unknown as BoxRenderable,
  };
}

test("a negative width/height resolves against the terminal", async () => {
  const { box } = await mount(
    <box id="probe" width={-4} height={-2} />,
    40,
    12,
  );

  expect(box("probe").width).toBe(36);
  expect(box("probe").height).toBe(10);
});

test("a negative dimension arriving as a prop update resolves too", async () => {
  function Sizing({ width }: { width: number }) {
    return <box id="probe" width={width} height={3} />;
  }

  const { box, settle, renderer } = await mount(<Sizing width={10} />, 40, 12);
  expect(box("probe").width).toBe(10);

  createRoot(renderer).render(<Sizing width={-6} />);
  await settle();

  expect(box("probe").width).toBe(34);
});

test("resolved sizes follow the terminal across a resize", async () => {
  const { box, settle, renderer } = await mount(
    <box id="probe" width={-4} height={-2} />,
    40,
    12,
  );
  expect(box("probe").width).toBe(36);

  renderer.resize(80, 24);
  await settle();
  expect(box("probe").width).toBe(76);
  expect(box("probe").height).toBe(22);

  renderer.resize(30, 8);
  await settle();
  expect(box("probe").width).toBe(26);
  expect(box("probe").height).toBe(6);
});

test("setting a non-negative dimension opts back out of tracking", async () => {
  const { box, settle, renderer } = await mount(
    <box id="probe" width={-4} height={3} />,
    40,
    12,
  );
  expect(box("probe").width).toBe(36);

  const probe = box("probe");
  probe.width = 12;
  await settle();
  expect(probe.width).toBe(12);

  // The resize sweep must no longer touch it.
  renderer.resize(80, 24);
  await settle();
  expect(probe.width).toBe(12);
});

test("positive, auto and percentage dimensions are untouched", async () => {
  const { box, settle, renderer } = await mount(
    <box id="outer" width="100%" height={6}>
      <box id="fixed" width={10} height={1} />
      <box id="pct" width="50%" height={1} />
    </box>,
    40,
    12,
  );

  expect(box("fixed").width).toBe(10);
  expect(box("pct").width).toBe(20);

  renderer.resize(80, 24);
  await settle();

  // The percentage tracks its parent (which is the full width); the fixed one
  // must not move.
  expect(box("fixed").width).toBe(10);
  expect(box("pct").width).toBe(40);
});

test("an inset at least as large as the terminal clamps instead of going negative", async () => {
  // Resolving to a negative would throw upstream's `Invalid width` on the way in.
  const { box } = await mount(<box id="probe" width={-30} height={2} />, 20, 6);

  // Yoga is given 0; a laid-out renderable reports a floor of 1 cell.
  expect(box("probe").width).toBeLessThanOrEqual(1);
  expect(box("probe").width).toBeGreaterThanOrEqual(0);
});

test("an unmounted renderable is dropped from the resize sweep", async () => {
  function Maybe({ show }: { show: boolean }) {
    return <box id="host">{show ? <box id="probe" width={-4} /> : null}</box>;
  }

  const { box, settle, renderer } = await mount(<Maybe show={true} />, 40, 12);
  const probe = box("probe");
  expect(probe.width).toBe(36);

  createRoot(renderer).render(<Maybe show={false} />);
  await settle();

  // A tracked-but-destroyed renderable would still be re-sized here (or make the
  // sweep throw); it must simply keep its last value.
  renderer.resize(80, 24);
  await settle();
  expect(probe.width).toBe(36);
});
