'use strict';

// Builds one JPEG showing a Camera Station view: each camera's snapshot is scaled into
// its tile, like the view's grid in Camera Station. Pure JavaScript (jpeg-js), so it
// runs on any Homey; it only runs when the picture is refreshed.

const jpeg = require('jpeg-js');

const WIDTH = 1280;
const HEIGHT = 720;
const BACKGROUND = [24, 24, 24];

// Nearest-neighbour scale of `src` into the box, keeping its aspect ratio (letterboxed).
function blit(dst, src, box) {
  const scale = Math.min(box.w / src.width, box.h / src.height);
  const w = Math.max(1, Math.floor(src.width * scale));
  const h = Math.max(1, Math.floor(src.height * scale));
  const x0 = box.x + Math.floor((box.w - w) / 2);
  const y0 = box.y + Math.floor((box.h - h) / 2);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = ((y0 + y) * WIDTH + (x0 + x)) * 4;
      dst[di] = src.data[si];
      dst[di + 1] = src.data[si + 1];
      dst[di + 2] = src.data[si + 2];
      dst[di + 3] = 255;
    }
  }
}

// Only the part of the grid that holds cameras is drawn, so a 12x12 layout with three
// cameras still fills the picture.
function usedArea(view) {
  let maxRow = 0;
  let maxCol = 0;
  for (const t of view.tiles) {
    maxRow = Math.max(maxRow, t.row + t.rowSpan);
    maxCol = Math.max(maxCol, t.column + t.columnSpan);
  }
  return { rows: Math.max(1, maxRow), columns: Math.max(1, maxCol) };
}

// snapshots: Map sourceId -> JPEG Buffer (missing cameras are left dark).
function composeGrid(view, snapshots, quality = 70) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BACKGROUND[0];
    data[i + 1] = BACKGROUND[1];
    data[i + 2] = BACKGROUND[2];
    data[i + 3] = 255;
  }
  const { rows, columns } = usedArea(view);
  const cellW = WIDTH / columns;
  const cellH = HEIGHT / rows;
  const gap = 2;
  for (const t of view.tiles) {
    const jpg = snapshots.get(t.camera.sourceId);
    if (!jpg) continue;
    let img;
    try {
      img = jpeg.decode(jpg, { useTArray: true, maxMemoryUsageInMB: 256 });
    } catch (e) {
      continue;
    }
    blit(data, img, {
      x: Math.round(t.column * cellW) + gap,
      y: Math.round(t.row * cellH) + gap,
      w: Math.round(t.columnSpan * cellW) - 2 * gap,
      h: Math.round(t.rowSpan * cellH) - 2 * gap,
    });
  }
  return jpeg.encode({ data, width: WIDTH, height: HEIGHT }, quality).data;
}

// Snapshot size to ask Camera Station for: the tile's size in the grid picture.
function tileSize(view, tile) {
  const { rows, columns } = usedArea(view);
  return {
    width: Math.round((WIDTH / columns) * tile.columnSpan),
    height: Math.round((HEIGHT / rows) * tile.rowSpan),
  };
}

module.exports = { composeGrid, tileSize };
