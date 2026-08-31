"use client";

/**
 * <Canvas> contents: lighting + all 7 zones + the camera rig. Kept as one
 * component so app/page.tsx doesn't need to know the zone list.
 *
 * Zones 0 (cold-open), 1 (old-way), and 2 (bridge) render their real
 * content (ColdOpenZone/OldWayZone/BridgeZone); zones 3-6 (human-decide
 * through close) still render Phase 1's wireframe ZoneMarker placeholder,
 * untouched.
 */

import { ZONES } from "./cameraPath";
import { ZoneMarker } from "./ZoneMarker";
import { ColdOpenZone } from "./ColdOpenZone";
import { OldWayZone } from "./OldWayZone";
import { BridgeZone } from "./BridgeZone";
import { CameraRig } from "./CameraRig";

export function Scene() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      <ColdOpenZone />
      <OldWayZone />
      <BridgeZone />
      {ZONES.slice(3).map(zone => (
        <ZoneMarker key={zone.id} zone={zone} />
      ))}
      <CameraRig />
    </>
  );
}
