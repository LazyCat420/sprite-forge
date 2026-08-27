/**
 * Deterministic Computer Vision & Sprite Anchor Debugger Engine.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SmartParts {
  head: Rect | null;
  torso: Rect | null;
  feet: Rect | null;
  weapon: Rect | null;
  fullBounds: Rect | null;
}

export interface FrameMetrics {
  bounds: Rect;
  centroid: Point;
  groundBaseline: number;
  headBox: Rect | null;
  areaPixels: number;
  occupancyRatio: number;
}

export function getForegroundBounds(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minAlpha = 16
): Rect | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (rgba[idx + 3] >= minAlpha) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) return null;
  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

export function findGroundBaseline(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minAlpha = 16
): number {
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (rgba[idx + 3] >= minAlpha) {
        return y;
      }
    }
  }
  return height - 1;
}

export function computeCentroid(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minAlpha = 16
): Point {
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (rgba[idx + 3] >= minAlpha) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  return {
    x: +(sumX / count).toFixed(2),
    y: +(sumY / count).toFixed(2),
  };
}

export function detectSmartParts(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minAlpha = 16
): SmartParts {
  const full = getForegroundBounds(rgba, width, height, minAlpha);
  if (!full) {
    return { head: null, torso: null, feet: null, weapon: null, fullBounds: null };
  }

  const headH = Math.max(4, Math.round(full.h * 0.35));
  const torsoH = Math.max(4, Math.round(full.h * 0.40));
  const feetH = Math.max(2, full.h - headH - torsoH);

  const head: Rect = {
    x: full.x,
    y: full.y,
    w: full.w,
    h: headH,
  };

  const torso: Rect = {
    x: full.x,
    y: full.y + headH,
    w: full.w,
    h: torsoH,
  };

  const feet: Rect = {
    x: full.x,
    y: full.y + headH + torsoH,
    w: full.w,
    h: feetH,
  };

  let weapon: Rect | null = null;
  const lateralOutliers: Point[] = [];
  const midYStart = full.y + Math.floor(headH * 0.5);
  const midYEnd = full.y + headH + torsoH;

  for (let y = midYStart; y <= midYEnd; y++) {
    for (let x = 0; x < width; x++) {
      if (x < full.x - 2 || x > full.x + full.w + 2) continue;
      const idx = (y * width + x) * 4;
      if (rgba[idx + 3] >= minAlpha) {
        if (x >= full.x + Math.floor(full.w * 0.75)) {
          lateralOutliers.push({ x, y });
        }
      }
    }
  }

  if (lateralOutliers.length >= 4) {
    let minWx = width, maxWx = -1, minWy = height, maxWy = -1;
    for (const pt of lateralOutliers) {
      if (pt.x < minWx) minWx = pt.x;
      if (pt.x > maxWx) maxWx = pt.x;
      if (pt.y < minWy) minWy = pt.y;
      if (pt.y > maxWy) maxWy = pt.y;
    }
    weapon = { x: minWx, y: minWy, w: maxWx - minWx + 1, h: maxWy - minWy + 1 };
  }

  return { head, torso, feet, weapon, fullBounds: full };
}

export function computeOnionSkinDelta(
  rgbaA: Uint8Array | Uint8ClampedArray,
  rgbaB: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): { diffCount: number; maxAlphaShift: number; deltaMap: Uint8Array } {
  const len = width * height;
  const deltaMap = new Uint8Array(len);
  let diffCount = 0;
  let maxAlphaShift = 0;

  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    const dr = Math.abs(rgbaA[idx] - rgbaB[idx]);
    const dg = Math.abs(rgbaA[idx + 1] - rgbaB[idx + 1]);
    const db = Math.abs(rgbaA[idx + 2] - rgbaB[idx + 2]);
    const da = Math.abs(rgbaA[idx + 3] - rgbaB[idx + 3]);

    const totalDiff = dr + dg + db + da;
    if (totalDiff > 10) {
      diffCount++;
      deltaMap[i] = Math.min(255, totalDiff);
    }
    if (da > maxAlphaShift) maxAlphaShift = da;
  }

  return { diffCount, maxAlphaShift, deltaMap };
}

export function assertProtectedPixels(
  originalRgba: Uint8Array | Uint8ClampedArray,
  repairedRgba: Uint8Array | Uint8ClampedArray,
  maskRgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): { valid: boolean; violatedPixels: number; firstViolation?: Point } {
  let violatedPixels = 0;
  let firstViolation: Point | undefined;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const maskVal = maskRgba[idx + 3] > 0 ? maskRgba[idx] : 0;

      if (maskVal === 0) {
        const rMatch = originalRgba[idx] === repairedRgba[idx];
        const gMatch = originalRgba[idx + 1] === repairedRgba[idx + 1];
        const bMatch = originalRgba[idx + 2] === repairedRgba[idx + 2];
        const aMatch = originalRgba[idx + 3] === repairedRgba[idx + 3];

        if (!rMatch || !gMatch || !bMatch || !aMatch) {
          violatedPixels++;
          if (!firstViolation) {
            firstViolation = { x, y };
          }
        }
      }
    }
  }

  return {
    valid: violatedPixels === 0,
    violatedPixels,
    firstViolation,
  };
}
