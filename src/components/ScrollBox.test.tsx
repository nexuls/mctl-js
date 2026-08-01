/**
 * ScrollBox — the wrapper must stay a faithful pass-through, so these tests
 * assert against the real `ScrollBoxRenderable` the reconciler builds: props and
 * `ref` reach it, and `enableAccel` is the only thing that changes.
 */

import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  LinearScrollAccel,
  MacOSScrollAccel,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createRef } from "react";
import { ScrollBox } from "./ScrollBox.tsx";

/** Mount `node`, let React commit, and hand back the renderer's tree. */
async function mount(node: React.ReactNode) {
  const { renderer, renderOnce } = await createTestRenderer({
    width: 40,
    height: 10,
  });
  createRoot(renderer).render(node);
  renderOnce();
  // React's commit reaches the renderer a frame later; one render is a blank tree.
  await Bun.sleep(50);
  renderOnce();
  return renderer;
}

test("forwards props, children and ref to the underlying scrollbox", async () => {
  const ref = createRef<ScrollBoxRenderable>();
  const renderer = await mount(
    <ScrollBox id="probe" ref={ref} scrollX={true} scrollY={false} height={4}>
      <text>hello</text>
    </ScrollBox>,
  );

  const box = renderer.root.getRenderable("probe") as ScrollBoxRenderable;
  expect(box).toBeDefined();
  expect(ref.current).toBe(box);
  expect(box.height).toBe(4);
  // `scrollX`/`scrollY` are stored on the renderable but not on its public type.
  const axes = box as unknown as { scrollX: boolean; scrollY: boolean };
  expect(axes.scrollX).toBe(true);
  expect(axes.scrollY).toBe(false);
  expect(box.content.getChildren().length).toBe(1);
});

test("scrolling is linear by default and accelerated with enableAccel", async () => {
  const plain = await mount(<ScrollBox id="probe" />);
  expect(
    (plain.root.getRenderable("probe") as ScrollBoxRenderable)
      .scrollAcceleration,
  ).toBeInstanceOf(LinearScrollAccel);

  const fast = await mount(<ScrollBox id="probe" enableAccel />);
  expect(
    (fast.root.getRenderable("probe") as ScrollBoxRenderable)
      .scrollAcceleration,
  ).toBeInstanceOf(MacOSScrollAccel);
});

test("a fast wheel burst travels further with enableAccel than without", async () => {
  async function burst(enableAccel: boolean) {
    const renderer = await mount(
      <ScrollBox id="probe" enableAccel={enableAccel} height={8}>
        {Array.from({ length: 400 }, (_, i) => (
          <text key={i}>line {i}</text>
        ))}
      </ScrollBox>,
    );
    const box = renderer.root.getRenderable("probe") as ScrollBoxRenderable;
    for (let i = 0; i < 30; i++) {
      // `onMouseEvent` is protected — a synthetic wheel event is the only way to
      // exercise the acceleration without a real terminal.
      (box as unknown as { onMouseEvent(e: unknown): void }).onMouseEvent({
        type: "scroll",
        scroll: { direction: "down", delta: 1 },
        modifiers: {},
      });
      // Tight enough to stay inside MacOSScrollAccel's 150 ms streak window.
      await Bun.sleep(10);
    }
    return box.scrollTop;
  }

  const linear = await burst(false);
  const accelerated = await burst(true);
  expect(linear).toBe(30);
  expect(accelerated).toBeGreaterThan(linear);
});
