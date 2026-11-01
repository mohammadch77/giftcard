# DESIGN_REFERENCES.md

Status v0.2 — **registry and availability audit only.** Final design has NOT started and will not until all six references are provided and reviewed.

## What I actually have access to (audited against the full conversation and the repository)
The repository is empty. In the conversation I received **text descriptions only** — no source code, no files, no URLs, no screenshots, for any reference. The table separates what is *registered by name/description* from what is *available as code*.

| # | Reference | Registered as | Source code available to me? | What I know (from your descriptions) | Compatibility checked? |
|---|---|---|---|---|---|
| 1 | Soda — GetLayers E-commerce template | named in both master prompts | **No** | nothing beyond the name | **No** |
| 2 | Hero Section with Media — Redrob Labs (21st.dev) | named; dependencies summarised in master prompt v1 §12 | **No** | uses React; a local `cx` utility; a local icons utility; custom `rr-hero*` CSS classes | **No** — I have not seen `cx`, the icons module, or the CSS, so I cannot confirm or deny compatibility |
| 3 | Bento Grid (21st.dev / Aceternity) | named; dependencies summarised in master prompt v1 §12 | **No** | uses Tailwind CSS; `@radix-ui/react-icons`; shadcn `Button`; `cn` from `lib/utils` | **No** — the `Button`/`cn`/icon dependencies are *expected* to be satisfiable by a shadcn setup, but nothing has been inspected |
| 4 | Spotlight Card | named as pending (master prompt v2) | **No** | — | No |
| 5 | Display Cards | named as pending | **No** | — | No |
| 6 | Sidebar + Dashboard | named as pending | **No** | — | No |

Note on consistency with the earlier brief: the first brief said "three provided / three pending" and the second brief renumbers them 1–6 with the same three provided (Soda, Hero, Bento) and pending Spotlight Card, Display Cards, Sidebar + Dashboard. This document follows the second brief. In both, "provided" meant *named and described*, not *code delivered into the session*. If you pasted code earlier in a different session, it is not visible in this one — please re-send it.

## What I need from you (per reference)
1. The full source of the component file(s), plus every local helper it imports (`cx`, icons module, etc.) and its CSS (all `rr-hero*` rules, keyframes, variables).
2. Asset files (images/video/fonts) or their intended replacements.
3. Original URL and **licence** (Soda/GetLayers: free or paid? — the brief forbids paid templates without approval; 21st.dev/Aceternity components: usage terms).
4. Whether #6 serves admin, customer dashboard, or both.

## Inspection sheet (to complete per component on receipt — nothing filled yet)
dependencies · imports · props · CSS requirements · responsiveness · accessibility · RTL behaviour (physical `left/right`, transforms, gradients, marquee direction) · motion & `prefers-reduced-motion` · client/server component needs · Tailwind v3/v4 syntax · licence · required project prerequisites · proposed adaptation.

## Prerequisites expected from the project (not yet created — no scaffold)
Tailwind configured with design tokens; shadcn initialised (provides `components/ui/button.tsx`); `lib/utils.ts` exporting `cn` (clsx + tailwind-merge); `@radix-ui/react-icons` only if Bento is kept as supplied; self-hosted Vazirmatn/Inter; logical-property CSS conventions for RTL.

## Integration rules (unchanged)
Preserve each component's behaviour; do not replace or invent substitutes; port supplied CSS/utilities as-is first and adapt tokens afterwards; document every deviation with a technical reason; store-specific content (Steam, PlayStation, Xbox, Nintendo, Spotify, Discord …) is supplied via props, never hard-coded from demo text. Visual integration happens in Phase 5 only.
