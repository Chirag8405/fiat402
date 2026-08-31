"use client";

/**
 * Dev-only baseline visibility into frame rate before real content (real
 * geometry, textures, <Html transform> panels in later phases) gets added
 * on top of this foundation. No UI, no smoothing beyond a 1s rolling
 * window -- just `console.log` once/sec. Only ever mounted when
 * NODE_ENV === "development" (see app/page.tsx), so this is fully absent
 * from the production bundle via dead-code elimination at that call site.
 */

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";

export function FpsMeter() {
  const frameCount = useRef(0);
  const windowStart = useRef(0);

  useFrame((_, delta) => {
    frameCount.current += 1;
    windowStart.current += delta;
    if (windowStart.current >= 1) {
      // eslint-disable-next-line no-console
      console.log("[r3f-fps]", frameCount.current);
      frameCount.current = 0;
      windowStart.current = 0;
    }
  });

  return null;
}
