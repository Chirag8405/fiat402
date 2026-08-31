"use client";

/**
 * Placeholder visual for one zone: a wireframe box + a mono drei <Text>
 * label, so the camera path/pacing between zones can be evaluated before
 * any real per-zone geometry exists. Colored with the page's existing
 * --color-primary blue (hsl(199 89% 58%)) so it reads as the same visual
 * language as the rest of the app rather than a generic Three.js demo.
 */

import { Text } from "@react-three/drei";
import type { Zone } from "./cameraPath";

const PRIMARY = "#38b6ea"; // hsl(199 89% 58%), see app/globals.css's --color-primary

export function ZoneMarker({ zone }: { zone: Zone }) {
  return (
    <group position={zone.position}>
      <mesh>
        <boxGeometry args={[1.6, 1.6, 1.6]} />
        <meshStandardMaterial color={PRIMARY} wireframe />
      </mesh>
      {/* No local mono font asset in public/ yet -- drei's default (troika's
          built-in) font is used as a placeholder; swap in a real mono font
          file via the `font` prop once one is added to public/fonts. */}
      <Text position={[0, 1.4, 0]} fontSize={0.32} color={PRIMARY} anchorX="center" anchorY="bottom" letterSpacing={0.08}>
        {zone.label}
      </Text>
    </group>
  );
}
