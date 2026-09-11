# Hamster in Exercise Ball Monster Sprite Sheet Archive

- **Date**: 2026-09-10
- **Subject**: Hamster in Exercise Ball monster (`hamster_ball`), a cute chubby hamster sprinting inside a transparent plastic exercise sphere.
- **Mechanics**:
  - Normal player mode (`p.momSpeed <= 0`): damages the player on touch.
  - Pinball mode (`p.momSpeed > 0`): acts as a kinetic bumper deflector, knocking the pinball with high rebound velocity into unpredictable directions.
  - Death: sphere shatters into ricocheting plastic shards.
- **Primary Source**: `src/game/pinball-knight/tools/sprite-forge/sources/hamster-ball-2026-09-10/hamster_ball-S.png`
- **Layout**: 4 columns × 4 rows (16 frames, 1024×1024, 256×256 per cell)
  - Row 0 (0..3): `idle` (4 frames: hamster sniffing, scurrying feet inside the transparent plastic sphere, subtle plastic ball wobble/gleam)
  - Row 1 (4..7): `walk` (4 frames: running rapidly in ball, exercise ball rolling forward with rotating seams/highlights)
  - Row 2 (8..11): `attack` (4 frames: high-speed ram charge, spinning in place then blasting forward with kinetic energy)
  - Row 3 (12..15): `death` (4 frames: high impact collision, plastic cracks, sphere shatters into tumbling plastic shards, dizzy hamster)
- **Chroma Background**: `#00FF00` bright green
- **Takes Archive**:
  - `alt-takes/hamster_ball_sheet_1789080713785.jpg` (Master Take)
