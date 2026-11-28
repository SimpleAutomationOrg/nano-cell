---
order: 3
title: Steps
when: writing or changing a step, the loop, or — when a step needs something the engine lacks — the viewer's code
---

# Steps: programming what the robot does

What you work with:

- `applications/<application>/steps/<name>.ts` — one file per step: it
  exports `name`, `tool`, `entry` and the default async function, and
  imports the cell API as `from 'microfactory'`.
- `"loop"` in `applications/<application>/application.json` — the
  application's loop: the steps of one cycle, in order. A step in the loop
  starts where the one before it left the arm and the parts, not at its
  own `entry`.
- `recipes/` — follow the matching recipe before writing a new step
  (`suction-pick-place.md`, `holder-insertion.md`); when a new motion
  pattern settles, add a recipe for it.
- `viewer/cell.d.ts` — the step API, with its contracts.
- `viewer/` — the engine. New motion behaviour goes in `planner.js` (pure,
  tested), never in `cell-host.js`.

Rules (the full versions are in CLAUDE.md and AGENTS.md):

- Steps state intent; the planner plans. `transitTip` for transfers,
  explicit moves only near contact and slow.
- Suction grasps through `ctx.h.suctionGrasp`, cup parallel to the face.
- Measure geometry, never assume it; place the held part, never the cup.
- Deliberate contact names exactly what it touches in `ignore`.
- Simulate only what is worth seeing; fine fits are placed, not simulated.
- After any change run `./scripts/check.sh`. When you fix a motion bug,
  add an assertion for it in the same change.

You cannot run a step yourself: after a change, ask the user to run the
step (or the loop) and tell you what the status line says. A rejected move
names the colliding link, the item and the fix — ask for that text.

Do not commit or push.
