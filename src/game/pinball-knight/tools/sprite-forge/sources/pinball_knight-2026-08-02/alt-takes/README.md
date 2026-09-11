# Alt takes — knight, 2026-08-02

Three sheets from the same generation session as the drop one level up, kept
because they are NOT reachable from it:

| file | why it is here |
|---|---|
| `01_idle_4frames.png` | 512x1024 — a single 4-frame row, where the shipped take is 1024x1024 with the row doubled. The narrower sheet is the cleaner slice; the wider one is what `prep-knight.mjs` was tuned against. |
| `04_jump_8frames.png` | a different take of the same pose set. Neither was obviously better; the parent's is the one that shipped. |
| `08_roll_6frames.png` | superseded by `12_roll_into_marble_7frames.png`, which added the wind-up frame. No 08 exists in the parent drop at all. |
| `13_side_profile_E_red_plume_take.png` | Initial generation take with red plume on helmet; replaced by `13_side_profile_E.png` in parent drop which matches the official open-visor dark-steel helmet style. |

The other five sheets from this batch were byte-identical to the parent and are
not duplicated here. Nothing in the pipeline reads `alt-takes/` — it is an
archive, and a re-import would mean copying a file up one level.

These lived at `sun/sprites/pinball_knight/` until 2026-08-03, outside any repo
and referenced by no code. That is why they are here now: a source sheet that
only one machine has is a source sheet you have already lost.
