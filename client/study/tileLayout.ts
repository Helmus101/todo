// Auto-arrange helper for the Study Mode desk — computes a non-overlapping grid of rectangles (in canvas
// percent units, matching ArtifactState's x/y/width/height) for N artifacts, so opening a new tool never
// just stacks it on top of what's already open. Deliberately simple (no packing/constraint solver): a few
// hand-tuned layouts for small counts (which is the overwhelmingly common case on a study desk — 1-4 tools
// open at once), falling back to a generic grid beyond that.
export interface TileRect { x: number; y: number; width: number; height: number; }

// Percent — both the margin from the canvas edge and the gutter between tiles. Deliberately not tiny: a
// custom desk background (StudyMode.tsx's setBackgroundImage) is meant to stay visible behind the tools,
// not get reduced to a sliver by edge-to-edge tiling — a real margin keeps it genuinely visible even with
// several tools open, not just when the desk is empty.
const GAP = 4;

export function tileLayout(n: number): TileRect[] {
  if (n <= 0) return [];
  const full = 100 - GAP * 2;
  if (n === 1) return [{ x: GAP, y: GAP, width: full, height: full }];
  if (n === 2) {
    const w = (100 - GAP * 3) / 2;
    return [
      { x: GAP, y: GAP, width: w, height: full },
      { x: GAP * 2 + w, y: GAP, width: w, height: full },
    ];
  }
  if (n === 3) {
    // One larger pane on the left (the primary thing being worked on), two stacked on the right — a more
    // useful default than an even 3-way split for "reading material + notes + a quick tool" style setups.
    const leftW = (100 - GAP * 3) * 0.58;
    const rightW = 100 - GAP * 3 - leftW;
    const rightX = GAP * 2 + leftW;
    const rightH = (100 - GAP * 3) / 2;
    return [
      { x: GAP, y: GAP, width: leftW, height: full },
      { x: rightX, y: GAP, width: rightW, height: rightH },
      { x: rightX, y: GAP * 2 + rightH, width: rightW, height: rightH },
    ];
  }
  // Generic grid for 4+: as square a layout as possible, with the last (incomplete) row centered rather
  // than left-aligned-with-a-gap.
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = (100 - GAP * (cols + 1)) / cols;
  const cellH = (100 - GAP * (rows + 1)) / rows;
  const rects: TileRect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const itemsInRow = row === rows - 1 ? n - row * cols : cols;
    const rowOffset = ((cols - itemsInRow) * (cellW + GAP)) / 2;
    rects.push({
      x: GAP + rowOffset + col * (cellW + GAP),
      y: GAP + row * (cellH + GAP),
      width: cellW,
      height: cellH,
    });
  }
  return rects;
}

/** Is this artifact in "normal" freeform placement — the only state auto-tiling is allowed to touch?
 *  Minimized/maximized/docked artifacts are a DELIBERATE placement the student made; re-tiling would throw
 *  that away the moment they open one more tool, which would read as Otto randomly rearranging their desk. */
export function isTileable(a: { minimized: boolean; maximized: boolean; dockSide: string }): boolean {
  return !a.minimized && !a.maximized && a.dockSide === "none";
}
