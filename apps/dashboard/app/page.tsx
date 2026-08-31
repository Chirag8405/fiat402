"use client";

/**
 * Public scrollytelling showcase at "/" -- a cinematic walkthrough of the
 * fiat402 protocol, built on top of the same components and visual language
 * as the real, passcode-gated control tower at /console (moved there from
 * this path -- see middleware.ts / lib/console-auth.ts).
 *
 * ZERO REAL BACKEND CALLS FROM THIS PAGE, EVER: nothing here imports or
 * triggers /api/simulate, /api/confirm-gate, or /api/decline. Section 5
 * ("Live proof") embeds the real StateMachineViz/DecisionPanel/AgentConsole/
 * RawTrafficViewer components, but drives them entirely from the three
 * captured fixtures in fixtures/*.json (see lib/replay-fixtures.ts) via
 * AgentConsole's `replaySource` prop and DecisionPanel's `interactive={false}`
 * prop -- both additive, opt-in props on those shared components that leave
 * /console's own live behavior completely unchanged when unset. Sections 1-4
 * and 6-7 use only static/sample markup or verbatim source excerpts, never
 * live state.
 */

import { ScrollProvider } from "../components/showcase/ScrollProvider";
import { ColdOpen } from "../components/showcase/ColdOpen";
import { OldWay } from "../components/showcase/OldWay";
import { Bridge } from "../components/showcase/Bridge";
import { HumanMoment } from "../components/showcase/HumanMoment";
import { LiveProof } from "../components/showcase/LiveProof";
import { CodeSection } from "../components/showcase/CodeSection";
import { Close } from "../components/showcase/Close";

export default function ShowcasePage() {
  return (
    <ScrollProvider>
      <main className="bg-background">
        <ColdOpen />
        <OldWay />
        <Bridge />
        <HumanMoment />
        <LiveProof />
        <CodeSection />
        <Close />
      </main>
    </ScrollProvider>
  );
}
