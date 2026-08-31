/**
 * The camera's path through the 7 zone beats of the showcase, as two
 * Catmull-Rom splines: one for camera position, one for what the camera
 * looks at. Interpolating both (not just position with a fixed forward
 * axis) is what makes the camera actually turn to "face" each zone as it
 * arrives, rather than reading as a straight dolly down a track.
 *
 * Zone order mirrors the original DOM sections 1:1 (see
 * components/showcase/*.tsx): cold-open, old-way, bridge, human-decide,
 * live-proof, code, close. Coordinates are placeholder pacing values, not
 * final art direction -- the point of this phase is to feel the timing
 * between beats and retune these, not to lock them in.
 */

import * as THREE from "three";

export interface Zone {
  id: string;
  label: string;
  /** Camera position when centered on this zone (0..1 progress control point). */
  position: THREE.Vector3;
  /** What the camera looks at when centered on this zone. */
  target: THREE.Vector3;
}

export const ZONES: Zone[] = [
  {
    id: "cold-open",
    label: "COLD OPEN",
    position: new THREE.Vector3(0, 0, 10),
    target: new THREE.Vector3(0, 0, 0),
  },
  {
    id: "old-way",
    label: "OLD WAY",
    position: new THREE.Vector3(3, 0.5, 4),
    target: new THREE.Vector3(3, 0.5, -6),
  },
  {
    id: "bridge",
    label: "BRIDGE",
    position: new THREE.Vector3(-3, 1, -4),
    target: new THREE.Vector3(-3, 1, -14),
  },
  {
    id: "human-decide",
    label: "HUMAN DECIDE",
    position: new THREE.Vector3(4, -0.5, -14),
    target: new THREE.Vector3(4, -0.5, -24),
  },
  {
    id: "live-proof",
    label: "LIVE PROOF",
    position: new THREE.Vector3(-4, 1.5, -24),
    target: new THREE.Vector3(-4, 1.5, -34),
  },
  {
    id: "code",
    label: "CODE",
    position: new THREE.Vector3(2, -1, -34),
    target: new THREE.Vector3(2, -1, -44),
  },
  {
    id: "close",
    label: "CLOSE",
    position: new THREE.Vector3(0, 0, -46),
    target: new THREE.Vector3(0, 0, -56),
  },
];

/** Arc-length parameterized (via getPointAt) so travel speed reads as even across unevenly spaced control points. */
export const positionCurve = new THREE.CatmullRomCurve3(
  ZONES.map(zone => zone.position),
  false,
  "catmullrom",
  0.5,
);

export const targetCurve = new THREE.CatmullRomCurve3(
  ZONES.map(zone => zone.target),
  false,
  "catmullrom",
  0.5,
);
