# comfy/ — the generation backend driver

Sprite GENERATION happens on a local ComfyUI server; everything after
generation (matte → slice → resample → crush → publish) is the existing
sprite-forge pipeline and did not move. This folder is only the bridge.

Research + model approval trail: the 2026-08-03 report
(claude.ai/code/artifact/706bb106-3eac-4876-bfcb-27bcf231bad0) and the
`comfyui-sprite-pipeline-research` memory.

## The backend (lives OUTSIDE the repo, on the WSL box)

    ~/comfy/ComfyUI        headless ComfyUI checkout (+ venv at ~/comfy/venv)
    ~/comfy/run.sh -d      start   (127.0.0.1:8188; log ~/comfy/comfy.log)
    ~/comfy/stop.sh        stop
    ~/comfy/ComfyUI/models/{unet,text_encoders,vae,loras}   the weights

`run.sh` carries `--disable-pinned-memory` — WSL2 caps pinned host memory
and cudaHostRegister is unsupported; without the flag model load can OOM
the distro (Comfy-Org/ComfyUI#11531).

### THE WSL CAP HAS TO FIT UNDER THE WINDOWS BASELINE

`.wslconfig` also lives outside the repo, and its number has been wrong for
three days. Measured 2026-08-08, host total minus `vmmemWSL`'s working set:

    Windows alone   27.3 GB   chrome 10.8 (40 procs), IDE 5.9, vivaldi 3.9,
                              Obsidian 2.1, + OS
    WSL cap         40   GB
                    -------
    worst case      67.3 GB   guard HARD 62.5, physical 63.9

**The cap was larger than the machine.** Any run that filled WSL's allowance had
to cross the ceiling — arithmetic, not luck. And a Wan run fills it without
trying: two GGUF experts at 11.2 GB each is **22.4 GB of reads per run**, and
Linux caches every byte. `free` reports that cache as AVAILABLE because it is
reclaimable, so nothing inside WSL looks wrong, while Windows counts the balloon
as used and the guard stops ComfyUI.

Traced on a real attack clip, sampling every 3s:

    host used     35.32 → 60.65 GB   (+25.3)
    comfy RSS      1.02 → 11.11 GB   (+10.1)
    wsl available 31.28 → 23.50 GB   (-7.8 ONLY)

Now `memory=32GB` (worst case 59.3) and `autoMemoryReclaim=dropcache` — the
`gradual` setting returns only what the VM has already freed, and reclaimable
page cache is never "freed", which is exactly the memory that pushes the host
over.

⚠️ **The cap is a function of the Windows baseline, which grows as apps are
added.** If the guard starts striking again, re-measure the baseline before
touching anything else:

    host used (Win32_OperatingSystem)  −  (Get-Process vmmemWSL).WorkingSet64

`guard.mjs` was retuned for this same drift on 2026-08-05 and `.wslconfig` was
not, which is how the two came to disagree about the machine.

### THE RETAINED-RSS LEAK — it is glibc, not ComfyUI

`run.sh` lives outside the repo, so the reasoning is duplicated here rather
than lost with it. It now exports:

    MALLOC_ARENA_MAX=2
    MALLOC_TRIM_THRESHOLD_=131072
    MALLOC_MMAP_THRESHOLD_=131072

**The symptom** (measured 2026-08-05, `docs/POSE_IS_THE_LATENT.md`): after ~10h
and a run of qwen jobs the python process held **13.1 GB RSS with every model
already unloaded**. `--disable-smart-memory` works, the `VRAM_Debug` purge node
works, `/free` works — the VRAM genuinely is released. What does not happen is
the host allocator returning those pages to the kernel.

**The cause.** glibc keeps freed memory in the heap for reuse and only trims
when the *top* of the heap has more than `M_TRIM_THRESHOLD` contiguous free
space, which a fragmented multi-GB heap essentially never has. Worse, every
thread that allocates can get its own arena (up to 8 × cores) and torch spawns
plenty — free memory stranded in one arena cannot serve another, so the process
grows monotonically. Setting the two `_`-suffixed variables also disables
glibc's *dynamic* tuning, which otherwise raises the thresholds as it observes
large allocations, i.e. adapts toward hoarding on exactly this workload.

**Why it matters here and not elsewhere.** A server that has been up a while
sits high on system RAM while idle, so the NEXT run starts with no headroom and
the guard strikes it. That is the whole of "bounce ComfyUI before a Wan run" —
a workaround for this, not a property of Wan.

**Baseline to compare against:** a freshly started server with zero jobs is
**1.03 GB**. If an idle server is far above that after a session, the trim is
not working and the next thing to check is whether these variables actually
reached the process:

    tr '\0' '\n' < /proc/$(cat ~/comfy/comfy.pid)/environ | grep MALLOC

Custom nodes installed: ComfyUI-GGUF (required loader for every model
below), KJNodes, VideoHelperSuite.

Models (all Apache-2.0 / commercial-clean; ~45 GB):

| file (models/…) | role |
|---|---|
| unet/qwen-image-edit-2511-Q4_K_M.gguf | rotation / identity-preserving edits |
| unet/Wan2.2-I2V-A14B-{High,Low}Noise-Q6_K.gguf | animation (two-expert MoE) |
| text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors | Qwen TE |
| text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors | Wan TE |
| vae/qwen_image_vae.safetensors, vae/wan_2.1_vae.safetensors | VAEs |
| loras/pixel_walk_lora_v1_high_noise.safetensors | pix3lwalk (Civitai 2172038, Sell-granted) |
| loras/wan2.2_pixel_animate_adapter.safetensors | styly-agents pixel-animate |
| loras/tarn59_pixel_art_style_qwen.safetensors | pixel style for Qwen leg |

## Using it

    node cli.mjs stats
    node cli.mjs rotate  --init frame.png --to "left"
    node cli.mjs animate --init frame.png --action "walking"   # 21 PNG frames
    node cli.mjs edit    --init frame.png --prompt "raise the sword overhead"

Outputs land in `../work/comfy/<run>/` (gitignored). They are SOFT
high-res frames by design — no open model emits a true pixel grid, so the
contract is generate-large-then-crush, and the crush stays in sprite-forge
(one canonical reduce + palette snap for imported AND generated art).
Assemble frames into a sheet, drop it in `inbox/`, `npm run sprites`.

Init images: upscale the source frame (nearest) to ~512-1024 px on a plain
background first — every working sprite model expects big soft input, not
raw 32-128 px art. `prep/` has the tooling.

## Contracts and failure modes

- `client.mjs` polls `/history`; a sampler error is rethrown with the
  server's own payload — never reported as "no outputs".
- `cli.mjs` runs `assertNodes()` before queueing: a missing/renamed node
  class (ComfyUI renames things across releases) fails by NAME instead of
  an opaque 400.
- Node class names live ONLY in `graphs.mjs`.
- This is a manual tool. Nothing under vitest may reach the network, so no
  `.test.ts` here may import the server side of this folder.
