"use client";

/**
 * Reads progressStore every frame and moves the R3F default camera along
 * positionCurve/targetCurve accordingly. Lives inside <Canvas>. No React
 * state involved -- both the read (progressStore.value) and the write
 * (camera.position/camera.lookAt) are imperative, so this never triggers a
 * React re-render and can't stutter against React's commit cycle.
 */

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { positionCurve, targetCurve } from "./cameraPath";
import { progressStore } from "./progressStore";

export function CameraRig() {
  const targetVec = useRef(new THREE.Vector3());

  useFrame(({ camera }) => {
    const t = THREE.MathUtils.clamp(progressStore.value, 0, 1);
    positionCurve.getPointAt(t, camera.position);
    targetCurve.getPointAt(t, targetVec.current);
    camera.lookAt(targetVec.current);
  });

  return null;
}
