/**
 * Scroll progress (0..1 across the whole document), shared between the DOM
 * (ScrollProvider's GSAP ScrollTrigger, which writes it) and the R3F scene
 * (CameraRig's useFrame, which reads it once per frame).
 *
 * Deliberately a plain mutable object, not Zustand/Context: exactly one
 * writer and one reader, both imperative and both already living outside
 * React's render cycle (a ScrollTrigger callback and a useFrame callback),
 * so a reactive store would add re-render machinery neither side needs.
 */
export const progressStore = { value: 0 };
