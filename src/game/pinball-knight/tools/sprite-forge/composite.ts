/**
 * COMPOSITE FORGE — Multi-Part Modular Sprite Assembly System.
 *
 * Allows assembling large complex monsters, dragons, multi-limbed bosses, or
 * articulated creatures from separate modular parts (e.g., Head, Wings,
 * Torso, Tail, FX) rendered in individual passes or grids.
 *
 * Everything here is pure and runs in both Node/vitest and the browser runtime.
 */

import { matteOpaque, type MatteOptions, type Rgb } from "./matte";

export interface PartLayer {
  name: string;
  /** Width, height, and raw RGBA image data for this layer's source sheet. */
  image: {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };
  /** Grid layout of the source sheet [cols, rows]. Default [4, 4]. */
  sourceGrid?: [number, number];
  /** Painting order: smaller zIndex drawn first, higher zIndex drawn on top. */
  zIndex: number;
  /** Base anchor point [x, y] in the target cell where the layer origin is placed. */
  anchor?: [number, number];
  /** Base offset [dx, dy] applied to all frames. */
  offset?: [number, number];
  /** Per-clip frame offsets [dx, dy] (e.g. { "attack": [[0, -2], [0, 4], [0, 8], [0, 0]] }). */
  frameOffsets?: Record<string, [number, number][]>;
  /** Scale factor (default 1.0). */
  scale?: number;
  /** Opacity multiplier (0.0 to 1.0, default 1.0). */
  opacity?: number;
  /** Horizontal mirror flip. */
  flipX?: boolean;
  /** If set, layer is only rendered during these active clips. */
  visibleClips?: string[];
  /** Optional matting options if the source image has an opaque chroma field. */
  matte?: MatteOptions;
}

export interface CompositeClipSpec {
  row: number;
  frames: number;
}

export interface CompositeConfig {
  id: string;
  /** Output grid dimensions [cols, rows] (e.g. [4, 4]). */
  grid: [number, number];
  /** Size of each individual output cell in pixels [width, height]. */
  cellSize: [number, number];
  /** Part layers to composite. */
  layers: PartLayer[];
  /** Named clip mapping to grid rows. */
  clips?: Record<string, CompositeClipSpec>;
}

export interface CompositeResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  cellWidth: number;
  cellHeight: number;
  grid: [number, number];
}

/**
 * Alpha-blend source pixel over destination pixel (standard Porter-Duff Over).
 */
export function blendPixel(
  dst: Uint8ClampedArray,
  dstIdx: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  opacity = 1.0,
): void {
  const alpha = (sa / 255) * opacity;
  if (alpha <= 0) return;

  const da = dst[dstIdx + 3] / 255;
  const outA = alpha + da * (1 - alpha);
  if (outA <= 0) return;

  const dr = dst[dstIdx];
  const dg = dst[dstIdx + 1];
  const db = dst[dstIdx + 2];

  const outR = (sr * alpha + dr * da * (1 - alpha)) / outA;
  const outG = (sg * alpha + dg * da * (1 - alpha)) / outA;
  const outB = (sb * alpha + db * da * (1 - alpha)) / outA;

  dst[dstIdx] = Math.round(outR);
  dst[dstIdx + 1] = Math.round(outG);
  dst[dstIdx + 2] = Math.round(outB);
  dst[dstIdx + 3] = Math.round(outA * 255);
}

/**
 * Extracts a single cell sub-region from a larger source sheet.
 */
export function extractCell(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  col: number,
  row: number,
  cols: number,
  rows: number,
): { width: number; height: number; data: Uint8ClampedArray } {
  const cellW = Math.floor(srcW / cols);
  const cellH = Math.floor(srcH / rows);
  const out = new Uint8ClampedArray(cellW * cellH * 4);

  const startX = col * cellW;
  const startY = row * cellH;

  for (let y = 0; y < cellH; y++) {
    const srcRow = (startY + y) * srcW * 4;
    const dstRow = y * cellW * 4;
    for (let x = 0; x < cellW; x++) {
      const si = srcRow + (startX + x) * 4;
      const di = dstRow + x * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }

  return { width: cellW, height: cellH, data: out };
}

/**
 * Assembles multiple modular part layers into a unified sprite sheet atlas.
 */
export function compositeSheet(config: CompositeConfig): CompositeResult {
  const [cols, rows] = config.grid;
  const [cellW, cellH] = config.cellSize;
  const totalW = cols * cellW;
  const totalH = rows * cellH;

  const outputData = new Uint8ClampedArray(totalW * totalH * 4);

  // 1. Pre-process and matte all layers if requested
  const processedLayers = config.layers.map((layer) => {
    let imgData = layer.image.data;
    if (layer.matte) {
      imgData = matteOpaque(imgData, layer.image.width, layer.image.height, layer.matte);
    }
    return {
      ...layer,
      image: {
        width: layer.image.width,
        height: layer.image.height,
        data: imgData,
      },
    };
  });

  // 2. Sort layers by zIndex ascending
  const sortedLayers = [...processedLayers].sort((a, b) => a.zIndex - b.zIndex);

  const defaultClips: Record<string, CompositeClipSpec> = config.clips ?? {
    idle: { row: 0, frames: cols },
    walk: { row: 1, frames: cols },
    attack: { row: 2, frames: cols },
    death: { row: 3, frames: cols },
  };

  // 3. Iterate through each cell in the output grid
  for (let r = 0; r < rows; r++) {
    // Find active clip name for this row if any
    const clipEntry = Object.entries(defaultClips).find(([, c]) => c.row === r);
    const clipName = clipEntry ? clipEntry[0] : "";

    for (let c = 0; c < cols; c++) {
      const cellStartX = c * cellW;
      const cellStartY = r * cellH;

      // Composite each layer onto this cell
      for (const layer of sortedLayers) {
        if (layer.visibleClips && clipName && !layer.visibleClips.includes(clipName)) {
          continue;
        }

        const [sCols, sRows] = layer.sourceGrid ?? [cols, rows];
        const srcCol = c % sCols;
        const srcRow = r % sRows;

        const cellData = extractCell(
          layer.image.data,
          layer.image.width,
          layer.image.height,
          srcCol,
          srcRow,
          sCols,
          sRows,
        );

        // Compute layer placement
        const anchorX = layer.anchor ? layer.anchor[0] : Math.floor(cellW / 2);
        const anchorY = layer.anchor ? layer.anchor[1] : Math.floor(cellH / 2);

        let dx = layer.offset ? layer.offset[0] : 0;
        let dy = layer.offset ? layer.offset[1] : 0;

        if (layer.frameOffsets && clipName && layer.frameOffsets[clipName]) {
          const frameOffset = layer.frameOffsets[clipName][c % layer.frameOffsets[clipName].length];
          if (frameOffset) {
            dx += frameOffset[0];
            dy += frameOffset[1];
          }
        }

        const srcCenterX = Math.floor(cellData.width / 2);
        const srcCenterY = Math.floor(cellData.height / 2);

        const targetX = cellStartX + anchorX - srcCenterX + dx;
        const targetY = cellStartY + anchorY - srcCenterY + dy;

        const opacity = layer.opacity ?? 1.0;
        const flipX = layer.flipX ?? false;

        // Blit cell onto output atlas
        for (let py = 0; py < cellData.height; py++) {
          const outY = targetY + py;
          if (outY < cellStartY || outY >= cellStartY + cellH || outY < 0 || outY >= totalH) continue;

          for (let px = 0; px < cellData.width; px++) {
            const outX = targetX + px;
            if (outX < cellStartX || outX >= cellStartX + cellW || outX < 0 || outX >= totalW) continue;

            const srcPxX = flipX ? cellData.width - 1 - px : px;
            const srcIdx = (py * cellData.width + srcPxX) * 4;
            const dstIdx = (outY * totalW + outX) * 4;

            const sr = cellData.data[srcIdx];
            const sg = cellData.data[srcIdx + 1];
            const sb = cellData.data[srcIdx + 2];
            const sa = cellData.data[srcIdx + 3];

            if (sa > 0) {
              blendPixel(outputData, dstIdx, sr, sg, sb, sa, opacity);
            }
          }
        }
      }
    }
  }

  return {
    width: totalW,
    height: totalH,
    data: outputData,
    cellWidth: cellW,
    cellHeight: cellH,
    grid: [cols, rows],
  };
}
