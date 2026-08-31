"use client";

/**
 * Fixed, full-viewport ambient layer sitting behind every section --
 * addresses the "dead scroll zone reads as broken" issue: with each
 * section's own bg-background removed (see app/page.tsx's sections), this
 * is now the ONLY thing painting the page background, so there is no scroll
 * position -- including the gaps between pinned sections -- that shows pure
 * flat color with nothing at all.
 *
 * Two static-ish layers, both barely-there by design (this is ambient
 * texture, not a foreground element):
 *   - a low-opacity dot grid (fixed, does not move with scroll)
 *   - a soft radial wash whose vertical position tracks --scroll-progress
 *     (0-1 across the whole page, written by ScrollProvider.tsx's single
 *     document-level ScrollTrigger) via a CSS calc() -- purely CSS-driven,
 *     no per-frame React work.
 */
export function AmbientBackground() {
  return <div className="ambient-background" aria-hidden="true" />;
}
