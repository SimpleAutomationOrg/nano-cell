// Author a print STEP file from planar-faced solids — for GENERIC fixtures
// that have no outside CAD (pots, trays, feeders drawn by the CAD designer).
// Real purchased or printed parts keep their own STEP; this writes the same
// kind of file (AP214, manifold BREP, per-solid colour) so the one pipeline
// applies: the STEP in print/ is the source of truth and
// scripts/step-to-mesh.mjs makes the meshes from it.
//
// A solid is { name, color: [r,g,b], faces: [ loop, ... ] } where each loop
// is the face's outer boundary, counter-clockwise seen from OUTSIDE the
// solid, as [x,y,z] in millimetres. Only planar faces: boxes, prisms, and
// anything they compose. Build them with the helpers:
//
//   prism(poly2d, z0, z1)   extrude a CCW polygon from z0 up to z1
//   box(x0,x1, y0,y1, z0,z1)
//   ngon(n, r, [cx,cy])     a regular polygon, CCW
//   move(faces, fn)         map every vertex ([x,y,z]) => [x,y,z]
//   rotY(a), rotZ(a)        vertex maps; shift(dx,dy,dz) likewise
//
// writeStep(path, solids) writes the file.
import { writeFileSync } from 'node:fs';

export const ngon = (n, r, [cx, cy] = [0, 0]) =>
  Array.from({ length: n }, (_, i) => {
    const a = 2 * Math.PI * i / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// extrude a CCW polygon: bottom (seen from below), top, one quad per edge
export const prism = (poly, z0, z1) => {
  const n = poly.length, faces = [];
  faces.push(poly.map(([x, y]) => [x, y, z0]).reverse());
  faces.push(poly.map(([x, y]) => [x, y, z1]));
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
    faces.push([[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]]);
  }
  return faces;
};

export const box = (x0, x1, y0, y1, z0, z1) =>
  prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1);

export const move = (faces, fn) => faces.map(loop => loop.map(p => fn(p)));
export const shift = (dx, dy, dz) => ([x, y, z]) => [x + dx, y + dy, z + dz];
export const rotY = a => ([x, y, z]) =>
  [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
export const rotZ = a => ([x, y, z]) =>
  [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = v => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
// Newell's method: the plane normal of a (near-)planar loop
const newell = loop => {
  const n = [0, 0, 0];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm(n);
};

const fmt = v => {
  const r = Math.round(v * 1e6) / 1e6;
  let s = r.toFixed(6).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return s;
};

export function writeStep(path, solids) {
  const lines = [];
  let n = 0;
  const E = text => { lines.push(`#${++n} = ${text};`); return `#${n}`; };

  const app = E(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
  E(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${app})`);
  const pctx = E(`PRODUCT_CONTEXT('',${app},'mechanical')`);
  const product = E(`PRODUCT('part','part','',(${pctx}))`);
  E(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${product}))`);
  const pdf = E(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const pdc = E(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`);
  const pd = E(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`);
  const pds = E(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  const uLen = E(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
  const uAng = E(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const uSol = E(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const unc = E(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),${uLen},'distance_accuracy_value','confusion accuracy')`);
  const ctx = E(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${uLen},${uAng},${uSol})) REPRESENTATION_CONTEXT('Context #1','3D Context') )`);

  const breps = [], styled = [];
  for (const solid of solids) {
    const pts = new Map(), verts = new Map(), edges = new Map();
    const key = p => p.map(fmt).join(',');
    const point = p => {
      const k = key(p);
      if (!pts.has(k)) pts.set(k, E(`CARTESIAN_POINT('',(${p.map(fmt).join(',')}))`));
      return pts.get(k);
    };
    const vertex = p => {
      const k = key(p);
      if (!verts.has(k)) verts.set(k, E(`VERTEX_POINT('',${point(p)})`));
      return verts.get(k);
    };
    const dir = v => E(`DIRECTION('',(${v.map(fmt).join(',')}))`);
    const faceIds = [];
    for (const loop of solid.faces) {
      const oriented = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const ka = key(a), kb = key(b);
        const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let e = edges.get(ek);
        if (!e) {
          const line = E(`LINE('',${point(a)},${E(`VECTOR('',${dir(norm(sub(b, a)))},1.0)`)})`);
          e = { id: E(`EDGE_CURVE('',${vertex(a)},${vertex(b)},${line},.T.)`), from: ka };
          edges.set(ek, e);
        }
        oriented.push(E(`ORIENTED_EDGE('',*,*,${e.id},${e.from === ka ? '.T.' : '.F.'})`));
      }
      const el = E(`EDGE_LOOP('',(${oriented.join(',')}))`);
      const bound = E(`FACE_OUTER_BOUND('',${el},.T.)`);
      const nrm = newell(loop);
      const ref = norm(sub(loop[1], loop[0]));
      const a2p = E(`AXIS2_PLACEMENT_3D('',${point(loop[0])},${dir(nrm)},${dir(ref)})`);
      faceIds.push(E(`ADVANCED_FACE('',(${bound}),${E(`PLANE('',${a2p})`)},.T.)`));
    }
    const shell = E(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
    const brep = E(`MANIFOLD_SOLID_BREP('${solid.name}',${shell})`);
    breps.push(brep);
    const [r, g, b] = solid.color;
    const rgb = E(`COLOUR_RGB('',${fmt(r)},${fmt(g)},${fmt(b)})`);
    const fasc = E(`FILL_AREA_STYLE_COLOUR('',${rgb})`);
    const fas = E(`FILL_AREA_STYLE('',(${fasc}))`);
    const ssfa = E(`SURFACE_STYLE_FILL_AREA(${fas})`);
    const sss = E(`SURFACE_SIDE_STYLE('',(${ssfa}))`);
    const ssu = E(`SURFACE_STYLE_USAGE(.BOTH.,${sss})`);
    const psa = E(`PRESENTATION_STYLE_ASSIGNMENT((${ssu}))`);
    styled.push(E(`STYLED_ITEM('',(${psa}),${brep})`));
  }

  const org = E(`AXIS2_PLACEMENT_3D('',${E(`CARTESIAN_POINT('',(0.0,0.0,0.0))`)},${E(`DIRECTION('',(0.0,0.0,1.0))`)},${E(`DIRECTION('',(1.0,0.0,0.0))`)})`);
  const rep = E(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[org, ...breps].join(',')}),${ctx})`);
  E(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  E(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(',')}),${ctx})`);

  const stamp = new Date().toISOString().slice(0, 19);
  writeFileSync(path, `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('microfactory generic part'),'2;1');
FILE_NAME('${path.split('/').pop()}','${stamp}',('microfactory'),('microfactory'),
  'scripts/poly-step.mjs','scripts/poly-step.mjs','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`);
  console.log(`${path}: ${solids.length} solids, ${n} entities`);
}
