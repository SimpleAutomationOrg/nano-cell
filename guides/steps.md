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

## Running and debugging a step

Run it yourself, in the real simulation, in the viewer the user has open:

```
node scripts/run-step.mjs <application> <step> [<step> …]   # these, back to back
node scripts/run-step.mjs <application> --loop              # the whole loop
```

- By default the scene is reset first, so every run starts the same way;
  `--keep` carries on from how the last run left the parts (use it to see
  what a SECOND run of the same step does — e.g. the second part landing
  on the first).
- `--shot` saves two pictures of the scene after the run and prints their
  paths: the whole cell from the front, and a close-up framed on the tool
  and the parts that moved. Open them with Read — the close-up is where a
  part sitting crooked, floating or sunk into another one shows.
- Exit 0 and `DONE` means every step ran to its end. That is not yet
  "correct": read "parts no longer where the layout put them" and check
  each part is where the step meant to put it (x, y, and z — a part at
  z below the table or inside another part is a bug even when the run says
  DONE).
- `FAILED at <step>: <error>` is the viewer's own message. A rejected move
  names the colliding link, the item and the fix (usually the id to add to
  `ignore`). "found nothing to land on" means the descent ran out before
  touching anything: check the spot is over the breadboard or a fixture
  and within reach, and the log line above it for how far it went.
- The log shows each command with what the planner chose; the last line
  before a failure is where to look.
- Step files are read fresh on every run. In the installed app, changes
  to `layout.json`, items or grippers reach the viewer only after it
  reloads, which waits until you have finished answering: the command
  warns when a run used the old ones — then tell the user what you
  changed and ask them to send a message so you can run it again.
- Work in a loop: run, read, fix, run again, until it is DONE with the
  parts in the right places. Then run the whole loop once.

Do not commit or push.
