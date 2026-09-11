# Implementation Plan — Restore Full ForgePanel Dashboard & Benchmark Tab to Port 5176

**Target Project**: `sprite-forge` (`https://github.com/LazyCat420/sprite-forge.git`)  
**Target URL**: `http://10.0.0.16:5176` (and `http://10.0.0.16:5176/forge`)  
**Date**: 2026-09-11  
**Status**: PLAN ONLY (Awaiting User Review & Approval — DO NOT IMPLEMENT YET)  
**Methodology**: Strictly compliant with [`plan-verification-standard.md`](file:///home/lazycat/github/projects/sun/.agents/plan-verification-standard.md) (VCPM Claim Triage & Quality Gates)

---

## 1. Problem Statement & Background

When opening `http://10.0.0.16:5176`, users currently see a barebones, hardcoded 5-step intake wizard (`Step1_Intake` through `Step5_ExportAtlas`) with placeholder icons. Attempting to access `http://10.0.0.16:5176/forge` returns a `404 Not Found`.

All original Sprite Forge Studio functionality — specifically:
1. **The Model Benchmark / Test Tab (`ModelTestCard.tsx`)**: Side-by-side benchmark testing for Wan 2.2, MiniMax H3, Qwen, etc.
2. **The Character Library (`LibraryCard.tsx`)**: The full roster browser displaying all 20+ animation sets, published sheets, and source takes.
3. **The In-Game Preview (`InGameCard.tsx`)**: Live in-engine rendering and capture verification.
4. **The Jobs Board (`JobsBoard.tsx`) & Sheet Tray (`SheetTray.tsx`)**: Frame collation, clip staging, auto-cut, and 20-color quantization.
5. **The ComfyUI Engine (`app/api/comfy/*`)**: Full backend routes for cluster dispatch, model downloading, and RAM clearing.

was originally developed under `braindeadbot-client` (commit `e6682f5`, branch `remotes/origin/h3-sprite-forge`). During the August 28 refactor (commit `289ad093`), the `/forge` code was removed from `braindeadbot-client`, but was never restored into the new `sprite-forge` repository on port 5176.

This plan restores the complete dashboard, all its tabs, and full asset connectivity directly to `http://10.0.0.16:5176`.

---

## 2. Atomic Claim Classification Matrix (VCPM Standard)

| ID | Claim Statement | Classification | Evidence / Source / Validation Path |
|---|---|---|---|
| `CLAIM-1` | `remotes/origin/h3-sprite-forge` in `braindeadbot-client` contains the complete, working `/forge` dashboard (`ForgePanel.tsx`, `components/forge/`, `app/api/comfy/`). | **Verified Fact** | Inspect git tree [`braindeadbot-client:components/forge`](file:///home/lazycat/github/projects/sun/braindeadbot-client) at `remotes/origin/h3-sprite-forge` |
| `CLAIM-2` | `ModelTestCard.tsx` contains the dedicated Benchmark tab for side-by-side Wan 2.2 / MiniMax H3 / Qwen testing. | **Verified Fact** | Inspect [`components/forge/ModelTestCard.tsx`](file:///home/lazycat/github/projects/sun/braindeadbot-client) on `origin/h3-sprite-forge` |
| `CLAIM-3` | `LibraryCard.tsx` provides the character roster shelf showing all 20+ animation sets across published sheets, staged inbox, and source takes. | **Verified Fact** | Inspect [`components/forge/LibraryCard.tsx`](file:///home/lazycat/github/projects/sun/braindeadbot-client) on `origin/h3-sprite-forge` |
| `CLAIM-4` | `sprite-forge` is owned by LazyCat420 (`https://github.com/LazyCat420/sprite-forge.git`) and deploys to container `sprite-forge` on port 5176. | **Verified Fact** | Inspect [`sprite-forge/docker-compose.yml`](file:///home/lazycat/github/projects/sun/sprite-forge/docker-compose.yml) and git remotes |
| `CLAIM-5` | In `sprite-forge`, only `app/page.tsx` exists; `app/forge/` does not exist, causing the 404. | **Verified Fact** | Inspect directory tree of [`sprite-forge/app/`](file:///home/lazycat/github/projects/sun/sprite-forge/app) |
| `CLAIM-6` | Mounting `pinball-knight/ThreeJS/public/sprites/` and `sources/` allows `LibraryCard` to dynamically scan and display all game animation sheets on port 5176. | **Testable Claim** | Test container volume mount in `docker-compose.yml` and query `/api/comfy/library` |

---

## 3. User Review Required (Follow-Up Questions)

> [!IMPORTANT]
> **Decision 1: Default Landing Page on Port 5176**  
> Should the restored `ForgePanel` dashboard (with the Benchmark tab, Character Library, Jobs Board, and Sheet Tray) replace the root page (`/`) on `http://10.0.0.16:5176`, or should both exist with a top navigation switcher?  
> *(Recommendation: Make `ForgePanel` the primary root `/` so typing `http://10.0.0.16:5176` immediately opens the full tool with all your animations and benchmarks, with `/forge` also aliased to it).*

> [!IMPORTANT]
> **Decision 2: Live Asset Volume Mounting on the NAS**  
> In `docker-compose.yml`, should we mount the live sprite directory from `pinball-knight` into the `sprite-forge` container?  
> *(This guarantees that whenever any new monster or animation is published in `pinball-knight`, it instantly appears on `http://10.0.0.16:5176` without having to rebuild the container).*

> [!IMPORTANT]
> **Decision 3: 3D Knight Motion Workshop Integration**  
> Would you like us to add an additional tab to `ForgePanel` that directly embeds the **Knight 3D Motion Workshop** ([`knight-motion-preview.html`](file:///home/lazycat/github/projects/sun/pinball-knight/ThreeJS/scripts/knight-motion-preview.html)), allowing you to test the 3D skeleton rig, 360-degree rotation, and WebGPU pixel shaders directly inside Sprite Forge Studio?

---

## 4. Proposed Changes

All modifications will be made strictly in a dedicated git worktree inside [`sprite-forge`](file:///home/lazycat/github/projects/sun/sprite-forge) (owned by `LazyCat420`).

### Component: Frontend UI (`components/forge/` & `app/`)

#### [NEW] [`components/ForgePanel.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/ForgePanel.tsx)
- Port the full `ForgePanel` orchestrator with its primary tabs:
  - `generate`: Task-first image generator (rotate, animate, in-between, edit, touch-up, pixelize)
  - `model-test`: **The Benchmark Tab** (`ModelTestCard`) for side-by-side prompt and speed comparison across Wan 2.2 and MiniMax H3
  - `library`: **The Character Library** (`LibraryCard`) with all character rosters, 20+ animation sheets, and source takes
  - `review`: Contact sheet frame inspection and anchor alignment
  - `sheet`: Sheet tray collation, auto-cut preview, and 20-color quantization
  - `backend`: Cluster status, model manager, memory clearing
  - *(Optional)*: `3d-rig`: Knight 3D Motion Workshop embed

#### [NEW] `components/forge/` (UI Subcomponents)
- Port from `origin/h3-sprite-forge`:
  - [`ModelTestCard.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/ModelTestCard.tsx) (Benchmark tab)
  - [`LibraryCard.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/LibraryCard.tsx) (Roster & Animation shelf)
  - [`InGameCard.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/InGameCard.tsx) (Live capture)
  - [`JobsBoard.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/JobsBoard.tsx)
  - [`SheetTray.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/SheetTray.tsx)
  - [`GenerateCard.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/GenerateCard.tsx)
  - [`IntakeCard.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/IntakeCard.tsx)
  - [`BackendCards.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/BackendCards.tsx)
  - [`MaskEditor.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/MaskEditor.tsx)
  - [`SweepBanner.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/SweepBanner.tsx)
  - [`theme.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/theme.ts), [`types.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/types.ts), [`api.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/components/forge/api.ts)

#### [MODIFY] [`app/page.tsx`](file:///home/lazycat/github/projects/sun/sprite-forge/app/page.tsx) & [NEW] `app/forge/page.tsx`
- Render `ForgePanel` on both `/` and `/forge` so navigation is seamless and no 404 can occur.

---

### Component: Backend API Engine (`app/api/comfy/`)

#### [NEW] `app/api/comfy/` Routes
Port the supporting backend API routes:
- [`app/api/comfy/library/route.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/app/api/comfy/library/route.ts): Scans sprite assets, source takes, and active jobs.
- [`app/api/comfy/modes/route.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/app/api/comfy/modes/route.ts): Mode definitions and prompts.
- [`app/api/comfy/manifest/route.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/app/api/comfy/manifest/route.ts): Model pipeline state and dependencies.
- [`app/api/comfy/pipeline/route.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/app/api/comfy/pipeline/route.ts): Slicing and palette quantization.
- [`app/api/comfy/server/route.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/app/api/comfy/server/route.ts): Cluster status and VRAM free.
- [`app/api/comfy/settings/route.ts`](file:///home/lazycat/github/projects/sun/sprite-forge/app/api/comfy/settings/route.ts): Studio configuration.

---

### Component: Docker & Deployment Configuration

#### [MODIFY] [`docker-compose.yml`](file:///home/lazycat/github/projects/sun/sprite-forge/docker-compose.yml) & [`Dockerfile`](file:///home/lazycat/github/projects/sun/sprite-forge/Dockerfile)
- Ensure all components, API routes, and required node modules build cleanly in production.
- Configure asset path mapping so the container has access to `pinball-knight` sprites and sources.

---

## 5. Verification Plan

### Automated Verification
1. **Typecheck & Build**:
   - Run `pnpm build` or `npm run build` inside `sprite-forge` to verify 0 TypeScript/Next.js compilation errors.
2. **API Endpoint Health Check**:
   - Query `curl -s http://localhost:5176/api/comfy/manifest` -> returns 200 OK with model definitions.
   - Query `curl -s http://localhost:5176/api/comfy/library` -> returns 200 OK with character roster list.

### Operational Deployment & Live Validation
1. **Deploy Container to Synology NAS**:
   - Stage and commit to git: `git commit -m "feat(studio): restore full ForgePanel dashboard, benchmark tab, and library"`
   - Push to GitHub: `git push origin main`
   - Deploy: `npm run deploy` inside `sun/sprite-forge/`
2. **Live HTTP Checks**:
   - Verify `http://10.0.0.16:5176` returns 200 OK with `ForgePanel`.
   - Verify `http://10.0.0.16:5176/forge` returns 200 OK without 404.
   - Verify the **Benchmark tab** (`Model Test`) renders and loads.
   - Verify the **Character Library tab** renders with all 20+ animation sheets and thumbnails populated.
