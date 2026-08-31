"use client";

/**
 * Real content for zone 0 (cold-open), replacing Phase 1's wireframe
 * ZoneMarker placeholder. Copy pulled verbatim from
 * components/showcase/ColdOpen.tsx (the DOM original, now unused but kept
 * as a copy reference) -- the "402" framing and its two sub-copy lines.
 *
 * Placed at ZONES[0].target, not ZONES[0].position -- .position is the
 * CAMERA's own control point for this beat (where the camera itself sits
 * at t=0), not a point the camera looks at. See zoneProgress.ts's header
 * comment for the same distinction applied to animation timing.
 */

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Center, Html, Text3D } from "@react-three/drei";
import type { Group, Mesh } from "three";
import { ZONES } from "./cameraPath";
import { progressStore } from "./progressStore";
import { zoneRange } from "./zoneProgress";

const PRIMARY = "#38b6ea"; // hsl(199 89% 58%), see app/globals.css's --color-primary
const IDLE_ROTATION_SPEED = 0.05; // rad/s -- restrained, monument-like, not a spinning toy
const VISIBLE_MARGIN = 0.08; // extra global-progress slack either side of the zone window before fully hiding, avoids pop-in right at the edge

const TARGET = ZONES[0].target;
const [ZONE_START, ZONE_END] = zoneRange(0);

export function ColdOpenZone() {
  const groupRef = useRef<Group>(null);
  const textRef = useRef<Mesh>(null);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;

    const t = progressStore.value;
    const isNear = t > ZONE_START - VISIBLE_MARGIN && t < ZONE_END + VISIBLE_MARGIN;
    group.visible = isNear;
    if (!isNear) return;

    group.rotation.y += delta * IDLE_ROTATION_SPEED;
  });

  return (
    <group ref={groupRef} position={TARGET}>
      <Center>
        <Text3D ref={textRef} font="/fonts/droid_sans_mono_regular.typeface.json" size={1.6} height={0.4} curveSegments={12} bevelEnabled bevelThickness={0.03} bevelSize={0.02} bevelSegments={4}>
          402
          <meshStandardMaterial color={PRIMARY} emissive={PRIMARY} emissiveIntensity={0.5} metalness={0.3} roughness={0.4} />
        </Text3D>
      </Center>

      <Html transform position={[0, -1.8, 0.3]} occlude={false} className="pointer-events-none select-none">
        <p className="w-[26rem] max-w-none text-center font-mono text-sm leading-relaxed text-muted-foreground">
          The internet has had a payment status code since 1997.
          <br />
          Nobody used it until agents needed to
          <span className="blinking-cursor" aria-hidden="true">
            _
          </span>
        </p>
      </Html>
    </group>
  );
}
