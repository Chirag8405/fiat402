/**
 * Per-zone progress windows, derived from positionCurve's arc-length
 * parameterization -- NOT simply i/(n-1). CameraRig moves the camera via
 * getPointAt (arc-length parameterized), so the global progress t at which
 * the camera is actually centered on zone i depends on how far apart the
 * control points are in 3D space, not their index. This computes the real
 * per-zone windows once at module load (the curve is static) so any zone
 * component can scope its own animation to "only while the camera is near
 * this zone" without hand-tuning per-zone progress ranges.
 *
 * Read-only consumer of cameraPath.ts's exports -- does not modify
 * positionCurve/ZONES/CameraRig in any way.
 */

import * as THREE from "three";
import { positionCurve, ZONES } from "./cameraPath";

// A multiple of (ZONES.length - 1) so each control point's own raw
// parameter u = i/(n-1) lands exactly on a sampled index (i * SAMPLES_PER_SEGMENT).
const SAMPLES_PER_SEGMENT = 100;
const divisions = (ZONES.length - 1) * SAMPLES_PER_SEGMENT;
const lengths = positionCurve.getLengths(divisions);
const total = lengths[lengths.length - 1];

/** Arc-length-normalized t (0..1) at which the camera is exactly centered on zone i. */
export const ZONE_T: number[] = ZONES.map((_, i) => lengths[i * SAMPLES_PER_SEGMENT] / total);

/** [start, end] progress window for zone i -- midpoint to each neighboring zone's center, clamped at the page's own ends. */
export function zoneRange(i: number): [number, number] {
  const start = i === 0 ? 0 : (ZONE_T[i - 1] + ZONE_T[i]) / 2;
  const end = i === ZONES.length - 1 ? 1 : (ZONE_T[i] + ZONE_T[i + 1]) / 2;
  return [start, end];
}

/** 0..1 local progress within zone i's window (0 at window start, 1 at window end). Clamped, not null, outside the window -- callers gate visibility themselves. */
export function zoneLocalProgress(i: number, globalT: number): number {
  const [start, end] = zoneRange(i);
  return THREE.MathUtils.clamp((globalT - start) / (end - start), 0, 1);
}
