"use client";

/**
 * Real content for zone 1 (old-way), replacing Phase 1's wireframe
 * ZoneMarker placeholder. Pain points pulled verbatim from
 * components/showcase/OldWay.tsx's PAIN_POINTS: KYC verification, API key
 * provisioning, recurring subscriptions.
 *
 * Three primitive-built obstacle objects sit along the camera's path
 * through this zone. Each has its own "pass-through" center point within
 * the zone's local progress window (see zoneProgress.ts) -- as the camera
 * approaches and passes that point, the object dissolves (scale + opacity
 * fall to near-zero) and its label fades with it, reading as "moving
 * through/destroying the old obstacles." Purely a function of scroll
 * progress, so it's exactly reversible scrolling back up.
 *
 * Colored with the existing --color-danger red, reusing the same
 * old-way-is-struck-through-in-red language OldWay.tsx's DOM version used.
 */

import { useMemo, useRef, type ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import { progressStore } from "./progressStore";
import { zoneLocalProgress, zoneRange } from "./zoneProgress";

const DANGER = "#f14a4a"; // hsl(0 84% 63%), see app/globals.css's --color-danger
const VISIBLE_MARGIN = 0.08;
const DISSOLVE_WINDOW = 0.16; // fraction of the zone's local [0,1] range over which an object fully dissolves around its center point

const ZONE_INDEX = 1;
const [ZONE_START, ZONE_END] = zoneRange(ZONE_INDEX);

interface PainPoint {
  id: string;
  label: string;
  position: [number, number, number];
  center: number; // local progress (0..1) at which this object is fully dissolved
}

// Placed along the camera's actual path through this zone: from
// ZONES[1].position (3, 0.5, 4) heading toward ZONES[2].position (-3, 1, -4).
const PAIN_POINTS: PainPoint[] = [
  { id: "kyc", label: "KYC VERIFICATION", position: [2.2, 0.3, 6], center: 1 / 6 },
  { id: "api-key", label: "API KEY PROVISIONING", position: [3.6, 0.6, 1], center: 3 / 6 },
  { id: "subscriptions", label: "RECURRING SUBSCRIPTIONS", position: [2.6, 0.9, -3], center: 5 / 6 },
];

function KycLock() {
  return (
    <group>
      <mesh position={[0, -0.15, 0]}>
        <boxGeometry args={[0.7, 0.55, 0.35]} />
        <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
      </mesh>
      <mesh position={[0, 0.28, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.22, 0.06, 12, 24, Math.PI]} />
        <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
      </mesh>
    </group>
  );
}

function ApiKey() {
  return (
    <group rotation={[0, 0, Math.PI / 6]}>
      <mesh position={[-0.35, 0, 0]}>
        <torusGeometry args={[0.22, 0.07, 12, 24]} />
        <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
      </mesh>
      <mesh position={[0.25, 0, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 0.7, 12]} />
        <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
      </mesh>
      <mesh position={[0.5, -0.1, 0]}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
      </mesh>
      <mesh position={[0.62, -0.05, 0]}>
        <boxGeometry args={[0.1, 0.1, 0.1]} />
        <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
      </mesh>
    </group>
  );
}

function SubscriptionLoop() {
  return (
    <mesh rotation={[Math.PI / 2.2, 0, 0]}>
      <torusGeometry args={[0.4, 0.09, 16, 32]} />
      <meshStandardMaterial color={DANGER} emissive={DANGER} emissiveIntensity={0.25} transparent />
    </mesh>
  );
}

const OBJECT_COMPONENTS: Record<string, () => ReactElement> = {
  kyc: KycLock,
  "api-key": ApiKey,
  subscriptions: SubscriptionLoop,
};

function collectMaterials(root: Group): MeshStandardMaterial[] {
  const materials: MeshStandardMaterial[] = [];
  root.traverse(child => {
    const mesh = child as Mesh;
    if (mesh.isMesh && mesh.material) {
      materials.push(mesh.material as MeshStandardMaterial);
    }
  });
  return materials;
}

function PainPointObject({ point }: { point: PainPoint }) {
  const groupRef = useRef<Group>(null);
  const materialsRef = useRef<MeshStandardMaterial[] | null>(null);
  // drei's <Html transform> portals its children to a DOM tree outside the
  // R3F Fiber tree, so a useFrame hook can't live inside PainPointLabel
  // itself (R3F throws "Hooks can only be used within the Canvas
  // component!"). Instead this component's own useFrame -- which already
  // runs inside the Canvas and already computes `intact` for the mesh --
  // writes the label's opacity directly via a plain ref.
  const labelRef = useRef<HTMLParagraphElement>(null);
  const ObjectComponent = OBJECT_COMPONENTS[point.id];

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    if (!materialsRef.current) {
      materialsRef.current = collectMaterials(group);
    }

    const local = zoneLocalProgress(ZONE_INDEX, progressStore.value);
    const distance = Math.abs(local - point.center);
    // 0 right at the object's pass-through point, 1 once fully clear of the dissolve window.
    const intact = THREE.MathUtils.smoothstep(distance, 0, DISSOLVE_WINDOW);

    const scale = THREE.MathUtils.lerp(0.05, 1, intact);
    group.scale.setScalar(scale);
    for (const material of materialsRef.current) {
      material.opacity = intact;
    }
    if (labelRef.current) {
      labelRef.current.style.opacity = String(intact);
    }
  });

  return (
    <group ref={groupRef} position={point.position}>
      <ObjectComponent />
      <Html transform position={[0, 0.7, 0]} occlude={false} className="pointer-events-none select-none">
        <p ref={labelRef} className="whitespace-nowrap font-mono text-[10px] uppercase tracking-widest text-danger">
          {point.label}
        </p>
      </Html>
    </group>
  );
}

export function OldWayZone() {
  const groupRef = useRef<Group>(null);
  const points = useMemo(() => PAIN_POINTS, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const t = progressStore.value;
    group.visible = t > ZONE_START - VISIBLE_MARGIN && t < ZONE_END + VISIBLE_MARGIN;
  });

  return (
    <group ref={groupRef}>
      {points.map(point => (
        <PainPointObject key={point.id} point={point} />
      ))}
    </group>
  );
}
