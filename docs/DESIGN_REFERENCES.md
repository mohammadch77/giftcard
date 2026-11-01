# DESIGN_REFERENCES.md

Status: **registry only.** No component source code has been supplied into the repository or this conversation yet — only names/sources and (from the earlier brief) a summary of dependencies. Therefore **no compatibility inspection has been performed**, and none is claimed. Final design is deferred to Phase 5, after all six references are received and reviewed.

| # | Reference | Source | Intended use (provisional) | Status |
|---|---|---|---|---|
| 1 | Soda — GetLayers E-commerce template | GetLayers | layout/UX reference for store pages | name only; no files; **licence/terms unverified** |
| 2 | Hero Section with Media — Redrob Labs | 21st.dev | homepage hero (provisional) | name only; code not received |
| 3 | Bento Grid | 21st.dev / Aceternity | gaming category/platform grid (provisional) | name only; code not received |
| 4 | Spotlight Card | — | **pending** | not provided |
| 5 | Display Cards | — | **pending** | not provided |
| 6 | Sidebar + Dashboard | — | admin/customer dashboard shell (provisional) | not provided |

## Known dependency notes (from the brief — unverified until code is provided)
**Hero (#2)** — React; local `cx` utility; local icons utility; custom `rr-hero*` CSS classes.
- To verify on receipt: contents of `cx` (class joiner, likely replaceable by shadcn `cn` — only if behaviour is identical), icons module (which icons, SVG vs library), full `rr-hero` CSS (variables, keyframes, media queries), any fonts/images/video, RTL behaviour (physical `left/right`, `translateX`, gradients, marquee direction), `prefers-reduced-motion`, a11y of media (alt, controls, autoplay policy), client-component needs (`"use client"`).
- Do not silently replace its custom CSS/utilities; port them as-is first, then adapt tokens.

**Bento Grid (#3)** — Tailwind CSS; `@radix-ui/react-icons`; shadcn `Button`; `cn` from `lib/utils`.
- Requires: `components/ui/button.tsx` (shadcn), `lib/utils.ts` exporting `cn` (clsx + tailwind-merge), `@radix-ui/react-icons`, Tailwind config including its paths and any custom animation/keyframes the Aceternity original defines.
- To verify: Tailwind v3 vs v4 class syntax compatibility, grid breakpoints, card heights on mobile, RTL (`col-start`, `rounded-l-*`, `text-left`), hover-only affordances (touch), keyboard focus, content slots for category cards.
- Content: replace generic demo features with real categories/platforms (Steam, PlayStation, Xbox, Nintendo, Spotify, Discord, …) — to be defined with the owner.

**Soda (#1)** — template reference; check licence (paid/free?) before copying any assets/code. **Brief says no paid templates without approval.**

## Integration plan (Phase 5, after all six are in)
1. Receive full source for each (component file + utils + CSS + assets).
2. Per component, fill an inspection sheet: dependencies, imports, props, CSS, responsiveness, a11y, RTL, motion, licence.
3. Scaffold shared prerequisites once: Tailwind config + CSS variable tokens, `lib/utils.ts (cn)`, shadcn `Button`, font setup.
4. Place under `src/ui/` as presentational components (no domain logic); content passed via props; store content lives in the feature layer.
5. Adapt colours/typography/spacing to tokens; convert physical to logical CSS properties; add `prefers-reduced-motion`; verify at 360/768/1280 px in RTL and LTR.
6. Record any deviation from the original with a technical reason.

## Open points
- Provide the actual code (paste or files) for each reference when ready.
- Confirm licence/permission for Soda/GetLayers and each 21st.dev component.
- Confirm whether #6 (Sidebar + Dashboard) serves admin, customer dashboard, or both.
