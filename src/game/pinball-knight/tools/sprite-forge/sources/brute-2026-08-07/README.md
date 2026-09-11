# brute, 2026-08-07 — the Ragnarok restyle. Curated, published, REVERTED.

> ⚠️ **THIS ART IS NOT SHIPPED AND SHOULD NOT BE.** It was curated into three
> sheets and published on 2026-08-07, looked at, and rejected: the frames are
> smooth anti-aliased illustration that the crush turns to mush, and the idle
> clip changes by 14% frame to frame against the shipped sheet's 63% — a still.
> `public/sprites/brute-S` is back to the `55f98e2` gym zombie.
>
> Kept as evidence and as inputs. The recipes below record exactly what was
> picked and on what, which is why the failure is attributable to the
> GENERATION rather than to the picking. The replacement pipeline is
> `../../docs/PLAN_KEYFRAME_PIPELINE.md`.

Three masters, eleven generated motion clips, three more `stumble` clips added
on 08-07, and the three recipes that turn them into sheets. TRACKED because
`work/comfy/` is gitignored and that is exactly how the 2026-08-06 build lost
the source frames for its own `attack` row.

    00_master_S.png   the styled front master   (qwen edit,   seed 11)
    01_master_E.png   rotated to the side       (qwen rotate, seed 11)
    01_master_N.png   rotated to the back       (qwen rotate, seed 11)
    clip_<DIR>_<CLIP>/  the 6-frame cull, plus every frame a recipe picks
    recipe-<DIR>.json   what shipped, and what it was picked on

## The recipe

    # STYLE BY EXAMPLE, not by adjective. PROMPTS.md measured that stronger
    # pixel-art wording makes every metric WORSE: capitals asking for no-AA /
    # flat fills / <=16 colours produced 301,541 distinct colours, entries
    # 26.6->30.7, isolated 41.5->47.8, matte keyed 79.2%->61.3%.
    cli.mjs edit --init ../brute-2026-08-06/00_master_idle.png \
                 --ref <one idle cell cropped from inbox/zombie-E.png> \
                 --prompt "Redraw this character as clean pixel art, a hulking
                           gym-buff zombie brute, same pose, same size, same
                           position. Match the pixel art style, palette and
                           proportions of Figure 2." --seed 11

    cli.mjs rotate  --init 00_master_S.png --to right|back --seed 11
    cli.mjs animate --init <master> --preset walk|idle|attack|death \
                    --frames 21 --tile 96 --seed 11

Both other facings branch off the ONE approved master, never off each other —
Qwen-Image-Edit's identity drift compounds over serial edits.

The style reference is the repo's own Ragnarok zombie sheet, the brute's
literal ancestor, cropped to a single idle cell.

## What is missing, and why it is not blocking

`clip_E_idle` — the run died on a guard strike. Not blocking: idle is normally
picked from the WALK clip's quietest frames anyway, which is what
`prep-brute.mjs` did deliberately ("Wan's 'walk' for a creature this heavy is a
weight-shifting stomp, and its quietest frames ARE the idle sway"), and it
guarantees the two clips share a body.

`run` is deliberately NOT generated: `alias()` hands it the walk frames by
reference at the run frame rate — see `RUNTIME_COVERED` in build-plan.ts.

**`stumble` WAS in that list and has been generated after all.** The synthesis
`withRecoil()` performs is three reframes of idle frame 0 (a shove and a tilt,
`stumbleFrames` in cel-painter.ts) — the same body, jostled. That is a fine
default for a creature nobody has looked at, and it is what shipped; watching
it, the user's verdict was that getting hurt "is still not working correctly",
which is the honest read: a jostled idle is not a reaction. Three real frames
now sit in `clip_<DIR>_stumble/`.

## THE FRAMES HERE ARE A FIRST CULL, NOT A CURATION

Each clip generated 21 frames; 6 are kept, evenly strided from frame 8 on.
64MB -> 21MB, because 234 raw frames is not something to put in a repo forever.

Wan spends its first ~6-8 frames easing out of the init (measured in
`55f98e2`: idle settled at 8, attack at 7, walk at 6), so the head of every
clip is near-duplicates of the master and unusable regardless.

STRIDED rather than scored, deliberately: `c4d9477` records that a scored
auto-picker was written and DELETED because it ranked the crisp init frame
worst — it was not measuring the defect it claimed to. A human still has to
look at these and pick 2-6 per clip.

## THE CURATION, AND WHAT IT WAS PICKED ON

`recipe-S.json`, `recipe-E.json`, `recipe-N.json` are the record: which frame
tags went into which row, and why. Rebuild any facing with

    node ../../prep/prep-clips.mjs report recipe-S.json     # the numbers
    node ../../prep/prep-clips.mjs build  recipe-S.json out.png

Every pick is a frame from the FULL 21, not from the 6-frame cull above — the
cull is a strided sample and the extremes of a stride are not on a stride.
Three instruments decided them, none of them taste:

  · `gaitSignals` LEAN (drift.ts) — leg weight left minus right, below the hip.
    A walk row wants the two extremes and two passes; S runs +0.090 / +0.015 /
    -0.082 / -0.036 and E runs +0.129 / +0.030 / -0.100 / -0.006.
    **N never crosses zero** (-0.014 .. -0.077 across all 21): from behind, the
    legs are inside the silhouette, so its row is a sway out and back instead.
  · BBOX — what tells an attack from a pose. S's swing is the frame where the
    box jumps 465 -> 498 wide; N's is 411 -> 517. Stumble is the same read: the
    body compresses and widens, 478x588 -> 482x556 -> 502x546.
  · `ghosting()` — Wan's translucent smears. Every transition frame in every
    death clip is one (g49840 / g8121 / g14949) and every one is skipped.

`clip_E_idle` is the walk's two quietest frames, as predicted above.

## DO NOT PUBLISH A PARTIAL SET

This brute is a green orc-like creature; the one deployed at `c772aeb` is grey
and armoured. An E sheet in the new style over an old-style S would make the
creature CHANGE SPECIES when it turns — strictly worse than the missing-facing
bug it fixes. All three facings land together.

And it is not only facings. A sheet that omits a CLIP does the same thing one
axis over: `paintsFor` merges imported over painted per clip, so the 3-row
sheet that shipped before this pass died as the old painted brute every single
time. That is the bug this drop exists to close — see
`published.test.ts`'s coverage table, which said `brute 3/18 rows · facings S ·
no E/N art · NO DEATH` and is the before-picture.

## Box notes, both measured the hard way

**`--frames 33` trips the RAM guard.** It took WSL under the 2.5GiB-sustained
floor and the guard HARD-stopped ComfyUI mid-run. 21 frames at `--tile 96`
completes in 236-360s. One clip (E/idle) still died to a strike at 21 frames,
so it is close to the edge — re-run a single clip rather than assuming a whole
block will survive.

**Bounce ComfyUI before any Wan block.** It was holding 13.8GB retained RSS
after 5.8h of qwen work; restarting returned 19 -> 33GB free. And start the
guard with it — a SOFT strike writes NO file and surfaces only as a bare
`execution_interrupted` plus one line in `~/comfy/guard.log`.
