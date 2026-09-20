import artwork from "./kirby-frames.js";

export const KIRBY_FRAME_MS = artwork.frameMs;
export const KIRBY_FORM_COUNT = artwork.sprites.length;
const ICON_COLUMNS = artwork.columns;

// Activity is ephemeral, not token accounting or authorization. In particular,
// a zero-token failure still removes a worker, and hiding the UI does not end it.
export function createKirbyActivity({ random = Math.random } = {}) {
  const active = new Map();
  return {
    get size() { return active.size; },
    getSprites: () => [...active.values()].map((entry) => entry.sprite),
    start(event) {
      if (typeof event?.id !== "string" || !event.id || typeof event.type !== "string" || !event.type || active.has(event.id)) return false;
      const counts = Array(KIRBY_FORM_COUNT).fill(0);
      for (const entry of active.values()) counts[entry.sprite]++;
      const least = Math.min(...counts);
      const choices = counts.flatMap((count, index) => count === least ? [index] : []);
      const sample = random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("Random source must return a number in [0, 1).");
      active.set(event.id, { type: event.type, sprite: choices[Math.floor(sample * choices.length)] });
      return true;
    },
    finish(event) {
      const entry = active.get(event?.id);
      if (!entry || entry.type !== event.type) return false;
      return active.delete(event.id);
    },
    clear: () => active.clear(),
  };
}

function spriteIcon(spriteId, tick) {
  const frame = ((tick % artwork.frameCount) + artwork.frameCount) % artwork.frameCount;
  const sprite = artwork.sprites[spriteId];
  if (!sprite) throw new Error("Unknown Kirby form.");
  return sprite.frames[frame];
}

// One timer per mounted widget, never one per worker. Disposal invalidates even
// callbacks that were already queued when clearTimeout ran.
export function createKirbyWidget({ activity, getText, requestRender, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let tick = 0;
  let disposed = false;
  let generation = 0;
  const stop = () => {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const update = () => {
    if (disposed) return;
    if (!activity.size) stop();
    else if (timer === null) {
      const scheduledGeneration = generation;
      timer = setTimer(() => {
        if (disposed || generation !== scheduledGeneration) return;
        timer = null;
        tick = (tick + 1) % artwork.frameCount;
        update();
      }, KIRBY_FRAME_MS);
      timer?.unref?.();
    }
    requestRender();
  };
  return {
    render: (width) => disposed ? [] : renderKirbyStatus({ text: getText(), sprites: activity.getSprites(), tick, width }),
    invalidate() {},
    update,
    dispose() { disposed = true; stop(); },
  };
}

export function renderKirbyStatus({ text, sprites, tick = 0, width }) {
  if (!Number.isInteger(width) || width <= 0) return [];
  const fitted = text.length > width ? text.slice(-width) : text.padStart(width);
  if (!sprites.length) return [fitted];
  const used = sprites.length * (ICON_COLUMNS + 1) + text.length;
  if (used <= width) {
    return [" ".repeat(width - used) + sprites.map((id) => spriteIcon(id, tick)).join(" ") + " " + text];
  }
  // Never wrap, crop a sprite, or cut an ANSI sequence. Prefer an explicit total
  // to showing a partial fleet that could be mistaken for the active count.
  const count = `A(${sprites.length})`;
  if (count.length <= width) return [`${count} ${text}`.slice(0, width).padStart(width)];
  const digits = String(sprites.length);
  return [(digits.length <= width ? digits : "+").padStart(width)];
}
