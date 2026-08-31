"use client";

/**
 * <Canvas> contents: lighting + all 7 zone placeholders + the camera rig.
 * Kept as one component so app/page.tsx doesn't need to know the zone list.
 */

import { ZONES } from "./cameraPath";
import { ZoneMarker } from "./ZoneMarker";
import { CameraRig } from "./CameraRig";

export function Scene() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      {ZONES.map(zone => (
        <ZoneMarker key={zone.id} zone={zone} />
      ))}
      <CameraRig />
    </>
  );
}
