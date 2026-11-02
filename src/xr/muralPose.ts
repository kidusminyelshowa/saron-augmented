/**
 * Mural pose from a MindAR match, in real-world units.
 *
 * MindAR estimates a pose with its own guessed camera (45° field of view) and
 * no idea of the mural's physical size. That's fine for drawing over its own
 * video, but in a WebXR session the content must sit in ARCore's metric world.
 * So only the 2D image positions of the match are used: the target's corners
 * are projected with MindAR's own camera (which reproduces where it found them
 * in the image), and the pose is solved again with the real camera projection
 * and the mural's real size (a planar homography decomposition).
 */

import * as THREE from 'three';

export type Mat3x4 = number[][];

export interface PoseInput {
  /** MindAR modelViewTransform (3×4, marker pixels → MindAR camera). */
  modelViewTransform: Mat3x4;
  /** MindAR projectionTransform (3×3 intrinsics) used for the match. */
  mindarK: number[][];
  /** Target image size in pixels [width, height]. */
  targetSize: [number, number];
  /** Region of the mural the target shows: normalised [x, y, w, h], top-left origin. */
  region: [number, number, number, number];
  /** Mural width in metres. */
  muralWidth: number;
  /** Mural aspect ratio (width / height). */
  aspectRatio: number;
  /** Size of the image given to MindAR, in pixels. */
  imageWidth: number;
  imageHeight: number;
  /** True when the image given to MindAR was upside down (rows bottom-first). */
  flippedY: boolean;
  /** The XR view's projection matrix (column-major, OpenGL). */
  projection: ArrayLike<number>;
}

export interface PoseResult {
  /**
   * Content placement in camera space (OpenGL: x right, y up, looking down -z).
   * Origin at the mural centre, x right, y up, z towards the viewer, and one
   * unit = the mural width (matching the MindAR anchor space the layers use).
   */
  cameraFromMural: THREE.Matrix4;
  /** Distance from the camera to the mural centre, metres. */
  distance: number;
  /** Mean reprojection error of the fitted points, in image pixels. */
  error: number;
}

/** Image pixel → camera ray (x/-z, y/-z) for a projection matrix. */
function pixelToRay(u: number, v: number, w: number, h: number, P: ArrayLike<number>): [number, number] {
  const ndcX = (u / w) * 2 - 1;
  const ndcY = 1 - (v / h) * 2;
  // ndc = P0 * (x/-z) - P8   (and the same for y with P5, P9)
  return [(ndcX + P[8]) / P[0], (ndcY + P[9]) / P[5]];
}

/** Camera ray → image pixel (inverse of pixelToRay). */
function rayToPixel(a: number, b: number, w: number, h: number, P: ArrayLike<number>): [number, number] {
  const ndcX = P[0] * a - P[8];
  const ndcY = P[5] * b - P[9];
  return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
}

/** Solve a small dense linear system (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Least-squares homography (h33 = 1) mapping src → dst from ≥ 4 point pairs. */
function homography(src: [number, number][], dst: [number, number][]): number[] | null {
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < src.length; i++) {
    const [X, Y] = src[i];
    const [a, b] = dst[i];
    addRow([X, Y, 1, 0, 0, 0, -a * X, -a * Y], a);
    addRow([0, 0, 0, X, Y, 1, -b * X, -b * Y], b);
  }
  const h = solve(AtA, Atb);
  return h ? [...h, 1] : null;
}

/** Image position (pixels) of a point on the target, as MindAR matched it. */
export function projectMindAR(mvt: Mat3x4, K: number[][], x: number, y: number): [number, number] {
  const cx = mvt[0][0] * x + mvt[0][1] * y + mvt[0][3];
  const cy = mvt[1][0] * x + mvt[1][1] * y + mvt[1][3];
  const cz = mvt[2][0] * x + mvt[2][1] * y + mvt[2][3];
  const u = K[0][0] * cx + K[0][1] * cy + K[0][2] * cz;
  const v = K[1][0] * cx + K[1][1] * cy + K[1][2] * cz;
  const w = K[2][0] * cx + K[2][1] * cy + K[2][2] * cz;
  return [u / w, v / w];
}

export function solveMuralPose(input: PoseInput): PoseResult | null {
  const { modelViewTransform: mvt, mindarK, targetSize, region, muralWidth, aspectRatio } = input;
  const [tw, th] = targetSize;
  const [rx, ry, rw, rh] = region;
  const muralHeight = muralWidth / aspectRatio;

  // Points on the target (marker pixels): a 3×3 grid for a stable fit.
  const plane: [number, number][] = [];
  const pixels: [number, number][] = [];
  for (const fy of [0, 0.5, 1]) {
    for (const fx of [0, 0.5, 1]) {
      const [u, v] = projectMindAR(mvt, mindarK, fx * tw, fy * th);
      pixels.push([u, input.flippedY ? input.imageHeight - v : v]);
      // Mural plane coordinates in metres, x right, y down from the top-left corner.
      plane.push([(rx + fx * rw) * muralWidth, (ry + fy * rh) * muralHeight]);
    }
  }
  return solvePoseFromPixels(plane, pixels, input.imageWidth, input.imageHeight, input.projection, muralWidth, aspectRatio);
}

/**
 * Pose of the mural plane from image positions of known points on it.
 * `plane` is in metres from the mural's top-left corner (x right, y down);
 * `pixels` are image positions (top-left origin) in an image of size w × h
 * taken with projection matrix P.
 */
export function solvePoseFromPixels(
  plane: [number, number][],
  pixels: [number, number][],
  W: number,
  H: number,
  P: ArrayLike<number>,
  muralWidth: number,
  aspectRatio: number,
): PoseResult | null {
  const muralHeight = muralWidth / aspectRatio;
  const rays = pixels.map(([u, v]) => pixelToRay(u, v, W, H, P));
  const h = homography(plane, rays);
  if (!h) return null;
  const h1 = new THREE.Vector3(h[0], h[3], h[6]);
  const h2 = new THREE.Vector3(h[1], h[4], h[7]);
  const h3 = new THREE.Vector3(h[2], h[5], h[8]);

  // H ∝ [r1 r2 t] in a camera frame with +z forward: (a, b, 1) ∝ (x, y, -z_gl).
  let lambda = 2 / (h1.length() + h2.length());
  if (h3.z * lambda < 0) lambda = -lambda; // the mural is in front of the camera
  const r1 = h1.clone().multiplyScalar(lambda).normalize();
  let r2 = h2.clone().multiplyScalar(lambda);
  r2 = r2.sub(r1.clone().multiplyScalar(r1.dot(r2))).normalize();
  const t = h3.clone().multiplyScalar(lambda);

  // Back to OpenGL camera space (flip z).
  const right = new THREE.Vector3(r1.x, r1.y, -r1.z);
  const down = new THREE.Vector3(r2.x, r2.y, -r2.z);
  const origin = new THREE.Vector3(t.x, t.y, -t.z); // mural top-left corner
  const up = down.clone().negate();
  const out = new THREE.Vector3().crossVectors(right, up);
  const centre = origin
    .clone()
    .add(right.clone().multiplyScalar(muralWidth / 2))
    .add(down.clone().multiplyScalar(muralHeight / 2));

  const m = new THREE.Matrix4().makeBasis(
    right.multiplyScalar(muralWidth),
    up.multiplyScalar(muralWidth),
    out.multiplyScalar(muralWidth),
  );
  m.setPosition(centre);

  // Reprojection error of the fitted points through the real projection.
  let err = 0;
  for (let i = 0; i < plane.length; i++) {
    const [X, Y] = plane[i];
    const p = new THREE.Vector3(X / muralWidth - 0.5, -(Y / muralWidth - 0.5 / aspectRatio), 0).applyMatrix4(m);
    const [u, v] = rayToPixel(p.x / -p.z, p.y / -p.z, W, H, P);
    err += Math.hypot(u - pixels[i][0], v - pixels[i][1]);
  }

  return { cameraFromMural: m, distance: centre.length(), error: err / plane.length };
}
