# dvt-01 arm-right (London, November 2026): sources of `cell.json` and the meshes

Regenerate: `tools/regen.sh` (STEP -> meshes -> `cell.json` -> checks -> renders -> this file). `tools/` and the files named below are in the assets repository and on the bench machine, not here; `<bench>/` stands for the bench machine's data root (provenance only). Units below are mm and degrees unless marked; `cell.json` itself is metres and radians.

## Frames

- **table**: the breadboard frame of the cell's calibration (`x`, `y` along the hole lattice, `z` up from the plate top). London's plate (MB6090) covers x 300..1200; the origin stays where the 1200 mm plate had it.
- **flange**: the DH flange of the cell's kinematics (profile `arms.right.kinematic_calibration`, convention `modified_dh_hayati`): origin on the robot flange face, +z out of it, flange pin on +y. The guard's tool records (`grippers.right.catalog[].tool_volume`) are in this frame.
- **URDF**: on the public `fairino3_v6.urdf` the DH base is `base_link` and the DH flange is `wrist3_link` moved +0.1 m along its z (checked numerically over random joint vectors: constant to 0.5 mm, the cell's nominal link lengths differ from the URDF's by that much).
- **rpy**: `R = Rz(yaw) Ry(pitch) Rx(roll)`. **Meshes**: z-up, metres, in the frame their pose places; GLB data is not converted to y-up.

## Arm

- `arm.mount_table` = profile `arms.right.kinematic_calibration.mount.table_from_arm_base` x `.base` (the arm base as the London fit `arm-right/london1113bh` placed it): {'xyz_m': [1.125275, 0.525131, 0.011541], 'rpy': [-0.001892, -0.00137, -0.396466]}.
- `arm.mount_table_profile` = `mount.table_from_arm_base` alone (= `arms.right.mount`: x_mm, y_mm, z_mm, roll/pitch/yaw_deg): {'xyz_m': [1.124641, 0.525182, 0.013273], 'rpy': [0.003182, -0.002777, -0.38714]}. The fit's base correction is 0.53 deg about z; with the URDF on the profile mount the flange is up to 4.8 mm off the cell's own poses, on `mount_table` up to 1.3 mm.
- `arm.calibrated_chain`: the profile's fitted chain copied whole (joints: alpha, a, beta, theta, d, harmonic errors), with its formula. `tools/cellkin.py` evaluates it; every joint-space record below was turned into a pose with it.
- `arm.start_deg`: London plan `q_start` (`<bench>/dvt01-tasks` branch `london-sealed`, `pickplace/script/plan.json`).

## CAD -> flange (flange stack and tools)

All assembled tool STEPs share one CAD frame (that of `changer_bare.step`). Source of the placement: profile `grippers.right.catalog[5].tool_volume.source.mount` (`screwdriver_p0`; the same text is in `changer_bare_p0`):

> changer_bare: mating face at [153.6267, -47.2464, -63.2326] mm, normal [0.0, 0.0, -1.0]; pin hole at [128.6267, -47.2464, -63.2326] mm on the flange pin (+y); m12_5pin: {"transform_mm":[[1.0,0.0,0.0,0.0],[0.0,0.0,1.0,-30.0],[0.0,-1.0,0.0,-12.0],[0.0,0.0,0.0,1.0]]}; m12_8pin_envelope: {"transform_mm":[[1.0,0.0,0.0,0.0],[0.0,1.0,0 ...

- mating face point -> flange origin, face normal -> flange -z, pin hole -> flange +y, then arm-right's clocking **p0** = a half turn about the flange axis (`dvt01-probe-cal-1021/tools/right1109_rack.py` `TURN_P0 @ FL_FROM_CAD`; owner 11-08: the camera reads upright with flange -x down).
- **C** (flange <- CAD, mm): [0, -1, 0, -47.2464]; [1, 0, 0, -153.627]; [0, 0, 1, 63.2326]
- **S** (changer CAD <- screwdriver CAD, from the same `source.mount` text, `screwdriver: {"on":"changer_bare","transform_mm":...}`); **C . S**: [1, 0, 0, -5.79004]; [0, 1, 0, -2.3e-05]; [0, 0, 1, 65.7]
- **M** (flange <- plug CAD, `m12_5pin: {"transform_mm":...}`, given in the flange frame: the robot's own plug does not turn with p0): [1, 0, 0, 0]; [0, 0, 1, -30]; [0, -1, 0, -12]
- Check: every vertex of the CAD placed this way lies inside the profile's guard pieces of the same tool (table below, column "outside guard"), so the placement is the one coordd's guard runs.

## Fixture and part frames

- A fixture's mesh frame is the frame its touch registration reports (`T_table_fixture`, `dvt01-probe-cal-1021/tools/fixture_id.py` `load_parts`: table = T . R_cad . v).
- **R45**: `<bench>/pcb-fixture/case_R_plate_from_step.npy` = [0.707107, 0, -0.707107; 0, 1, 0; 0.707107, 0, 0.707107] (the stack's CAD is drawn lying; this stands it at 45 deg).
- **U**: [1, 0, 0, 0; 0, -1, 0, 22.893; 0, 0, -1, 13.76] mm, the turn between `pcb-fixture/stl-button-last2/solid_0.stl` and `solid_0_up.stl` (the spec `runs/fixture_id/button_clip_r1108.json` uses the latter).
- Rotations in the registration files carry 5 decimals; they are re-orthonormalised (SVD) before the rpy is taken.

## Items

| id | mesh | STEP: parts | mesh frame | pose |
|---|---|---|---|---|
| `ft_sensor` | `meshes/ft_sensor.glb` | `Fairino_custom4_MicroFactory_Luxonis_my_test1__TOUCH.STEP`: `Force_sense_6axis_75mm_my1` | CAD -> flange by **C** (below) | flange frame, identity |
| `adapter` | `meshes/adapter.glb` | `Fairino_custom4_MicroFactory_Luxonis_my_test1__TOUCH.STEP`: `adapter1` | CAD -> flange by **C** (below) | flange frame, identity |
| `changer_master` | `meshes/changer_master.glb` | `Fairino_custom4_MicroFactory_Luxonis_my_test1__TOUCH.STEP`: `interface_50mm_act1` | CAD -> flange by **C** (below) | flange frame, identity |
| `oak_camera` | `meshes/oak_camera.glb` | `Fairino_custom4_MicroFactory_Luxonis_my_test1__TOUCH.STEP`: `Camera_stereo_NG9097` | CAD -> flange by **C** (below) | flange frame, identity |
| `m12_5pin_plug` | `meshes/m12_5pin_plug.glb` | `234947_sm01_stp.stp`: `234947_EP02` | plug CAD -> flange by **M** | flange frame, identity |
| `changer_bare_p0` | none (nothing past the flange stack) | | | tip: profile `grippers.right.catalog[0].tool_volume.contacts.tool_points[0]` (`piston_tip`) |
| `touch_p0` | `meshes/touch_p0.glb` | `Fairino_custom4_MicroFactory_Luxonis_my_test1__TOUCH.STEP`: `adapter_touch_probe2`, `interface_50mm_pas1`, `touch_probe1` | CAD -> flange by **C** (below) | flange frame, identity; tip: profile `grippers.right.catalog[1].tool_volume.contacts.tool_points[0]` (`stylus_ball`) |
| `touch_prod1_p0` | `meshes/touch_prod1_p0.glb` | `Touch_probe_prod1.STEP`: `adapter_touch_probe3_20mm_petg`, `interface_50mm_pas1`, `touch_probe1` | CAD -> flange by **C** (below) | flange frame, identity; tip: profile `grippers.right.catalog[2].tool_volume.contacts.tool_points[0]` (`stylus_ball`) |
| `rcup16_p0` | `meshes/rcup16_p0.glb` | `Vacuum_cup_case_16mm.STEP`: `interface_50mm_pas1`, `suction_cap_holder3_probe2_big`, `vacuum_cup_16mm_soft`, `vacuum_holder2` | CAD -> flange by **C** (below) | flange frame, identity; tip: profile `grippers.right.catalog[3].tool_volume.contacts.tool_points[0]` (`cup_tip`) |
| `rcup6_p0` | `meshes/rcup6_p0.glb` | `Vacuum_cup_button_6mm.STEP`: `interface_50mm_pas1`, `suction_cap_holder3_probe2_small`, `vacuum_cup_6mm_soft`, `vacuum_holder2_small` | CAD -> flange by **C** (below) | flange frame, identity; tip: profile `grippers.right.catalog[4].tool_volume.contacts.tool_points[0]` (`cup_tip`) |
| `screwdriver_p0` | `meshes/screwdriver_p0.glb` | `Assem_sts3032_fdm1_simple_test2.STEP`: `SLOKY_4mm`, `STS3032_holder2`, `Spring_OD15_L10_Wire0p8_outer_trim0p2`, `bit_4mm`, `bit_holder_4mm2_short2`, `body22_simple2`, `body33_simple2`, `feetech_sts3032`, `feetech_sts3032_wheel_4mm`, `interface_50mm_pas1` | CAD -> flange by **C . S** | flange frame, identity; tip: profile `grippers.right.catalog[5].tool_volume.contacts.tool_points[0]` (`nose_face`) |
| `rack_stand0` | `meshes/rack_stand.glb` | `stand2_62.5.STEP`: `stand2_62.5` | CAD frame kept (mm -> m) | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/layout_london1116.json` `fixtures.rack_stand<i>.pose` (x, y, z, yaw; touch IDs of 11-15, pocket axis at stand z 110) |
| `rack_stand1` | `meshes/rack_stand.glb` | `stand2_62.5.STEP`: `stand2_62.5` | CAD frame kept (mm -> m) | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/layout_london1116.json` `fixtures.rack_stand<i>.pose` (x, y, z, yaw; touch IDs of 11-15, pocket axis at stand z 110) |
| `rack_stand2` | `meshes/rack_stand.glb` | `stand2_62.5.STEP`: `stand2_62.5` | CAD frame kept (mm -> m) | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/layout_london1116.json` `fixtures.rack_stand<i>.pose` (x, y, z, yaw; touch IDs of 11-15, pocket axis at stand z 110) |
| `rack_stand3` | `meshes/rack_stand.glb` | `stand2_62.5.STEP`: `stand2_62.5` | CAD frame kept (mm -> m) | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/layout_london1116.json` `fixtures.rack_stand<i>.pose` (x, y, z, yaw; touch IDs of 11-15, pocket axis at stand z 110) |
| `holder` | `meshes/holder.glb` | `Assem_holder_vacuum1.STEP`: `holder3` | CAD frame kept (mm -> m) | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/id_holder_pocket/registration.json` `T_table_fixture` (12 needle touches inside the pocket, 11-15, rms 0.027 mm) |
| `stack_north` | `meshes/stack45.glb` | `Assem_top_full__direct1_45_full.STEP`: `holder_top__direct1_45`, `matt_holder_140x83_legs_gray__long_45` | CAD turned by **R45** into the fixture frame | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/id_stack_north/registration.json` `T_table_fixture` (7 touches, 11-15, rms 0.037; y from the south stack + the plate pitch) |
| `stack_south` | `meshes/stack45.glb` | `Assem_top_full__direct1_45_full.STEP`: `holder_top__direct1_45`, `matt_holder_140x83_legs_gray__long_45` | CAD turned by **R45** into the fixture frame | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/id_stack_south/registration.json` `T_table_fixture` (10 touches, 11-15, rms 0.021) |
| `button_clip` | `meshes/button_clip.glb` | `BUTTON__LAST2.STEP`: `BUTTON__LAST2` | CAD turned by **U** (right side up) | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/id_button_clip_pocket_r3/registration.json` `T_table_fixture` (8 touches, 11-14, rms 0.042) |
| `button_plate` | none: box [0.082286, 0.072442, 0.0031] m | no CAD | measured body | `<bench>/dvt01-probe-cal-1021/runs/london1113/fixtures/id_button_plate/registration.json` `T_table_fixture` (6 touches, 11-15; x from the 11-10 touch), moved to the body's centre; size = London plan `steps[2].button_cycle.scan.plate` (`width_x_mm`, `height_y_mm`) and `plate_top_mm` (8 wall + 3 top touches, 11-06) |
| `pcb_tray` | `meshes/pcb_tray.glb` | `Assem_pcb.STEP`: `Assem_legs1`, `holder_pcb3_10x-3`, `matt_holder_160x150_legs_gray`, `screw_M6x14_rounded` | CAD frame kept (mm -> m) | `<bench>/dvt01-probe-cal-1021/runs/london1113/pcb1115/id_pcb_tray/registration.json` `T_table_fixture` (10 touches, 11-16, rms 0.013) |
| `front_case_1..6` | `meshes/front_case.glb` | `enclosure_last_case.step`: `TOP.step` | CAD frame kept | London plan `steps[0].tray` (`face_1`, `axis`, `floor_normal`, `across`, `case_t_mm`, `land_mm`) and `pick_offset_mm` |
| `back_case_1..6` | `meshes/back_case.glb` | `enclosure_last_case.step`: `BOTTOM.step` | CAD frame kept | London plan `steps[5].tray` and `pick_offset_mm` |
| `button` (unplaced) | `meshes/button.glb` | `enclosure_last_case.step`: `BUTTON.step` (surface model, 52 shells) | CAD frame kept | none recorded; region = plan `steps[2].button_cycle.region` |
| `screw_m2x8` (unplaced) | `meshes/screw_m2x8.glb` | `enclosure_last_case.step`: first `...M2x8...v1.step/Body3.step` | CAD frame kept (head at CAD z 1.0, tip at 9.0) | none; station = plan `steps[7].screw_drive.pick_over` through the calibrated chain x the screwdriver tip |

### Stacked cases

The plan's `tray` block gives the stack axis `S` (`axis`, up the 45 deg stack), the floor normal `N`, `across` (table +y) and `face_1`, the point where the cup lip seats on case 1. With `pick = N * pick_offset_mm[0] + across * pick_offset_mm[1]`:

    top(n)  = face_1 - pick + S * land_mm + S * (n - 1) * case_t_mm        (centre of case n's upper face)
    R_case  = [-N, -across, -S]                                            (columns: CAD x, y, z in the table)
    p_table = top(n) + R_case . (p_cad - (0, 0, z_min of the part's CAD))

`R_case` is the plan's own carry: flange rotation at `q_stack_hover` x inverse at `q_plate_pre` (both through the calibrated chain) is a pure 45 deg tilt, and in the holder the case lies outer face down with its button end (CAD +y) at the pocket's recess end (holder +x, table south). The back case has the same CAD frame as the front in the product, and its step shows the same tilt, so it gets the same `R_case`. Front: window face (CAD z 10.96) toward the stop, button end south. Six cases per stack: owner 11-16 (`runs/london1113/RUNBOOK_1116.md`).

### Rack and changer

- `changer.stands[i].pose_table` = the flange frame at profile `grippers.right.changer.stands[i].return_deg` through the calibrated chain: where the flange is when a tool is released into (or coupled in) that stand. A parked tool's mesh sits at exactly this pose (`tool.pose_flange` is identity). `pick_pose_table` = the same for `pick_deg` (5.0 mm higher).
- These poses match the stands' touch registrations: x, y within 3 um of `layout_london1116.json`, flange face 176.13 mm over the stand's registered z (CAD seat 105 + 7.4 + 63.23 = 175.63: the release pose stands 0.5 mm over the seat).
- `changer.unlock_output`: profile `io_outputs.changer-unlock` (high = unlocked, safe state = locked); `unlock_interlock` is the profile's list of joint poses at which the cell lets it unlock. Stand -> tool: profile `changer.stands[i].tool`. `stands[0].tool_id` is null (big cup: MISSING.md).

### Tools: vacuum, tip

- `rcup16_p0`: output `vacuum`, held input `vacuum-held` (profile `io_outputs` / `io_inputs`); `cup_radius_m` 0.00809 = outer radius of the lip circle of the cup's CAD body (rim at the free end of its axis; centre and normal alongside).
- `rcup6_p0`: output `vacuum`, held input `vacuum-held` (profile `io_outputs` / `io_inputs`); `cup_radius_m` 0.003 = outer radius of the lip circle of the cup's CAD body (rim at the free end of its axis; centre and normal alongside).
- `screwdriver_p0`: output `screwdriver-vacuum`, held input none on the cell (profile `io_outputs` / `io_inputs`); `cup_radius_m` 0.00211 = the nose bore's radius at the nose face (CAD `body22_simple2`).
- The cups are tilted (the lip normal is ~25 deg off the flange axis); the profile's `cup_tip` is the highest point of the lip, not its centre: `vacuum.lip_centre_flange_m` / `lip_normal_flange` give the CAD's lip circle.

### Cameras

`<bench>/dvt01-probe-cal-1021/runs/right1108/camcal/session_v1/fit20/camcal_fit.json` (the fit the London plan names in `front_read.camera`): colour = `models[chosen]` `K`, `D`, `flange_from_camera_mm`, size from `profile_candidate.cameras.wrist-left.intrinsics.size`; monos = `monos.left|right` (`K`, `D` factory, `flange_from_camera_mm`), 1280 x 800 (`pickplace/SEAM.md`). The cell calls the device `oak-left` (`pickplace/script/src/main.rs`). Pose = OpenCV camera frame in the flange.

### I/O, guard, table

`io`: profile `io_inputs`, `io_outputs` (names, function, bank, channel, polarity, stop behaviour). `guard`: `nano00cfg_guard_london.json` `planes` and profile `cell_envelope`. `table`: profile `work_surface` (pitch, first hole) and `<bench>/dvt01-probe-cal-1021/runs/london1113/PREP.md` (MB6090 on x 300..1200). Profile file: `nano00cfg_src_dvt01_profile.raw.json` (dvt-01, `updated_at` 2026-11-17T15:57Z).

## Source files

| key | file | sha256 (first 12) |
|---|---|---|
| stack_touch | `<bench>/dvt01-tooling/inputs/expo-1028/Fairino_custom4_MicroFactory_Luxonis_my_test1__TOUCH.STEP` | `8566f24d6d43` |
| m12_5pin | `<bench>/dvt01-tooling/inputs/expo-1028/wired1029/234947_sm01_stp.stp` | `3255d13ea1d5` |
| screwdriver | `<bench>/dvt01-tooling/inputs/screwdriver1105/Assem_sts3032_fdm1_simple_test2.STEP` | `7603b0a4c1ca` |
| touch_prod1 | `<bench>/pcb-fixture/Touch_probe_prod1.STEP` | `7079470e8b49` |
| rcup16 | `<bench>/pcb-fixture/stl-vacuum-cup-case_16mm/src/Vacuum_cup_case_16mm.STEP` | `e54820b7c463` |
| rcup6 | `<bench>/pcb-fixture/stl-vacuum-cup-button_6mm/src/Vacuum_cup_button_6mm.STEP` | `e740f623fd30` |
| stand | `<bench>/pcb-fixture/stand2_62.5.STEP` | `d9e894209ed0` |
| holder | `<bench>/pcb-fixture/Assem_holder_vacuum1.STEP` | `cd81a47a18bf` |
| stack45 | `<bench>/pcb-fixture/Assem_top_full__direct1_45_full.STEP` | `1f073ec1d5fa` |
| pcbtray | `<bench>/dvt01-tooling/inputs/Assem_pcb.STEP` | `8562fe6a2a3d` |
| button_clip | `<bench>/pcb-fixture/step-inputs/BUTTON__LAST2.STEP` | `6805183461c2` |
| enclosure | `<bench>/dvt01-tooling/inputs/buttons1106/enclosure_last_case.step` | `f53fc9c19350` |

## Mesh report (loaded back by `tools/check_cell.py`)

| file | bytes | triangles | bounds min (mm) | bounds max (mm) | note |
|---|---|---|---|---|---|
| `adapter.collision.stl` | 40284 | 804 | [-37.5, -37.5, 25.0] | [37.5, 37.5, 31.8] | 2 convex pieces; CAD outside them 0.0 mm |
| `adapter.glb` | 217184 | 5998 | [-37.5, -37.5, 25.0] | [37.5, 37.5, 31.8] | CAD mesh 9404 tris; decimated within 0.139 mm |
| `back_case.collision.stl` | 65034 | 1299 | [-23.9, -37.0, 1.0] | [23.9, 37.0, 5.7] | 9 convex pieces; CAD outside them 0.01 mm; pieces reach 1.76 mm into space the CAD leaves free |
| `back_case.glb` | 189368 | 5000 | [-23.9, -37.0, 1.0] | [23.9, 37.0, 5.7] | CAD mesh 7296 tris; decimated within 0.099 mm |
| `button.collision.stl` | 20684 | 412 | [-4.8, 14.6, 7.9] | [4.8, 31.2, 12.0] | 1 convex pieces; CAD outside them 0.0 mm |
| `button.glb` | 119328 | 3064 | [-4.8, 14.6, 7.9] | [4.9, 31.2, 12.0] | CAD mesh 5729 tris; decimated within 0.096 mm |
| `button_clip.collision.stl` | 16584 | 330 | [-6.0, -30.0, -0.0] | [6.0, 30.0, 4.1] | 10 convex pieces; CAD outside them 0.0 mm; pieces reach 1.85 mm into space the CAD leaves free |
| `button_clip.glb` | 37608 | 1044 | [-6.0, -30.0, -0.0] | [6.0, 30.0, 4.1] | CAD mesh 1044 tris; decimated within 0.0 mm |
| `changer_master.collision.stl` | 291984 | 5838 | [-25.0, -41.0, 28.8] | [39.9, 41.0, 65.4] | 19 convex pieces; CAD outside them 0.91 mm |
| `changer_master.glb` | 1490152 | 40234 | [-25.0, -41.0, 28.8] | [39.9, 41.0, 65.4] | CAD mesh 74179 tris; decimated within 0.105 mm |
| `front_case.collision.stl` | 57784 | 1154 | [-23.9, -37.0, 5.2] | [23.9, 37.0, 11.0] | 12 convex pieces; CAD outside them 0.01 mm; pieces reach 2.33 mm into space the CAD leaves free |
| `front_case.glb` | 258080 | 7000 | [-23.9, -37.0, 5.2] | [23.9, 37.0, 11.0] | CAD mesh 7782 tris; decimated within 0.059 mm |
| `ft_sensor.collision.stl` | 59484 | 1188 | [-40.3, -43.0, -2.5] | [80.0, 43.0, 27.0] | 3 convex pieces; CAD outside them 0.0 mm |
| `ft_sensor.glb` | 491420 | 12000 | [-40.3, -43.0, -2.5] | [80.0, 43.0, 27.0] | CAD mesh 12884 tris; decimated within 0.047 mm |
| `holder.collision.stl` | 86134 | 1721 | [-40.1, -26.9, 3.0] | [40.3, 27.1, 16.0] | 11 convex pieces; CAD outside them 0.01 mm; pieces reach 1.6 mm into space the CAD leaves free |
| `holder.glb` | 88392 | 2876 | [-40.1, -26.9, 3.0] | [40.3, 27.1, 16.0] | CAD mesh 2876 tris; decimated within 0.0 mm |
| `m12_5pin_plug.collision.stl` | 20784 | 414 | [-10.0, -73.0, -41.8] | [10.0, -30.0, -2.0] | 1 convex pieces; CAD outside them 0.0 mm |
| `m12_5pin_plug.glb` | 703724 | 20000 | [-10.0, -73.0, -41.8] | [10.0, -30.0, -2.0] | CAD mesh 42174 tris; decimated within 0.269 mm |
| `oak_camera.collision.stl` | 111984 | 2238 | [41.4, -55.5, 7.0] | [81.4, 55.5, 38.3] | 7 convex pieces; CAD outside them 0.0 mm |
| `oak_camera.glb` | 2604864 | 73770 | [41.4, -55.5, 7.0] | [81.4, 55.5, 38.3] | CAD mesh 209874 tris; decimated within 0.245 mm |
| `pcb_tray.collision.stl` | 309834 | 6195 | [-108.1, -76.7, -9.2] | [108.1, 76.7, 13.0] | 15 convex pieces; CAD outside them 0.01 mm; pieces reach 3.61 mm into space the CAD leaves free |
| `pcb_tray.glb` | 827900 | 24064 | [-108.1, -76.7, -9.2] | [108.1, 76.7, 13.1] | CAD mesh 43132 tris; decimated within 0.131 mm |
| `rack_stand.collision.stl` | 228784 | 4574 | [-31.4, -31.6, -0.4] | [31.4, 31.6, 110.4] | 20 convex pieces; CAD outside them 0.0 mm; pieces reach 4.88 mm into space the CAD leaves free |
| `rack_stand.glb` | 284140 | 9000 | [-31.0, -31.2, -0.0] | [31.0, 31.2, 110.0] | CAD mesh 21014 tris; decimated within 0.141 mm |
| `rcup16_p0.collision.stl` | 144484 | 2888 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 156.5] | 8 convex pieces; CAD outside them 0.0 mm |
| `rcup16_p0.glb` | 1278388 | 33828 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 156.5] | CAD mesh 50104 tris; decimated within 0.106 mm |
| `rcup6_p0.collision.stl` | 184834 | 3695 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 154.4] | 8 convex pieces; CAD outside them 0.0 mm |
| `rcup6_p0.glb` | 1291136 | 34100 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 154.4] | CAD mesh 49570 tris; decimated within 0.104 mm |
| `screw_m2x8.collision.stl` | 22584 | 450 | [17.6, 30.4, 1.0] | [21.4, 34.2, 9.0] | 1 convex pieces; CAD outside them 0.0 mm |
| `screw_m2x8.glb` | 106748 | 2876 | [17.6, 30.4, 1.0] | [21.4, 34.2, 9.0] | CAD mesh 2876 tris; decimated within 0.0 mm |
| `screwdriver_p0.collision.stl` | 520284 | 10404 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 155.6] | 21 convex pieces; CAD outside them 0.0 mm |
| `screwdriver_p0.glb` | 2414016 | 58370 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 155.7] | CAD mesh 128846 tris; decimated within 0.21 mm |
| `stack45.collision.stl` | 83834 | 1675 | [-154.2, -43.5, -23.0] | [9.8, 42.5, 91.7] | 15 convex pieces; CAD outside them 0.02 mm; pieces reach 3.28 mm into space the CAD leaves free |
| `stack45.glb` | 234500 | 7462 | [-154.2, -43.5, -23.0] | [9.8, 42.5, 91.7] | CAD mesh 7462 tris; decimated within 0.0 mm |
| `touch_p0.collision.stl` | 160434 | 3207 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 135.4] | 10 convex pieces; CAD outside them 0.0 mm |
| `touch_p0.glb` | 1171260 | 28828 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 135.4] | CAD mesh 38634 tris; decimated within 0.064 mm |
| `touch_prod1_p0.collision.stl` | 183484 | 3668 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 155.4] | 11 convex pieces; CAD outside them 0.0 mm |
| `touch_prod1_p0.glb` | 1190168 | 31614 | [-25.0, -25.0, 46.5] | [39.9, 25.0, 155.4] | CAD mesh 48232 tris; decimated within 0.089 mm |

Total: 17.61 MB.

Collision pieces: tool bodies = convex hulls of 1 mm slices along the flange axis, joined while convex (hollows closed); other bodies = one hull per CAD body; fixtures and cases = approximate convex decomposition (CoACD). The decomposed pieces are approximations: where a pocket's fit matters (holder pocket: 0.1 mm a side; stand slot) seat by pose, not by collision.

## Tool tip check

Profile contact point against the tool's own mesh (flange frame, mm). "to hull" = signed distance to the mesh's convex hull (negative = inside).

| tool | point | tip | to mesh surface | to hull | CAD outside guard pieces |
|---|---|---|---|---|---|
| `changer_bare_p0` | piston_tip | [0.0, 0.0, 65.43] | 4.941 | 0.03 | 0.0 |
| `touch_p0` | stylus_ball | [0.0, 0.0, 134.43] | 0.991 | -0.991 | 0.0 |
| `touch_prod1_p0` | stylus_ball | [0.0, 0.0, 154.433] | 0.978 | -0.978 | 0.0 |
| `rcup16_p0` | cup_tip | [16.259, 0.122, 156.291] | 0.064 | -0.09 | 0.0 |
| `rcup6_p0` | cup_tip | [20.885, 0.021, 154.21] | 0.024 | -0.024 | 0.0 |
| `screwdriver_p0` | nose_face | [-0.102, -0.156, 155.97] | 1.497 | 0.326 | 0.0 |

## Parked tools and stacked cases

Visual (CAD) meshes at their `cell.json` poses, mm. The last column is the same test against the fixture's convex collision pieces: it shows how far those pieces close a pocket the part sits in.

| pair | closest distance | deepest point inside the fixture's CAD | deepest point inside its collision pieces |
|---|---|---|---|
| `rcup16_p0` parked in stand 1 | 0.001 | 0.751 | 3.8 |
| `screwdriver_p0` parked in stand 2 | 0.154 | 0.0 | 3.77 |
| `rcup6_p0` parked in stand 3 | 0.001 | 0.753 | 3.67 |
| `front_case_1` on its tray | 0.0 | 0.011 | 0.38 |
| `front_case_2` on its tray | 0.003 | 0.011 | 0.03 |
| `front_case_3` on its tray | 0.004 | 0.011 | 0.03 |
| `front_case_4` on its tray | 0.003 | 0.011 | 0.03 |
| `front_case_5` on its tray | 0.004 | 0.01 | 0.03 |
| `front_case_6` on its tray | 0.003 | 0.011 | 0.03 |
| `back_case_1` on its tray | 0.078 | 0.0 | 0.24 |
| `back_case_2` on its tray | 0.078 | 0.0 | 0.0 |
| `back_case_3` on its tray | 0.079 | 0.0 | 0.0 |
| `back_case_4` on its tray | 0.078 | 0.0 | 0.0 |
| `back_case_5` on its tray | 0.078 | 0.0 | 0.0 |
| `back_case_6` on its tray | 0.078 | 0.0 | 0.0 |
| a front case seated in the `holder` pocket (outer face on the floor, button end at the recess) | 0.0 | 0.0 | 0.87 |

The cups' 0.75 mm inside the stand CAD is the reprinted slot (MISSING.md). The stand's collision pieces close its 5 mm deep pocket by up to ~3.8 mm and the holder's close the pocket's lead-in by ~0.9 mm: a parked tool or a seated case overlaps those pieces, so park and seat by pose and do not let that pair collide.

URDF on `arm.mount_table` vs the calibrated chain at the four stand poses: [0.49, 0.67, 1.12, 0.88] mm.

Renders (pyrender, offline): `renders/overview.png`, `overview_top.png`, `overview_rack.png`, `overview_fixtures.png`, `tool_<id>.png`. The arm links and the plate slab in them are drawn for context from the public URDF and `table.size_m`; they are not assets of this cell.
