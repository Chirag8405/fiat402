"use client";

/**
 * Real content for zone 2 (bridge), replacing Phase 1's wireframe
 * ZoneMarker placeholder. The showcase's signature moment: a "packet" card
 * carrying the real captured PAYMENT-REQUIRED header dissolves into a real
 * UPI QR code as it travels through the zone, mirroring
 * components/showcase/Bridge.tsx's original GSAP crossfade -- same pacing
 * window (local progress [0.35, 0.55]), now a shader dissolve instead of an
 * opacity crossfade.
 *
 * Real data source: fixtures/researchbot-clean-approve.json's
 * headers.paymentRequiredHeader (base64 JSON) -- NOT Bridge.tsx's
 * hand-typed SAMPLE_PAYMENT_REQUIRED/SAMPLE_UPI_INTENT, which used an
 * invented ₹100.00. The real captured amount is "100" paise = ₹1.00.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { QRCodeCanvas } from "qrcode.react";
import * as THREE from "three";
import type { Group, Mesh } from "three";
import { ZONES } from "./cameraPath";
import { progressStore } from "./progressStore";
import { zoneLocalProgress, zoneRange } from "./zoneProgress";
import "./packetDissolveMaterial";
import researchbotCleanApprove from "../../fixtures/researchbot-clean-approve.json";

const ZONE_INDEX = 2;
const [ZONE_START, ZONE_END] = zoneRange(ZONE_INDEX);
const VISIBLE_MARGIN = 0.08;

// Dissolve happens over this sub-range of the zone's own local progress,
// matching Bridge.tsx's original GSAP crossfade window ([0.35, 0.55]).
const DISSOLVE_START = 0.35;
const DISSOLVE_END = 0.55;

const PRIMARY = "#38b6ea"; // hsl(199 89% 58%), --color-primary
const CARD_BG = "#19191f"; // hsl(240 8% 9%), --color-card
const CARD_BORDER = "#2c2c33"; // hsl(240 6% 20%), --color-border
const FOREGROUND = "#f5f5f5"; // hsl(0 0% 96%), --color-foreground
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const BASE = ZONES[ZONE_INDEX].position;
const HEAD = ZONES[ZONE_INDEX].target;

// Local path for the packet through this zone -- a gentle arc from the
// zone's own entry toward its target, not a straight line. Control points
// are offsets around BASE/HEAD, same "hand-placed pacing" spirit as
// cameraPath.ts's ZONES, just scoped to this one zone.
const packetCurve = new THREE.CatmullRomCurve3(
  [
    new THREE.Vector3(BASE.x + 1.5, BASE.y + 0.6, BASE.z + 1),
    new THREE.Vector3(BASE.x + 0.4, BASE.y + 0.9, (BASE.z + HEAD.z) / 2 + 1),
    new THREE.Vector3(HEAD.x - 0.4, HEAD.y + 0.4, (BASE.z + HEAD.z) / 2 - 1),
    new THREE.Vector3(HEAD.x - 1.5, HEAD.y, HEAD.z - 1),
  ],
  false,
  "catmullrom",
  0.5,
);

/** Decodes the fixture's real base64-encoded PAYMENT-REQUIRED header -- same technique as lib/replay-fixtures.ts's private decodeBase64Json. */
function decodeBase64Json(header: string): unknown {
  const binary = atob(header);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

interface PaymentRequired {
  x402Version: number;
  accepts: [{ scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra?: { merchantName?: string } }];
}

const PAYMENT_REQUIRED = decodeBase64Json(researchbotCleanApprove.headers.paymentRequiredHeader) as PaymentRequired;
const ACCEPTED = PAYMENT_REQUIRED.accepts[0];
const AMOUNT_RUPEES = (Number(ACCEPTED.amount) / 100).toFixed(2);
const MERCHANT_NAME = ACCEPTED.extra?.merchantName ?? ACCEPTED.payTo;
const UPI_INTENT = `upi://pay?${new URLSearchParams({
  pa: ACCEPTED.payTo,
  pn: MERCHANT_NAME,
  am: AMOUNT_RUPEES,
  cu: ACCEPTED.asset,
}).toString()}`;

// The exact real-field subset Bridge.tsx's card displayed, real values substituted in.
const HEADER_DISPLAY = {
  x402Version: PAYMENT_REQUIRED.x402Version,
  accepts: [
    {
      scheme: ACCEPTED.scheme,
      network: ACCEPTED.network,
      amount: ACCEPTED.amount,
      asset: ACCEPTED.asset,
      payTo: ACCEPTED.payTo,
      maxTimeoutSeconds: ACCEPTED.maxTimeoutSeconds,
    },
  ],
};

function createHeaderTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 640;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = CARD_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

  ctx.fillStyle = PRIMARY;
  ctx.font = `bold 22px ${MONO_FONT}`;
  ctx.textBaseline = "top";
  ctx.fillText("PAYMENT-REQUIRED", 32, 36, canvas.width - 64);

  ctx.fillStyle = FOREGROUND;
  ctx.font = `20px ${MONO_FONT}`;
  const json = JSON.stringify(HEADER_DISPLAY, null, 2);
  let y = 96;
  const lineHeight = 26;
  for (const line of json.split("\n")) {
    ctx.fillText(line, 32, y, canvas.width - 64);
    y += lineHeight;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const TRAIL_COUNT = 30;
const TRAIL_SPACING = 0.01;
const PRIMARY_COLOR = new THREE.Color(PRIMARY);

function PacketTrail() {
  const pointsRef = useRef<THREE.Points>(null);
  const geometryRef = useRef<THREE.BufferGeometry>(null);

  const { positions, colors } = useMemo(() => {
    return {
      positions: new Float32Array(TRAIL_COUNT * 3),
      colors: new Float32Array(TRAIL_COUNT * 3),
    };
  }, []);

  useFrame(() => {
    const geometry = geometryRef.current;
    if (!geometry) return;

    const t = progressStore.value;
    const local = zoneLocalProgress(ZONE_INDEX, t);
    const isNear = t > ZONE_START - VISIBLE_MARGIN && t < ZONE_END + VISIBLE_MARGIN;
    if (pointsRef.current) pointsRef.current.visible = isNear;
    if (!isNear) return;

    const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = geometry.attributes.color as THREE.BufferAttribute;

    for (let i = 0; i < TRAIL_COUNT; i++) {
      const sampleT = THREE.MathUtils.clamp(local - i * TRAIL_SPACING, 0, 1);
      const point = packetCurve.getPointAt(sampleT);
      positionAttr.setXYZ(i, point.x, point.y, point.z);

      const falloff = 1 - i / TRAIL_COUNT;
      colorAttr.setXYZ(i, PRIMARY_COLOR.r * falloff, PRIMARY_COLOR.g * falloff, PRIMARY_COLOR.b * falloff);
    }
    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry ref={geometryRef}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.06} vertexColors transparent opacity={0.85} sizeAttenuation depthWrite={false} />
    </points>
  );
}

export function BridgeZone() {
  const groupRef = useRef<Group>(null);
  const cardRef = useRef<Mesh>(null);
  const shaderMaterialRef = useRef<THREE.ShaderMaterial & { uHeaderTex: THREE.Texture; uQrTex: THREE.Texture; uProgress: number; uAccent: THREE.Color }>(null);
  // Both canvas textures are created client-side only (document.createElement
  // isn't available during Next's server render of this "use client"
  // component) -- built once ready, not at render time.
  const [headerTexture, setHeaderTexture] = useState<THREE.CanvasTexture | null>(null);
  const [qrTexture, setQrTexture] = useState<THREE.CanvasTexture | null>(null);

  useEffect(() => {
    setHeaderTexture(createHeaderTexture());
  }, []);

  // A CALLBACK ref, not a plain useRef -- QRCodeCanvas is portaled by drei's
  // <Html> (react-dom rendering into a real DOM node it manages), which
  // commits on a separate tick from this component's own R3F-reconciled
  // mount. A one-time mount effect reading a plain ref's .current would race
  // that portal and find it still null (confirmed: the qr uniform stayed
  // stuck on the material's 1x1 placeholder texture). A callback ref instead
  // fires exactly when the canvas node actually attaches, whenever that is.
  const setQrCanvasEl = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    setQrTexture(texture);
  };

  useEffect(() => {
    if (shaderMaterialRef.current && headerTexture) {
      shaderMaterialRef.current.uHeaderTex = headerTexture;
    }
  }, [headerTexture]);

  useEffect(() => {
    if (shaderMaterialRef.current && qrTexture) {
      shaderMaterialRef.current.uQrTex = qrTexture;
    }
  }, [qrTexture]);

  useFrame(({ camera }) => {
    const group = groupRef.current;
    const card = cardRef.current;
    if (!group || !card) return;

    const t = progressStore.value;
    const isNear = t > ZONE_START - VISIBLE_MARGIN && t < ZONE_END + VISIBLE_MARGIN;
    group.visible = isNear;
    if (!isNear) return;

    const local = zoneLocalProgress(ZONE_INDEX, t);
    const point = packetCurve.getPointAt(local);
    card.position.copy(point);
    card.lookAt(camera.position);

    const dissolve = THREE.MathUtils.clamp((local - DISSOLVE_START) / (DISSOLVE_END - DISSOLVE_START), 0, 1);
    if (shaderMaterialRef.current) {
      shaderMaterialRef.current.uProgress = dissolve;
    }
  });

  return (
    <group ref={groupRef}>
      <PacketTrail />

      <mesh ref={cardRef}>
        <boxGeometry args={[1.6, 2, 0.06]} />
        <meshStandardMaterial attach="material-0" color={CARD_BORDER} />
        <meshStandardMaterial attach="material-1" color={CARD_BORDER} />
        <meshStandardMaterial attach="material-2" color={CARD_BORDER} />
        <meshStandardMaterial attach="material-3" color={CARD_BORDER} />
        {/* material-4 is the +z face. Object3D.lookAt has a documented quirk
            (three.js's Object3D.lookAt source, non-camera/light branch):
            unlike a camera (whose local -Z points at the lookAt target), a
            plain Object3D/Mesh's local +Z ends up pointing at the target --
            confirmed against three.js's own Object3D.js source after the
            shader face rendered solid black while a debug <img> of the same
            texture (appended straight to the DOM) proved the texture content
            itself was fine. So the shader goes on +Z (material-4), not -Z. */}
        <packetDissolveMaterial ref={shaderMaterialRef} attach="material-4" />
        <meshStandardMaterial attach="material-5" color={CARD_BORDER} />
      </mesh>

      {/* Hidden QRCodeCanvas -- the same qrcode.react library Bridge.tsx used
          for <QRCodeSVG>, canvas variant, so the real UPI intent gets
          rasterized into an actual <canvas> element we can wrap as a
          CanvasTexture. Must go through drei's <Html> (not a raw
          ReactDOM.createPortal): this component is rendered inside R3F's own
          custom reconciler tree (Scene -> BridgeZone), and a plain portal
          called from there still gets reconciled by R3F's THREE-namespace
          renderer rather than react-dom, since createPortal only supplies the
          target DOM node, not a different renderer -- confirmed the hard way,
          it throws "Canvas is not part of the THREE namespace" (R3F trying to
          instantiate QRCodeCanvas's internal <canvas> tag as a THREE object;
          the capitalized "Canvas" in that message is R3F's own namespace-
          lookup capitalization of the lowercase "canvas" tag, not this file's
          <Canvas>). <Html> exists specifically to bridge the two renderers
          correctly. display:none is fine: 2D canvas drawing happens on the JS
          draw calls themselves, independent of layout/paint. */}
      <Html>
        <div style={{ display: "none" }}>
          <QRCodeCanvas ref={setQrCanvasEl} value={UPI_INTENT} size={512} bgColor="#ffffff" fgColor="#0e0e11" level="M" marginSize={2} />
        </div>
      </Html>

      <Html transform position={[BASE.x, BASE.y + 2.4, BASE.z]} occlude={false} className="pointer-events-none select-none">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-foreground">the bridge</p>
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">raw protocol → rupee-settled payment</p>
        </div>
      </Html>
    </group>
  );
}
