/**
 * src/client/ui/canvas.ts
 * --------------------------------------------------------------------------
 * Braille / ANSI block drawing paint handler.
 *
 * The canvas is a {@link FrameBufferRenderable} backed by a high-resolution
 * **dot grid**: every terminal cell encodes a 2x4 braille matrix, so the true
 * drawing resolution is (2·cols) x (4·rows) dots. Because terminal mice only
 * report whole-cell coordinates, we:
 *   1. up-scale each cell sample to its dot-space center,
 *   2. interpolate a continuous dot-space line between consecutive samples,
 *   3. stamp a *filled disc* brush at every step,
 * which turns sparse cell taps into smooth, solid strokes.
 *
 * The surface is fully transparent — it never paints its own background, so the
 * terminal's own theme shows through. The only colors used are the drawer's
 * chosen ink.
 * --------------------------------------------------------------------------
 */

import {
  FrameBufferRenderable,
  RGBA,
  type CliRenderer,
  type MouseEvent,
} from "@opentui/core";
import type { Color, DrawMode, DrawPointPayload } from "../../types/index.ts";

/**
 * Braille dot bit layout within a single cell (Unicode U+2800 base):
 *      col0  col1
 * row0 0x01  0x08
 * row1 0x02  0x10
 * row2 0x04  0x20
 * row3 0x40  0x80
 */
const BRAILLE_BITS: readonly [number, number][] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

// ASCII fill: opentui's framebuffer mis-encodes non-ASCII glyphs (the solid
// `█` shows up as `a^`/`â` mojibake in some terminals), so the block brush
// paints with a plain `#` that renders identically everywhere.
const SOLID_BLOCK = "#";
const SPACE = " ";
/** Fully transparent — lets the terminal background show through. */
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0);

export type Tool = "brush" | "line" | "rect" | "circle" | "fill";

export interface CanvasHandle {
  readonly renderable: FrameBufferRenderable;
  apply(point: DrawPointPayload): void;
  replay(points: readonly DrawPointPayload[]): void;
  clear(): void;
  setInteractive(on: boolean): void;
  /**
   * Undo / redo the local drawer's last stroke group. Returns the full list of
   * points that should now be on the board (so the caller can clear + rebroadcast
   * to everyone else), or `null` when there is nothing to undo / redo.
   */
  undo(): DrawPointPayload[] | null;
  redo(): DrawPointPayload[] | null;
  /** Explicitly size the canvas (cells) to fit its laid-out pane. */
  resize(width: number, height: number): void;
}

export interface CanvasOptions {
  /** Emit every locally-produced sample so it can be streamed to the server. */
  onDraw: (point: DrawPointPayload) => void;
  getColor: () => Color;
  getMode: () => DrawMode;
  /** Brush radius (dots for braille, cells for block). */
  getSize: () => number;
  /** Whether the eraser tool is active. */
  getErase: () => boolean;
  /** Active drawing tool (brush / shapes / fill). */
  getTool: () => Tool;
}

export function createCanvas(
  renderer: CliRenderer,
  opts: CanvasOptions,
): CanvasHandle {
  // Start at a 1×1 placeholder; the real size is driven by `resize()` from the
  // dashboard once the pane has been laid out. A FrameBufferRenderable's buffer
  // size is fixed by its explicit width/height and its content blits with NO
  // clipping, so flex-growing it on the cross axis would let a wide drawing
  // overflow into the sidebar — instead we size it explicitly to the pane.
  let cols = 1;
  let rows = 1;
  let dotW = cols * 2;
  let dotH = rows * 4;

  // Source-of-truth model (independent of the frame buffer the layout owns).
  let dots = new Uint8Array(dotW * dotH); // 1 = lit braille dot
  let block = new Uint8Array(cols * rows); // 1 = solid █ cell
  let color: RGBA[] = makeColors(cols * rows); // last ink per cell

  let interactive = false;
  let lastLocal: { x: number; y: number } | null = null;
  let lastRemote: { x: number; y: number } | null = null;

  // Undo/redo: the local drawer's committed work, grouped per stroke/shape/fill.
  let groups: DrawPointPayload[][] = [];
  let redoStack: DrawPointPayload[][] = [];
  let currentGroup: DrawPointPayload[] = [];
  // Shape tools anchor on mouse-down and preview until release.
  let shapeAnchor: { cx: number; cy: number } | null = null;
  // Brush footprint preview under the cursor.
  let hover: { cx: number; cy: number } | null = null;

  const fb = new FrameBufferRenderable(renderer, {
    width: cols,
    height: rows,
    respectAlpha: true,
    flexGrow: 0,
    flexShrink: 0,
    onSizeChange() {
      resizeModel(fb.frameBuffer.width, fb.frameBuffer.height);
    },
    onMouseDown(event: MouseEvent) {
      if (!interactive) return;
      const c = rawCell(event);
      if (!inRange(c)) return;
      const tool = opts.getTool();
      if (tool === "fill") { doFill(c.cx, c.cy); return; }
      if (tool === "brush") { lastLocal = null; currentGroup = []; paintLocal(event, false); return; }
      shapeAnchor = c;
      renderPreviewShape(c, c);
    },
    onMouseDrag(event: MouseEvent) {
      if (!interactive) return;
      if (opts.getTool() === "brush") { paintLocal(event, true); return; }
      if (shapeAnchor) renderPreviewShape(shapeAnchor, clampCell(rawCell(event)));
    },
    onMouseUp(event: MouseEvent) {
      if (!interactive) return;
      finishStroke(event);
    },
    onMouseDragEnd(event: MouseEvent) {
      if (!interactive) return;
      finishStroke(event);
    },
    onMouseMove(event: MouseEvent) {
      if (!interactive || shapeAnchor) return;
      if (opts.getTool() !== "brush") return;
      const c = rawCell(event);
      const next = inRange(c) ? c : null;
      // Only repaint when the cursor crosses into a new cell.
      if (next?.cx === hover?.cx && next?.cy === hover?.cy) return;
      hover = next;
      renderHover();
    },
    onMouseOut() {
      if (hover) { hover = null; if (interactive) redrawAll(); }
    },
  });

  redrawAll();

  /* --------------------------------------------------------------------- */
  /* Allocation helpers                                                    */
  /* --------------------------------------------------------------------- */

  function makeColors(n: number): RGBA[] {
    const arr = new Array<RGBA>(n);
    for (let i = 0; i < n; i++) arr[i] = TRANSPARENT;
    return arr;
  }

  function resizeModel(newCols: number, newRows: number): void {
    if (newCols === cols && newRows === rows) return;
    const nDotW = newCols * 2;
    const nDotH = newRows * 4;
    const nDots = new Uint8Array(nDotW * nDotH);
    const nBlock = new Uint8Array(newCols * newRows);
    const nColor = makeColors(newCols * newRows);

    const cpDotW = Math.min(dotW, nDotW);
    const cpDotH = Math.min(dotH, nDotH);
    for (let y = 0; y < cpDotH; y++)
      for (let x = 0; x < cpDotW; x++) nDots[y * nDotW + x] = dots[y * dotW + x]!;

    const cpC = Math.min(cols, newCols);
    const cpR = Math.min(rows, newRows);
    for (let y = 0; y < cpR; y++)
      for (let x = 0; x < cpC; x++) {
        nBlock[y * newCols + x] = block[y * cols + x]!;
        nColor[y * newCols + x] = color[y * cols + x]!;
      }

    cols = newCols;
    rows = newRows;
    dotW = nDotW;
    dotH = nDotH;
    dots = nDots;
    block = nBlock;
    color = nColor;
    redrawAll();
  }

  /* --------------------------------------------------------------------- */
  /* Rendering                                                             */
  /* --------------------------------------------------------------------- */

  /** Repaint a single cell from the model into the frame buffer. */
  function renderCell(cx: number, cy: number): void {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
    const idx = cy * cols + cx;
    const ink = color[idx]!;
    if (block[idx]) {
      fb.frameBuffer.setCell(cx, cy, SOLID_BLOCK, ink, TRANSPARENT);
      return;
    }
    let bits = 0;
    const baseX = cx * 2;
    const baseY = cy * 4;
    for (let dy = 0; dy < 4; dy++) {
      const row = (baseY + dy) * dotW;
      if (dots[row + baseX]) bits |= BRAILLE_BITS[dy]![0];
      if (dots[row + baseX + 1]) bits |= BRAILLE_BITS[dy]![1];
    }
    if (bits !== 0) {
      fb.frameBuffer.setCell(cx, cy, String.fromCharCode(0x2800 + bits), ink, TRANSPARENT);
    } else {
      // Empty cell → transparent space so the terminal background shows.
      fb.frameBuffer.setCell(cx, cy, SPACE, TRANSPARENT, TRANSPARENT);
    }
  }

  function redrawAll(): void {
    fb.frameBuffer.clear(TRANSPARENT);
    for (let cy = 0; cy < rows; cy++)
      for (let cx = 0; cx < cols; cx++) renderCell(cx, cy);
    renderer.requestRender();
  }

  /* --------------------------------------------------------------------- */
  /* Brush primitives                                                      */
  /* --------------------------------------------------------------------- */

  /**
   * Stamp a filled disc of braille dots centered on a dot coordinate. Dots are
   * ~square in screen space (cell ≈ 2:1), so a plain Euclidean disc reads round.
   * Touched cells are collected so only they get re-rendered.
   */
  function stampDotDisc(
    dcx: number,
    dcy: number,
    r: number,
    ink: RGBA,
    erase: boolean,
    touched: Set<number>,
  ): void {
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = dcx + dx;
        const y = dcy + dy;
        if (x < 0 || y < 0 || x >= dotW || y >= dotH) continue;
        dots[y * dotW + x] = erase ? 0 : 1;
        const cx = x >> 1;
        const cy = y >> 2;
        const cIdx = cy * cols + cx;
        block[cIdx] = 0; // braille always clears any solid block in this cell
        if (!erase) color[cIdx] = ink;
        touched.add(cIdx);
      }
    }
  }

  /** Stamp a filled square of solid-block cells (block brush). */
  function stampBlock(
    cx: number,
    cy: number,
    r: number,
    ink: RGBA,
    erase: boolean,
    touched: Set<number>,
  ): void {
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const idx = y * cols + x;
        if (erase) {
          block[idx] = 0;
          // also clear the cell's braille dots
          for (let dy = 0; dy < 4; dy++) {
            const row = (y * 4 + dy) * dotW;
            dots[row + x * 2] = 0;
            dots[row + x * 2 + 1] = 0;
          }
        } else {
          block[idx] = 1;
          color[idx] = ink;
        }
        touched.add(idx);
      }
    }
  }

  /** Cell → dot-space center. */
  const dotCX = (cx: number) => cx * 2;
  const dotCY = (cy: number) => cy * 4 + 1;

  /**
   * Apply one stamp at a cell, interpolating from `from` (if continuing a drag)
   * so strokes stay connected. Returns the touched-cell set for re-rendering.
   */
  function stamp(
    cx: number,
    cy: number,
    from: { x: number; y: number } | null,
    point: { color: Color; mode: DrawMode; size: number; erase: boolean },
  ): Set<number> {
    const touched = new Set<number>();
    const ink = RGBA.fromHex(point.color);

    if (point.mode === "block") {
      const br = Math.max(0, point.size - 1);
      if (from) lineCells(from.x, from.y, cx, cy, (x, y) => stampBlock(x, y, br, ink, point.erase, touched));
      else stampBlock(cx, cy, br, ink, point.erase, touched);
    } else {
      const rad = Math.max(1, point.size);
      if (from) {
        lineDots(dotCX(from.x), dotCY(from.y), dotCX(cx), dotCY(cy), (x, y) =>
          stampDotDisc(x, y, rad, ink, point.erase, touched),
        );
      } else {
        stampDotDisc(dotCX(cx), dotCY(cy), rad, ink, point.erase, touched);
      }
    }
    return touched;
  }

  /** Bresenham over cells. */
  function lineCells(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (let g = 0; g < 5000; g++) {
      plot(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  /** Bresenham over dots (finer interpolation for braille strokes). */
  function lineDots(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (let g = 0; g < 20000; g++) {
      plot(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  function flush(touched: Set<number>): void {
    for (const idx of touched) renderCell(idx % cols, (idx / cols) | 0);
    renderer.requestRender();
  }

  /* --------------------------------------------------------------------- */
  /* Local pointer → sample                                                */
  /* --------------------------------------------------------------------- */

  /* --- Cell helpers ----------------------------------------------------- */

  function rawCell(event: MouseEvent): { cx: number; cy: number } {
    return { cx: Math.floor(event.x - fb.x), cy: Math.floor(event.y - fb.y) };
  }
  function inRange(c: { cx: number; cy: number }): boolean {
    return c.cx >= 0 && c.cy >= 0 && c.cx < cols && c.cy < rows;
  }
  function clampCell(c: { cx: number; cy: number }): { cx: number; cy: number } {
    return {
      cx: Math.min(cols - 1, Math.max(0, c.cx)),
      cy: Math.min(rows - 1, Math.max(0, c.cy)),
    };
  }

  /**
   * Build a resolution- and aspect-independent wire payload from a cell.
   * Position is normalized to [0,1); `ar` carries our dot-space aspect; the brush
   * radius is normalized to a fraction of canvas height in dots, so receivers
   * letterbox by `ar` and the drawing keeps its shape everywhere.
   */
  function makePoint(
    cx: number, cy: number, mode: DrawMode, realSize: number,
    color: Color, erase: boolean, drag: boolean,
  ): DrawPointPayload {
    const realDots = mode === "block" ? realSize * 4 : realSize;
    return { x: cx / cols, y: cy / rows, ar: dotW / dotH, color, mode, size: realDots / dotH, erase, drag };
  }

  function paintLocal(event: MouseEvent, drag: boolean): void {
    const c = rawCell(event);
    if (!inRange(c)) return;

    const mode = opts.getMode();
    const realSize = Math.max(1, Math.floor(opts.getSize()));
    const color = opts.getColor();
    const erase = opts.getErase();

    // Render our own stroke at full local resolution for crisp feedback.
    flush(stamp(c.cx, c.cy, drag ? lastLocal : null, { color, mode, size: realSize, erase }));
    lastLocal = { x: c.cx, y: c.cy };
    const point = makePoint(c.cx, c.cy, mode, realSize, color, erase, drag);
    opts.onDraw(point);
    currentGroup.push(point);
  }

  /* --- Stroke commit (brush / shapes) ----------------------------------- */

  function finishStroke(event: MouseEvent): void {
    const tool = opts.getTool();
    if (tool === "brush") {
      if (currentGroup.length) { groups.push(currentGroup); currentGroup = []; redoStack = []; }
      lastLocal = null;
      return;
    }
    if (shapeAnchor) {
      commitShape(tool, shapeAnchor, clampCell(rawCell(event)));
      shapeAnchor = null;
    }
  }

  function commitShape(tool: Tool, a: { cx: number; cy: number }, b: { cx: number; cy: number }): void {
    const cells = shapeCells(tool, a, b);
    const mode = opts.getMode();
    const realSize = Math.max(1, Math.floor(opts.getSize()));
    const color = opts.getColor();
    const erase = opts.getErase();
    currentGroup = [];
    for (const cell of cells) {
      stamp(cell.cx, cell.cy, null, { color, mode, size: realSize, erase });
      const p = makePoint(cell.cx, cell.cy, mode, realSize, color, erase, false);
      opts.onDraw(p);
      currentGroup.push(p);
    }
    if (currentGroup.length) { groups.push(currentGroup); currentGroup = []; redoStack = []; }
    redrawAll();
  }

  /** Compute the set of cells outlining a shape between two corners. */
  function shapeCells(tool: Tool, a: { cx: number; cy: number }, b: { cx: number; cy: number }): { cx: number; cy: number }[] {
    if (tool === "line") {
      const out: { cx: number; cy: number }[] = [];
      lineCells(a.cx, a.cy, b.cx, b.cy, (x, y) => out.push({ cx: x, cy: y }));
      return out;
    }
    const x0 = Math.min(a.cx, b.cx), x1 = Math.max(a.cx, b.cx);
    const y0 = Math.min(a.cy, b.cy), y1 = Math.max(a.cy, b.cy);
    const seen = new Set<number>();
    const out: { cx: number; cy: number }[] = [];
    const add = (x: number, y: number) => {
      const k = y * cols + x;
      if (x < 0 || y < 0 || x >= cols || y >= rows || seen.has(k)) return;
      seen.add(k); out.push({ cx: x, cy: y });
    };
    if (tool === "rect") {
      for (let x = x0; x <= x1; x++) { add(x, y0); add(x, y1); }
      for (let y = y0; y <= y1; y++) { add(x0, y); add(x1, y); }
      return out;
    }
    // circle / ellipse inscribed in the bounding box
    const cxC = (x0 + x1) / 2, cyC = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    const steps = Math.max(12, Math.round((rx + ry) * 4));
    for (let i = 0; i < steps; i++) {
      const ang = (i / steps) * Math.PI * 2;
      add(Math.round(cxC + rx * Math.cos(ang)), Math.round(cyC + ry * Math.sin(ang)));
    }
    return out;
  }

  /* --- Flood fill ------------------------------------------------------- */

  function isInked(x: number, y: number): boolean {
    const idx = y * cols + x;
    if (block[idx]) return true;
    const bx = x * 2, by = y * 4;
    for (let dy = 0; dy < 4; dy++) {
      const row = (by + dy) * dotW;
      if (dots[row + bx] || dots[row + bx + 1]) return true;
    }
    return false;
  }

  function doFill(sx: number, sy: number): void {
    const hex = opts.getColor();
    const ink = RGBA.fromHex(hex);
    const target = isInked(sx, sy);
    const CAP = 4000;
    const seen = new Set<number>();
    const filled: number[] = [];
    const stack: [number, number][] = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const idx = y * cols + x;
      if (seen.has(idx)) continue;
      seen.add(idx);
      if (isInked(x, y) !== target) continue;
      filled.push(idx);
      if (filled.length > CAP) return; // region too large — bail without filling
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    currentGroup = [];
    for (const idx of filled) {
      const x = idx % cols, y = (idx / cols) | 0;
      block[idx] = 1;
      color[idx] = ink;
      const p = makePoint(x, y, "block", 1, hex, false, false);
      p.size = 0; // single-cell block stamp on receivers
      opts.onDraw(p);
      currentGroup.push(p);
    }
    if (currentGroup.length) { groups.push(currentGroup); currentGroup = []; redoStack = []; }
    redrawAll();
  }

  /* --- Previews --------------------------------------------------------- */

  function renderPreviewShape(a: { cx: number; cy: number }, b: { cx: number; cy: number }): void {
    redrawAll();
    const ink = RGBA.fromHex(opts.getColor());
    for (const c of shapeCells(opts.getTool(), a, b)) {
      if (c.cx < 0 || c.cy < 0 || c.cx >= cols || c.cy >= rows) continue;
      fb.frameBuffer.setCell(c.cx, c.cy, SOLID_BLOCK, ink, TRANSPARENT);
    }
    renderer.requestRender();
  }

  function renderHover(): void {
    redrawAll();
    if (!hover) return;
    const ink = RGBA.fromHex(opts.getColor());
    fb.frameBuffer.setCell(hover.cx, hover.cy, SOLID_BLOCK, ink, TRANSPARENT);
    renderer.requestRender();
  }

  /* --- Undo / redo ------------------------------------------------------ */

  function rebuildFromGroups(): void {
    wipe();
    lastRemote = null;
    lastLocal = null;
    for (const g of groups) {
      let from: { x: number; y: number } | null = null;
      for (const p of g) {
        const { cx, cy, size } = localFromPayload(p);
        stamp(cx, cy, p.drag ? from : null, { color: p.color, mode: p.mode, size, erase: p.erase });
        from = { x: cx, y: cy };
      }
    }
    redrawAll();
  }

  function flatten(): DrawPointPayload[] {
    const out: DrawPointPayload[] = [];
    for (const g of groups) out.push(...g);
    return out;
  }

  /**
   * Convert a normalized wire payload into this canvas's local cell space,
   * letterboxing by the drawer's aspect ratio so the shape is preserved.
   */
  function localFromPayload(p: DrawPointPayload): { cx: number; cy: number; size: number } {
    // Fit a rectangle of aspect `ar` (intrinsic size ar × 1) into our dot grid.
    const ar = p.ar > 0 ? p.ar : dotW / dotH;
    const scale = Math.min(dotW / ar, dotH);
    const renderedW = ar * scale;
    const renderedH = scale;
    const offX = (dotW - renderedW) / 2;
    const offY = (dotH - renderedH) / 2;

    const gx = offX + p.x * renderedW; // dot-space coordinates on our canvas
    const gy = offY + p.y * renderedH;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(gx / 2)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(gy / 4)));

    const radiusDots = p.size * scale;
    const size =
      p.mode === "block"
        ? Math.max(0, Math.round(radiusDots / 4))
        : Math.max(1, Math.round(radiusDots));
    return { cx, cy, size };
  }

  /* --------------------------------------------------------------------- */
  /* Public surface                                                        */
  /* --------------------------------------------------------------------- */

  function wipe(): void {
    dots.fill(0);
    block.fill(0);
    for (let i = 0; i < color.length; i++) color[i] = TRANSPARENT;
  }

  return {
    renderable: fb,

    apply(point) {
      const { cx, cy, size } = localFromPayload(point);
      flush(
        stamp(cx, cy, point.drag ? lastRemote : null, {
          color: point.color,
          mode: point.mode,
          size,
          erase: point.erase,
        }),
      );
      lastRemote = { x: cx, y: cy };
    },

    replay(points) {
      wipe();
      lastRemote = null;
      groups = [];
      redoStack = [];
      currentGroup = [];
      for (const p of points) {
        const { cx, cy, size } = localFromPayload(p);
        stamp(cx, cy, p.drag ? lastRemote : null, {
          color: p.color,
          mode: p.mode,
          size,
          erase: p.erase,
        });
        lastRemote = { x: cx, y: cy };
      }
      redrawAll();
    },

    clear() {
      wipe();
      lastLocal = null;
      lastRemote = null;
      groups = [];
      redoStack = [];
      currentGroup = [];
      shapeAnchor = null;
      redrawAll();
    },

    undo() {
      if (!groups.length) return null;
      redoStack.push(groups.pop()!);
      rebuildFromGroups();
      return flatten();
    },

    redo() {
      if (!redoStack.length) return null;
      groups.push(redoStack.pop()!);
      rebuildFromGroups();
      return flatten();
    },

    setInteractive(on) {
      interactive = on;
      if (!on) { lastLocal = null; hover = null; shapeAnchor = null; }
    },

    resize(width, height) {
      const nw = Math.max(1, Math.floor(width));
      const nh = Math.max(1, Math.floor(height));
      // Setting the renderable's explicit size triggers the library's
      // onResize → onSizeChange → resizeModel, keeping the model in sync.
      if (fb.width !== nw) fb.width = nw;
      if (fb.height !== nh) fb.height = nh;
    },
  };
}
