// FR3 kinematics: forward over the fairino3_v6 URDF chain, and a damped
// least-squares inverse seeded from a nearby pose (port of the kit's
// kinematics.rs inverse_near). Pure JS, 4x4 row-major arrays, no deps.

export const CHAIN = [
  { link: 'shoulder_link', xyz: [0, 0, 0],        rpy: [0, 0, 0],       lim: [-3.0543, 3.0543] },
  { link: 'upperarm_link', xyz: [0, 0, 0.14],     rpy: [1.5708, 0, 0],  lim: [-4.6251, 1.4835] },
  { link: 'forearm_link',  xyz: [-0.28, 0, 0],    rpy: [0, 0, 0],       lim: [-2.8274, 2.8274] },
  { link: 'wrist1_link',   xyz: [-0.24001, 0, 0], rpy: [0, 0, 0],       lim: [-4.6251, 1.4835] },
  { link: 'wrist2_link',   xyz: [0, 0, 0.102],    rpy: [1.5708, 0, 0],  lim: [-3.0543, 3.0543] },
  { link: 'wrist3_link',   xyz: [0, 0, 0.102],    rpy: [-1.5708, 0, 0], lim: [-3.0543, 3.0543] },
];
export const FLANGE_IN_WRIST3 = [0, 0, 0.1];

// ---------- mat4 (row-major number[16]) ----------
export const ident = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

export function mul(a, b) {
  const m = new Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      m[i * 4 + j] = s;
    }
  return m;
}

// R = Rz(yaw) · Ry(pitch) · Rx(roll), URDF fixed-axis rpy
export function fromXyzRpy(xyz, rpy) {
  const [r, p, y] = rpy;
  const [sr, cr] = [Math.sin(r), Math.cos(r)];
  const [sp, cp] = [Math.sin(p), Math.cos(p)];
  const [sy, cy] = [Math.sin(y), Math.cos(y)];
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, xyz[0],
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, xyz[1],
    -sp,     cp * sr,                cp * cr,                xyz[2],
    0, 0, 0, 1,
  ];
}

export const rotZ = q => {
  const [s, c] = [Math.sin(q), Math.cos(q)];
  return [c,-s,0,0, s,c,0,0, 0,0,1,0, 0,0,0,1];
};

export const translate = v => [1,0,0,v[0], 0,1,0,v[1], 0,0,1,v[2], 0,0,0,1];

export function invRigid(m) {
  // transpose rotation, rotate-negate translation
  const r = [m[0],m[4],m[8], m[1],m[5],m[9], m[2],m[6],m[10]];
  const t = [m[3], m[7], m[11]];
  return [
    r[0], r[1], r[2], -(r[0]*t[0] + r[1]*t[1] + r[2]*t[2]),
    r[3], r[4], r[5], -(r[3]*t[0] + r[4]*t[1] + r[5]*t[2]),
    r[6], r[7], r[8], -(r[6]*t[0] + r[7]*t[1] + r[8]*t[2]),
    0, 0, 0, 1,
  ];
}

export const pos = m => [m[3], m[7], m[11]];
export const axis = (m, i) => [m[i], m[4 + i], m[8 + i]]; // column i of R

// rotation-vector of R (log SO3), safe near 0 and pi
export function rotvec(m) {
  const w = [m[9] - m[6], m[2] - m[8], m[4] - m[1]]; // R32-R23, R13-R31, R21-R12
  const s = Math.hypot(...w) / 2;
  const c = (m[0] + m[5] + m[10] - 1) / 2;
  const th = Math.atan2(s, Math.max(-1, Math.min(1, c)));
  if (th < 1e-9) return [w[0] / 2, w[1] / 2, w[2] / 2];
  if (th > Math.PI - 1e-3) {
    // axis from the largest diagonal of (R + I) / 2
    const d = [(m[0] + 1) / 2, (m[5] + 1) / 2, (m[10] + 1) / 2];
    const k = d.indexOf(Math.max(...d));
    const a = [0, 0, 0];
    a[k] = Math.sqrt(Math.max(0, d[k]));
    const off = { 0: [m[1], m[2]], 1: [m[1], m[6]], 2: [m[2], m[6]] }[k];
    if (k === 0) { a[1] = m[1] / (2 * a[0] + 1e-12); a[2] = m[2] / (2 * a[0] + 1e-12); }
    if (k === 1) { a[0] = m[1] / (2 * a[1] + 1e-12); a[2] = m[6] / (2 * a[1] + 1e-12); }
    if (k === 2) { a[0] = m[2] / (2 * a[2] + 1e-12); a[1] = m[6] / (2 * a[2] + 1e-12); }
    const n = Math.hypot(...a) || 1;
    // sign from w when it is not fully degenerate
    const sgn = (w[0] * a[0] + w[1] * a[1] + w[2] * a[2]) < 0 ? -1 : 1;
    return a.map(v => sgn * th * v / n);
  }
  const k = th / (2 * Math.sin(th));
  return [k * w[0], k * w[1], k * w[2]];
}

// ---------- forward ----------
export function fkFlange(qRad) {
  let m = ident();
  for (let i = 0; i < 6; i++) {
    m = mul(m, fromXyzRpy(CHAIN[i].xyz, CHAIN[i].rpy));
    m = mul(m, rotZ(qRad[i]));
  }
  return mul(m, translate(FLANGE_IN_WRIST3));
}

// ---------- inverse (damped least squares, numeric Jacobian) ----------
const MAX_ITER = 80, FD_STEP = 1e-6, DAMPING = 1e-3;

function residual(target, q, freeAxis, tcpT) {
  // tcpT: fixed transform from the flange to the controlled frame (the tool
  // tip), so position error — and the free-spin axis — act AT the tip
  const fk = tcpT ? mul(fkFlange(q), tcpT) : fkFlange(q);
  const dp = [target[3] - fk[3], target[7] - fk[7], target[11] - fk[11]];
  // rotation still to apply: R_want · R_fkᵀ
  const rfkT = [fk[0],fk[4],fk[8],0, fk[1],fk[5],fk[9],0, fk[2],fk[6],fk[10],0, 0,0,0,1];
  let turn = rotvec(mul(target, rfkT));
  if (freeAxis) {
    // spin about the tool axis is not an error: project it out, so the
    // solver treats the pose as a 5-DOF constraint (position + tool axis)
    const d = turn[0] * freeAxis[0] + turn[1] * freeAxis[1] + turn[2] * freeAxis[2];
    turn = [turn[0] - d * freeAxis[0], turn[1] - d * freeAxis[1], turn[2] - d * freeAxis[2]];
  }
  return [...dp, ...turn];
}

function solve6(A, b) { // A x = b, Gaussian elimination with partial pivot
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 6; col++) {
    let piv = col;
    for (let r = col + 1; r < 6; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-14) throw new Error('singular');
    for (let r = 0; r < 6; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c < 7; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[6] / row[i]);
}

export function ikNear(target, seedRad, opts = {}) {
  // the wrist (J4 ⊥ J5 ⊥ J6) reaches the same orientation on a flipped
  // branch: J4+π, −J5, J6+π — try it when the near branch ends out of limits
  const flip = s => [s[0], s[1], s[2], s[3] + Math.PI, -s[4], s[5] + Math.PI];
  const seeds = [seedRad, flip(seedRad)];
  let lastErr = null;
  for (const s of seeds) {
    try { return ikNearOne(target, s, opts); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function ikNearOne(target, seedRad, { tolM = 1e-4, tolRad = 1e-3, freeSpin = false, tcp = null } = {}) {
  // freeSpin: the target's z (tool) axis in the base frame; rotation about
  // it is left free and the damped step keeps all joints near the seed.
  // tcp: the controlled frame's offset from the flange (tool tip), metres.
  const freeAxis = freeSpin ? axis(target, 2) : null;
  const tcpT = !tcp ? null
    : tcp.length === 16 ? tcp                                  // full flange→tool transform
    : (tcp[0] || tcp[1] || tcp[2]) ? translate(tcp) : null;    // plain tip offset
  let q = [...seedRad];
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const r = residual(target, q, freeAxis, tcpT);
    const posErr = Math.hypot(r[0], r[1], r[2]);
    const rotErr = Math.hypot(r[3], r[4], r[5]);
    if (posErr < tolM && rotErr < tolRad) {
      for (let j = 0; j < 6; j++) {
        // a revolute joint's q and q±2π are the same pose: pull into limits
        while (q[j] > CHAIN[j].lim[1] && q[j] - 2 * Math.PI >= CHAIN[j].lim[0] - 1e-6) q[j] -= 2 * Math.PI;
        while (q[j] < CHAIN[j].lim[0] && q[j] + 2 * Math.PI <= CHAIN[j].lim[1] + 1e-6) q[j] += 2 * Math.PI;
      }
      for (let j = 0; j < 6; j++) {
        if (q[j] < CHAIN[j].lim[0] - 1e-6 || q[j] > CHAIN[j].lim[1] + 1e-6)
          throw new Error(`ik: J${j + 1} = ${(q[j] * 180 / Math.PI).toFixed(1)}° outside limits`);
      }
      return q;
    }
    // numeric Jacobian, 6x6
    const J = [];
    for (let j = 0; j < 6; j++) {
      const qd = [...q];
      qd[j] += FD_STEP;
      const rd = residual(target, qd, freeAxis, tcpT);
      J.push(r.map((v, i) => (rd[i] - v) / FD_STEP)); // column j
    }
    // (JᵀJ + λ²I) dq = Jᵀ r   — J stored column-major in J[j][i]
    const JtJ = [], Jtr = [];
    for (let a = 0; a < 6; a++) {
      Jtr.push(J[a].reduce((s, v, i) => s + v * r[i], 0));
      const row = [];
      for (let b = 0; b < 6; b++)
        row.push(J[a].reduce((s, v, i) => s + v * J[b][i], 0) + (a === b ? DAMPING * DAMPING : 0));
      JtJ.push(row);
    }
    // J is d(residual)/dq, so step against it: dq = -(JᵀJ+λ²I)⁻¹ Jᵀ r
    const dq = solve6(JtJ, Jtr);
    for (let j = 0; j < 6; j++) q[j] -= dq[j];
  }
  throw new Error('ik: no convergence (target out of reach or too far from seed)');
}

// ---------- pose builders (table-frame helpers for steps) ----------
const norm = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

// A pose at `point` whose z-axis is `zdir`; x chosen stably.
export function poseFacing(point, zdir) {
  const z = norm(zdir);
  const up = Math.abs(z[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], point[0],
    x[1], y[1], z[1], point[1],
    x[2], y[2], z[2], point[2],
    0, 0, 0, 1,
  ];
}

export const poseZDown = (point, yawRad = 0) =>
  mul(poseFacing(point, [0, 0, -1]), rotZ(yawRad));

// ---------- rotation interpolation (for controlled reorientation) ----------
export function quatFromMat(m) {
  const tr = m[0] + m[5] + m[10];
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [s / 4, (m[9] - m[6]) / s, (m[2] - m[8]) / s, (m[4] - m[1]) / s];
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
    q = [(m[9] - m[6]) / s, s / 4, (m[1] + m[4]) / s, (m[2] + m[8]) / s];
  } else if (m[5] > m[10]) {
    const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
    q = [(m[2] - m[8]) / s, (m[1] + m[4]) / s, s / 4, (m[6] + m[9]) / s];
  } else {
    const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
    q = [(m[4] - m[1]) / s, (m[2] + m[8]) / s, (m[6] + m[9]) / s, s / 4];
  }
  return q; // [w, x, y, z]
}

export function matFromQuat(q, p = [0, 0, 0]) {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), p[0],
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), p[1],
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), p[2],
    0, 0, 0, 1,
  ];
}

export function slerp(qa, qb, t) {
  let d = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  const b = d < 0 ? qb.map(v => -v) : qb;
  d = Math.abs(d);
  if (d > 0.9995) {
    const q = qa.map((v, i) => v + (b[i] - v) * t);
    const n = Math.hypot(...q);
    return q.map(v => v / n);
  }
  const th = Math.acos(Math.min(1, d));
  const [wa, wb] = [Math.sin((1 - t) * th) / Math.sin(th), Math.sin(t * th) / Math.sin(th)];
  return qa.map((v, i) => wa * v + wb * b[i]);
}
