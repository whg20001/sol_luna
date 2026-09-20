import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import artwork from "../src/kirby-frames.js";
import { createKirbyActivity, createKirbyWidget, renderKirbyStatus, KIRBY_FORM_COUNT, KIRBY_FRAME_MS } from "../src/kirby-widget.js";

const text = "P(25%),L(25%),V(25%),S(25%)";
const plain = (line) => line.replace(/\x1b\[[\d;]*m/gu, "");
const event = (id) => ({ id: String(id), type: "luna-worker" });

function clock() {
  let next = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    tick() {
      const [id, { callback }] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test("bundled Kirby frames correspond to all 18 forms and all 72 source frames", () => {
  assert.equal(KIRBY_FORM_COUNT, 18);
  assert.equal(KIRBY_FRAME_MS, 200);
  assert.equal(artwork.frameCount, 4);
  assert.equal(artwork.columns, 3);
  const source = readFileSync(new URL("../kirby-pixel-overview.svg", import.meta.url));
  assert.equal(artwork.sha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(new Set(artwork.sprites.map((sprite) => sprite.name)).size, 18);
  for (const sprite of artwork.sprites) {
    assert.equal(sprite.frames.length, 4);
    for (const frame of sprite.frames) {
      assert.match(plain(frame), /^[\u2800-\u28ff ]{3}$/u);
      assert.ok(frame.endsWith("\x1b[0m"));
      assert.equal(frame.replace(/\x1b\[38;2;\d{1,3};\d{1,3};\d{1,3}m|\x1b\[0m/gu, ""), plain(frame));
      for (const match of frame.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/gu)) {
        assert.ok(match.slice(1).every((channel) => Number(channel) <= 255));
      }
    }
  }
});

test("all 72 compiled thumbnails preserve the previous runtime renderer byte for byte", () => {
  const frames = Array.from({ length: 18 }, (_, id) => Array.from({ length: 4 }, (_, tick) => (
    renderKirbyStatus({ text, sprites: [id], tick, width: 80 })
  )));
  // Captured before moving the pixel sampling into the offline builder.
  assert.equal(createHash("sha256").update(JSON.stringify(frames)).digest("hex"),
    "dbd21cbd3fd576a73cd412b3d086ec77abf73ce1bbdc24786cce5a5c88c3bbba");
});

test("activity randomly chooses unused forms and keeps assignments stable until completion", () => {
  const active = createKirbyActivity({ random: () => 0.5 });
  for (let index = 0; index < 4; index++) assert.equal(active.start(event(index)), true);
  assert.equal(active.size, 4);
  const assigned = active.getSprites();
  assert.equal(new Set(assigned).size, 4);
  assert.deepEqual(assigned, [9, 8, 10, 7]);
  assert.equal(active.start(event(1)), false);
  assert.deepEqual(active.getSprites(), assigned);
  assert.equal(active.finish(event(1)), true);
  assert.equal(active.finish(event(1)), false);
  assert.deepEqual(active.getSprites(), [assigned[0], assigned[2], assigned[3]]);
  assert.equal(active.size, 3);
  assert.equal(active.start(event(1)), true); // A genuine resumed run can start again.
  active.clear();
  assert.equal(active.size, 0);
});

test("large fleets reuse forms only after exhausting the 18 choices", () => {
  const active = createKirbyActivity({ random: () => 0 });
  for (let id = 0; id < 18; id++) active.start(event(id));
  assert.equal(new Set(active.getSprites()).size, 18);
  active.start(event(18));
  assert.equal(active.size, 19);
  assert.equal(new Set(active.getSprites()).size, 18);
});

test("malformed or mismatched activity events cannot create or remove runs", () => {
  const active = createKirbyActivity();
  for (const invalid of [null, {}, { id: 2, type: "luna-worker" }, { id: "ok" }, { id: "", type: "luna-worker" }]) {
    assert.equal(active.start(invalid), false);
    assert.equal(active.finish(invalid), false);
  }
  active.start(event(1));
  assert.equal(active.finish({ id: "1", type: "validator-worker" }), false);
  assert.equal(active.size, 1);
  assert.equal(active.finish(event(1)), true); // No usage field required.
});

test("all 18 forms animate using their original four frames", () => {
  for (let id = 0; id < 18; id++) {
    const frames = Array.from({ length: 4 }, (_, tick) => renderKirbyStatus({ text, sprites: [id], tick, width: 100 }));
    assert.ok(new Set(frames.map((frame) => frame.join("\n"))).size > 1, `form ${id} must move`);
    assert.deepEqual(frames[0], renderKirbyStatus({ text, sprites: [id], tick: 4, width: 100 }));
    assert.ok(frames.every((lines) => lines.length === 1));
    assert.ok(frames[0][0].endsWith(text));
  }
});

test("four thumbnails share exactly one row with the shares at every terminal width", () => {
  for (const width of [1, 3, 4, 5, 9, 10, 15, 16, 24, 40, 41, 60, 80, 120]) {
    const lines = renderKirbyStatus({ text, sprites: [0, 1, 2, 3], width });
    assert.equal(lines.length, 1, `width ${width} must never wrap`);
    assert.equal(plain(lines[0]).length, width);
    if (width < 4) assert.equal(lines[0].trim(), "4");
    else if (width < text.length + 16) assert.match(lines[0].trimStart(), /^A\(4\)/u);
    else {
      assert.ok(lines[0].endsWith(text));
      const icons = plain(lines[0]).trimStart().slice(0, -text.length - 1).split(" ");
      assert.equal(icons.length, 4);
      assert.ok(icons.every((icon) => icon.length === 3));
      assert.equal((lines[0].match(/\x1b\[0m/gu) ?? []).length, 4);
    }
    assert.doesNotMatch(plain(lines[0]), /[\x00-\x1f]/u);
  }
  assert.deepEqual(renderKirbyStatus({ text, sprites: Array(12).fill(0), width: 1 }), ["+"]);
  assert.deepEqual(renderKirbyStatus({ text, sprites: [], width: 80 }), [text.padStart(80)]);
  for (const width of [0, -1, Infinity, NaN, 1.5]) assert.deepEqual(renderKirbyStatus({ text, sprites: [0], width }), []);
});

test("mounted widgets use one 200ms timer regardless of fleet size and stop at idle", () => {
  const scheduler = clock();
  const activity = createKirbyActivity({ random: () => 0 });
  let redraws = 0;
  const widget = createKirbyWidget({ activity, getText: () => text, requestRender: () => redraws++, ...scheduler });
  widget.update();
  assert.equal(scheduler.timers.size, 0);
  for (let id = 0; id < 4; id++) { activity.start(event(id)); widget.update(); }
  assert.equal(scheduler.timers.size, 1);
  assert.equal([...scheduler.timers.values()][0].delay, 200);
  const first = widget.render(100);
  scheduler.tick();
  assert.notDeepEqual(widget.render(100), first);
  assert.equal(scheduler.timers.size, 1);
  activity.clear();
  widget.update();
  assert.equal(scheduler.timers.size, 0);
  assert.deepEqual(widget.render(100), [text.padStart(100)]);
  assert.ok(redraws >= 6);
});

test("stale timer callbacks cannot restart disposed widgets or duplicate a newer timer", () => {
  const scheduler = clock();
  const activity = createKirbyActivity({ random: () => 0 });
  let redraws = 0;
  const widget = createKirbyWidget({ activity, getText: () => text, requestRender: () => redraws++, ...scheduler });
  activity.start(event(1)); widget.update();
  const old = [...scheduler.timers.values()][0].callback;
  activity.clear(); widget.update();
  activity.start(event(2)); widget.update();
  const count = redraws;
  old();
  assert.equal(redraws, count);
  assert.equal(scheduler.timers.size, 1);
  const pending = [...scheduler.timers.values()][0].callback;
  widget.dispose(); widget.dispose();
  pending(); widget.update();
  assert.equal(scheduler.timers.size, 0);
  assert.equal(redraws, count);
  assert.deepEqual(widget.render(100), []);
});
