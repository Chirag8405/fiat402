/**
 * Custom shader material for the bridge zone's packet: blends between the
 * PAYMENT-REQUIRED header texture and the UPI QR texture via a noise-based
 * dissolve, driven entirely by uProgress (0..1) -- no time uniform at all,
 * so scrubbing the page back and forth re-evaluates the same noise field
 * against a different threshold and the dissolve is exactly reversible.
 *
 * The noise function is a standard, self-contained hash-based 2D value
 * noise (no texture lookup, no external asset) -- cheap enough to run per
 * pixel on a single card-sized mesh.
 */

import type React from "react";
import { shaderMaterial } from "@react-three/drei";
import * as THREE from "three";
import { extend } from "@react-three/fiber";

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uHeaderTex;
  uniform sampler2D uQrTex;
  uniform float uProgress;
  uniform vec3 uAccent;
  varying vec2 vUv;

  // Cheap hash-based 2D value noise -- standard technique, no texture lookup.
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  const float NOISE_SCALE = 9.0;
  const float EDGE = 0.1;

  void main() {
    vec4 headerColor = texture2D(uHeaderTex, vUv);
    vec4 qrColor = texture2D(uQrTex, vUv);

    float n = noise(vUv * NOISE_SCALE);
    float diff = n - uProgress;
    // qrMix: 0 = fully header, 1 = fully qr, soft band around diff == 0.
    float qrMix = 1.0 - smoothstep(-EDGE, EDGE, diff);
    vec3 color = mix(headerColor.rgb, qrColor.rgb, qrMix);

    // Lit seam right at the dissolve boundary.
    float edgeGlow = 1.0 - smoothstep(0.0, EDGE, abs(diff));
    color += edgeGlow * uAccent * 0.6;

    gl_FragColor = vec4(color, 1.0);
  }
`;

// 1x1 white placeholder so the material is valid before the real canvas
// textures (header is synchronous, qr depends on a one-time DOM ref) are ready.
function placeholderTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

export const PacketDissolveMaterial = shaderMaterial(
  {
    uHeaderTex: placeholderTexture(),
    uQrTex: placeholderTexture(),
    uProgress: 0,
    uAccent: new THREE.Color("#38b6ea"), // hsl(199 89% 58%), see app/globals.css's --color-primary
  },
  vertexShader,
  fragmentShader,
);

extend({ PacketDissolveMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    packetDissolveMaterial: {
      ref?: React.Ref<THREE.ShaderMaterial & { uHeaderTex: THREE.Texture; uQrTex: THREE.Texture; uProgress: number; uAccent: THREE.Color }>;
      key?: React.Key;
      attach?: string;
      side?: THREE.Side;
      transparent?: boolean;
    };
  }
}
