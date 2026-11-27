// Types for steps. The runtime is viewer/cell-host.js (plain JS);
// these declarations exist for editor IntelliSense and type checking.

/** [x, y, z] in metres, TABLE frame unless stated otherwise. */
export type Vec3 = [number, number, number];

/** 4x4 row-major pose matrix in the TABLE frame (metres, radians). */
export type Mat4 = number[];

/** A pose: a Mat4, or {xyz_m, rpy} with URDF fixed-axis rpy (Rz·Ry·Rx). */
export type Pose = Mat4 | { xyz_m: Vec3; rpy: Vec3 };

export interface MoveOpts {
  /**
   * TIP speed for the move, metres per second. Default 1.0 (full speed).
   * The FR3's per-joint velocity limits (3.15/3.2 rad/s) are always
   * respected on top, so reorientation-heavy moves can't become instant.
   * Use small values for deliberate approaches (e.g. 0.03 = 30 mm/s).
   */
  speed?: number;
  /**
   * Item ids whose contact is deliberate and must not reject the move
   * (e.g. the part being touched, its stack). 'guard' skips the envelope.
   * The held part is always ignored.
   */
  ignore?: string[];
  /**
   * 'free' (default): rotation about the tool axis is unconstrained — the
   * solver keeps the wrist near its current spin (right for suction cups).
   * 'exact': honor the pose's full orientation, including yaw (needed when
   * the spin about the tool axis matters, e.g. driving a screw bit).
   */
  spin?: 'free' | 'exact';
}

export interface LinearMoveOpts extends MoveOpts {
  /** IK waypoints approximating the straight line (default 6). */
  waypoints?: number;
}

export interface TransitOpts extends MoveOpts {
  /** Height margin above the tallest obstacle, metres (default 0.10). */
  clearance?: number;
  /**
   * 'free' (default): arrival spin about the tool axis is unconstrained.
   * 'exact': the transfer ARRIVES at the pose's exact yaw — use when the
   * following placement needs the held part aligned (e.g. into a pocket).
   * Interior waypoints always spin free either way.
   */
  spin?: 'free' | 'exact';
}

/**
 * The cell as seen by a step. Every move resolves when the motion has
 * finished animating, and is collision-checked BEFORE it runs: a predicted
 * contact rejects the command with the culprit's name.
 */
export interface CellAPI {
  /** Current joint angles, degrees, J1..J6. */
  joints(): number[];

  /** Id of the part currently held on the flange, or null. */
  held(): string | null;

  /**
   * The held part's frame expressed in the TIP (cup) frame, or null when
   * empty. Placement must align the PART with its target, not the cup:
   * the grasp spin follows the camera policy, so the part hangs at an
   * arbitrary rotation under the cup.
   */
  heldInTip(): Mat4 | null;

  /**
   * Azimuth (rad, table frame) of the held part's LONG footprint axis,
   * were the cup at `cupPose` — measured from collision samples. Use with
   * the target's `topLongAxis` to align a part with a pocket.
   */
  heldFootprintAzimuth(cupPose: Mat4): number | null;

  /**
   * The held part's footprint centre (xy centroid) and lowest point, in
   * the table frame, were the cup at `cupPose`. Centre placements on
   * this, not on the tip — the cup grips the part wherever the grasp
   * touched, which is not the part's centre.
   */
  heldFootprintCenter(cupPose: Mat4): { x: number; y: number; z_min: number } | null;

  /**
   * The cup pose that hangs the HELD PART square to, and centred over, a
   * target's top opening, `height` metres above its rim — ready for
   * `transitTip(pose, { spin: 'exact' })` followed by a touch descent.
   * It aligns the part's measured long axis with the target's, picks —
   * of the two 180°-apart yaws that fit a rectangle — the one the wrist
   * reaches with less turning, and centres the part's footprint (never
   * the cup) on `topCenter`.
   * Use this for every placement instead of building the pose by hand.
   */
  heldPoseOver(target: CellItem, height: number): Mat4;

  /**
   * Move all joints to absolute angles (degrees). One interpolated leg.
   * Joint-space command: takes `speedDps` (deg/s, default 180 = full)
   * instead of a tip speed.
   */
  moveJointsDeg(targetDeg: number[], opts?: { speedDps?: number; ignore?: string[] }): Promise<void>;

  /** Move the FLANGE to a table-frame pose (IK from the current pose). */
  moveFlange(pose: Pose, opts?: MoveOpts): Promise<void>;

  /** Move the mounted tool's TIP to a table-frame pose (IK, tip offset applied). */
  moveTip(pose: Pose, opts?: MoveOpts): Promise<void>;

  /** Straight-line tip move by a table-frame delta [dx, dy, dz] metres. */
  moveTipBy(d: Vec3, opts?: LinearMoveOpts): Promise<void>;

  /**
   * Collision-avoiding transfer: straight lift above the tallest obstacle,
   * transfer at height with the reorientation blended into the travel
   * (J6 sweeps linearly), straight descent onto the target tip pose.
   */
  transitTip(pose: Pose, opts?: TransitOpts): Promise<void>;

  /**
   * Contact-seeking move: advance the tip along `dir` (table frame) until
   * the held part or the tool touches a non-ignored item, then stop.
   * Resolves with what was touched and the distance travelled — so a
   * set-down needs no computed height: it stops on the pocket floor or
   * on whatever is already in the pocket. Contact detection resolution
   * is ~4 mm (collision sampling pitch).
   */
  moveUntilTouch(dir: Vec3, opts?: {
    speed?: number; maxDist?: number;
    /**
     * Blind zone: contacts are ignored before this travel (metres). Use
     * when inserting into a pocket whose lateral clearance is below the
     * touch tolerance — the rim would otherwise read as support.
     */
    minDist?: number;
    ignore?: string[];
  }): Promise<{ dist_m: number; item: string | null }>;

  /** Set a named digital IO point (e.g. 'vacuum'). */
  setIO(name: string, value: boolean): Promise<void>;

  /** Attach a part to the flange (it moves with the arm; leaves the obstacle world). */
  grasp(partId: string): Promise<void>;

  /** Detach the held part where it is (it rejoins the obstacle world). */
  release(): Promise<void>;

  /** Wait, scaled by playback speed and pausable. */
  waitMs(ms: number): Promise<void>;

  /** Write a line to the step log. */
  log(msg: string): void;
}

/** A fixture or part resolved from the application. */
export interface CellItem {
  id: string;
  name: string;
  /** The pose recorded in application.json (load time — may be stale). */
  pose: { xyz_m: Vec3; rpy: Vec3 };
  /**
   * The item's CURRENT table-frame pose, read from the scene — parts move
   * between runs, so select targets from this, never from hardcoded ids.
   */
  matrix: Mat4;
  /**
   * Centroid of the item's top rim (table frame) — for a pocket or tray,
   * the cavity centre. Fixture ORIGINS are CAD datums that may sit outside
   * the working geometry: place onto topCenter, not onto matPos(matrix).
   */
  topCenter: Vec3;
  /**
   * Azimuth (rad, table frame) of the item's top-rim LONG footprint axis,
   * measured from its collision samples. Align placements with this —
   * frame labels (x vs y) are arbitrary per CAD part.
   */
  topLongAxis: number;
  /** The three.js node in the scene (null if not rendered). */
  node: unknown;
}

export interface Helpers {
  /**
   * Suction-grasp pose for an item: the cup face PARALLEL to the part
   * surface — tool axis anti-parallel to the face's outward normal, tip at
   * `standoff` metres along it. Always grasp through this helper (approach
   * with a larger standoff, touch with ~0.002), never at an angle.
   * `face` is the part-frame axis of the exposed face ('-z' for the cell_fr3
   * cases, which lie flipped on the 45° stack).
   */
  suctionGrasp(item: CellItem, standoff: number, face?: '+x' | '-x' | '+y' | '-y' | '+z' | '-z',
    lean?: [number, number] | null): Mat4;
  /**
   * The pose re-spun about its tool axis so the tool BODY leans toward
   * `dir` (table-frame xy) — steer the bent-stem lean out of slots and
   * away from walls. Honor the result with spin:'exact'.
   */
  withLean(pose: Mat4, dir: [number, number] | number[]): Mat4;
  /**
   * The pose re-spun so the wrist camera sits parallel to the breadboard
   * (level horizon, image looking down). This is suctionGrasp's default
   * spin policy; `preferLean` breaks the 180° tie toward a safe lean side.
   */
  withCameraLevel(pose: Mat4, preferLean?: [number, number] | null): Mat4;
  /** Azimuth (rad, table frame) the tool body leans toward at this pose. */
  leanAzimuth(pose: Mat4): number;
  /** Pose at `point` whose z-axis is `zdir` (x chosen stably). */
  poseFacing(point: Vec3 | number[], zdir: Vec3 | number[]): Mat4;
  /** Pose at `point` with the tool axis pointing straight down. */
  poseZDown(point: Vec3 | number[], yawRad?: number): Mat4;
  /** Translation of a matrix. */
  matPos(m: Mat4): Vec3;
  /** Column i (0=x, 1=y, 2=z) of a matrix's rotation. */
  matAxis(m: Mat4, i: 0 | 1 | 2): Vec3;
  /** Matrix product a · b. */
  matMul(a: Mat4, b: Mat4): Mat4;
  add(a: number[], b: number[]): number[];
  scale(a: number[], k: number): number[];
  neg(a: number[]): number[];
  /** Degrees → radians. */
  deg(d: number): number;
}

export interface Ctx {
  /** The composed cell: the robot with the application set up on it (viewer/cell-data.js). */
  cell: Record<string, unknown>;
  /** Look up a part by id (throws if unknown). */
  part(id: string): CellItem;
  /** Look up a fixture by id (throws if unknown). */
  fixture(id: string): CellItem;
  /**
   * The part to pick next from a stack: of the listed parts still on it,
   * the EXPOSED one (frontmost along its outward face). Chosen from live
   * positions, never by id, so a step can be re-run. Throws when the
   * stack is empty.
   */
  nextOnStack(stackId: string, partIds: string[]): CellItem;
  h: Helpers;
}

/** Joint pose the arm snaps to when the step starts. */
export interface Entry {
  joints_deg: number[];
}

/** A step module's default export. */
export type Step = (cell: CellAPI, ctx: Ctx) => Promise<void>;
