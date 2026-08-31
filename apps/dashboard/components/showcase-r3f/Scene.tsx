"use client";

/**
 * <Canvas> contents: lighting + all 7 zones + the camera rig. Kept as one
 * component so app/page.tsx doesn't need to know the zone list.
 *
 * Zones 0 (cold-open) and 1 (old-way) render their Phase 2 real content
 * (ColdOpenZone/OldWayZone); zones 2-6 (bridge through close) still render
 * Phase 1's wireframe ZoneMarker placeholder, untouched.
 */

import { ZONES } from "./cameraPath";
import { ZoneMarker } from "./ZoneMarker";
import { ColdOpenZone } from "./ColdOpenZone";
import { OldWayZone } from "./OldWayZone";
import { CameraRig } from "./CameraRig";

export function Scene() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      <ColdOpenZone />
      <OldWayZone />
      {ZONES.slice(2).map(zone => (
        <ZoneMarker key={zone.id} zone={zone} />
      ))}
      <CameraRig />
    </>
  );
}
