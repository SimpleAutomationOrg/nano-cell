# dvt-01 arm-right (London): what is not in `cell.json`, and what each item needs

Rule of this data set: a shape is in `cell.json` only when it comes from the owner's CAD or from a recorded
measurement. Items below have no CAD, no pose, or a CAD that is known to differ from the mounted hardware.
All coordinates are table frame, millimetres, unless a frame is named.

## Left out: no CAD

| Item | What is recorded | What is needed |
|---|---|---|
| **Big cup tool `bigcup_p0`** (rack stand 0, the final product pick) | Profile catalog entry 6; tip `cup_tip` at flange (0, 0, 163.568). Its guard record is a construction, not CAD: the 16 mm cup body with the 25 deg pipe "straightened onto the tool axis" plus `DP40_suction_cup.step` (profile `tool_volume.source.construction`). Stand 0's pose is in `changer.stands[0]` with `tool_id: null`. | A STEP of the assembled big-cup tool on its changer half (as `Vacuum_cup_case_16mm.STEP` is for the medium cup), in the changer frame. |
| **Screw feeder** (third party) | Padded envelope 650..830 x 395..610 x 0..158 (camera triangulation, heights +-6 mm; `layout_london1116.json` `envelopes[feeder]`). Disc centre (735.7, 435.5, 73.4). Pick station: the screwdriver nose is aimed at `unplaced_parts[screw_m2x8].pick_station_xy_table_m` (London plan `screw_drive.pick_over` through the calibrated chain), disc top z 78.4 (`screw_map_plan.disc_z`). Top strip touched at z 150.8..151.4. Obstacle boxes the London planner used (x0, y0, x1, y1, top z): (669.4, 489.2, 796.4, 614.7, 150.9), (730.9, 467.2, 780.9, 493.2, 101.4), (703.9, 413.2, 718.9, 433.7, 90.4), (749.9, 412.2, 761.9, 433.7, 90.4), (727.9, 429.2, 743.9, 444.2, 88.4). | Vendor STEP or a scan, then one registration of it to the touched strip and the pick pocket. |
| **Lamp** (backlight the parts are read over; cases are pressed flat on its top) | Envelope 939..1139 x 211..411 x 0..36 (`envelopes[lamp]`: "200 mm housing", lit disc centre ~(1039, 311) from a camera look). Top touched: 33.8..35.3 on 11-09, ball z 34.7 / 34.9 / 36.5 in London (ball radius 1.0 to subtract). | STEP of the lamp housing and its lit window; a touch registration of the housing edges (only the top was touched). |
| **PCB (the board with its display)** | No CAD anywhere on the bench: the planner used four hand-made boxes (`pcbplan1104.py board_meshes_cad`). Slots are known: tray CAD, 2 holders x 10 slots at holder y = -67.5 + 15 k mm; London picked "holder 2 index 0", cup lip at (818.5, 303.88, 102.38) pressing toward -x. Place: two pegs at (880.758, 114.051, 11.466) and (919.758, 114.009, 11.466). | The board's STEP (outline, display, connector, the two peg holes) and which face points west in the tray. |
| **Assembly holder base plate** (the 11-08 print the pocket is screwed to) | Owner 11-08: ear holes at +-50 / +-12.5 mm, ears 4 mm thick. `Assem_holder_vacuum1.STEP` holds the earlier base (`matt_holder_81x55_legs_gray2`, ears at +-62.5) and was not used. The pocket body (`holder`) is in `cell.json` and starts 3 mm above the plate. | STEP of the 11-08 base. |
| **PCB tray standoffs** | The tray CAD's own legs put the table at CAD z -5; in London the tray stood on 60 mm standoffs (tray origin at z 61.879). | Standoff STEP (or diameter and the four positions: anchors at tray (+-100, +-62.5)). |
| **Breadboard mesh** | London plate = Thorlabs MB6090/M on x 300..1200, y 0..600 of the table frame (`runs/london1113/PREP.md`); counterbores at (325, 25) (325, 575) (750, 300) (1175, 25) (1175, 575). Only `MB60120_M.step` (the 1200 mm plate of the office setup) is on the bench. `table.size_m` is given without a mesh. | `MB6090_M.step` (public vendor CAD). |
| **Arm mounting plate** | The arm base frame sits 11.5 mm (fitted) / 13.3 mm (profile mount) above the plate top; no CAD of the sub-plate. | STEP of the plate under the arm. |
| **Wrist plugs and cables** | In the guard as envelopes only (`env_m12_8pin.step`: flange x -90..-40, y +-10, z -22..-2; `env_oak_m12.step`: flange (51..71, -50..-30, -40.9..9.1)). The blue vacuum tube, the OAK Ethernet cable, the touch probe's USB-C plug and all hoses are unmodelled. The F/T sensor's 5-pin plug IS included (vendor CAD). | Vendor CAD of the 8-pin tool plug and the OAK's M12 plug; nothing can stand in for hoses. |
| **Calibration balls B2, B3** | Ball centres (1187.503, 112.512, 32.197) and (1187.345, 337.472, 32.125), radius 12.7 (`runs/london1113/inputs/balls.json`); B1 was removed in London. Their posts have no CAD. | Post STEP; the spheres themselves are fully described by the numbers here. |
| **Cell enclosure** | The guard's numbers are in `cell.json` `guard` (operator barrier y >= -150 mm, right wall opened by 60 mm). No CAD of the London box; the frame post of the office setup was not there (owner 11-15). | Enclosure CAD if walls should be drawn. |
| **arm-left** | A second FR3 stood at the table's left end (profile `arms.left.mount`: 200.157, 524.035, 11.596, yaw 112.125 deg; uncalibrated new unit, parked folded at (65.5, -79.2, -120.4, -95.7, -9.6, -0.1) deg, tool `snap_holder` from `FR3_Unruggable_snap_holder.STEP`). Not part of the arm-right cell and not in the guard record used here. | A decision whether the simulated cell shows it. |

## Included, but the CAD differs from the mounted hardware

| Item | Difference | Needed |
|---|---|---|
| **Rack stands** (`rack_stand0..3`, `stand2_62.5.STEP`, 11-09) | The stands were reprinted on 11-10 with a wider neck slot: touched 32.56..32.65 mm, CAD 30.5 mm. The cup tools' necks are 32.0 mm wide, so a parked cup tool overlaps the CAD slot walls by ~0.75 mm a side (the check reports it). | STEP of the reprinted stand. |
| **Case stacks** (`stack_north`, `stack_south`, `Assem_top_full__direct1_45_full.STEP`) | Owner 11-08: the mounted prints have a flat 45 deg slope with no centre cutout; the CAD still has the floor channel (stack frame x -118.7..-41.5, y -20.5..19.75). The cases bridge it (47.8 mm wide over a 40 mm channel). | STEP of the flat-slope revision. |
| **Button plate** (`button_plate`) | No CAD: only its touch-measured body is given (82.286 x 72.442 x 3.1 mm box, `mesh: null`, `collision: "box"`). Its four screw ears and printed surface are not described. | STEP of the plate. |
| **Button clip** (`button_clip`, `BUTTON__LAST2.STEP`) | The STEP is drawn upside down relative to how the clip is mounted; the mesh is the STEP turned 180 deg about its x (the pose the pocket touches confirm: floor touched at 1.8, CAD 2.0). | Nothing, unless the owner disagrees with the flip. |

## Poses and numbers that are not recorded

- **Buttons**: lie loose on the button plate, pin up, at any heading; the cell finds each with the camera and no London
  read is stored on the bench. `unplaced_parts[button]` gives the mesh, the plate region the planner used and the
  plate-top height. Needed: a stored camera read, or the builder scatters them.
- **Screws**: one M2x8 sits in the feeder's pick pocket; without the feeder there is nothing to rest it on.
  `unplaced_parts[screw_m2x8]` gives the mesh and the station.
- **Case count**: `parts` holds 6 front and 6 back cases (owner 11-16: at most 6 per stack for the fast descent). The
  sealed plan allows up to 24; how many were loaded for a given run is not recorded.
- **Masses**: nothing was weighed. Case masses in `parts` are CAD volume x 2700 kg/m3 (the CAD names the enclosure
  aluminium). Tools have no `mass_kg`: the only measurement is the wrist F/T fit of everything past the sensor with
  the bare changer, 228 +- 32 g (London, 11-14) and 177 +- 18 g (11-09). Needed: a scale reading per tool and part.
- **Changer "locked" / "tool present" input**: the cell has none (`changer.locked_input: null`); the real cell
  confirms a swap by weight. The screwdriver's vacuum (`screwdriver-vacuum`, pump B) has no "held" switch either.
- **Camera in London**: the London re-fit of the hand-eye was rejected for light level (rms 25.7 px); the cell kept
  the 11-08 fit, which is what `cameras` carries. The mono cameras use factory intrinsics.
- **Which tool was on the arm**: `mounted_tool` is the profile's last record (`screwdriver_p0`); every London run
  started and ended on the medium cup (`demo_start_tool`).
