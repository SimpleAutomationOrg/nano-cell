// Capsule fitting for the moving side (arm links, flange stack, tool):
// a capsule in the object's own frame, sized from its mesh subtree.
// Browser-side only (uses three.js matrices).

import * as THREE from 'three';

// Bounding box of a subtree in the frame of `root` itself (not world space).
function localBox(root) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    // compose o's transform relative to root
    const rel = new THREE.Matrix4();
    let n = o;
    while (n && n !== root) { n.updateMatrix(); rel.premultiply(n.matrix); n = n.parent; }
    for (let c = 0; c < 8; c++) {
      v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z);
      box.expandByPoint(v.applyMatrix4(rel));
    }
  });
  return box;
}

// Fit a capsule (in the object's own frame) to a loaded mesh subtree.
export function capsuleFromObject(obj, { minR = 0.03, shrink = 0.9 } = {}) {
  const box = localBox(obj);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3()).toArray();
  const center = box.getCenter(new THREE.Vector3()).toArray();
  const axis = size.indexOf(Math.max(...size));
  const others = [0, 1, 2].filter(i => i !== axis);
  const r = Math.max(minR, Math.max(size[others[0]], size[others[1]]) / 2 * shrink);
  const half = Math.max(0, size[axis] / 2 - r);
  const a = [...center], b = [...center];
  a[axis] -= half; b[axis] += half;
  return { a, b, r };
}
