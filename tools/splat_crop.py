"""Crop a SOG (v2) splat + its collision mesh (OBJ) to a play area, for speed.

    uv run --no-project --with numpy --with pillow python -I tools/splat_crop.py \
        spaces/sunnyvale/scene.sog spaces/sunnyvale/collision_raw.obj spaces/sunnyvale \
        --flip-z --box X0 Z0 X1 Z1 --view 25 --min-alpha 0.08

World frame = (source rotated 180 deg about Z if --flip-z) shifted so the play box starts at
(margin, ~ground 0, margin). Writes:
  scene.compressed.ply  splats inside the play box + `--view` metres around it (SH bands dropped:
                        ~16 bytes per splat, loads and sorts much faster than the full capture)
  collision.json        collision triangles inside the play box (+1 m), in the world frame
  transform.json        splat entity placement (the splat keeps its source frame)
"""
import argparse, io, json, math, os, zipfile
import numpy as np
from PIL import Image


def load_sog_full(path):
    z = zipfile.ZipFile(path)
    meta = json.loads(z.read('meta.json'))
    n = meta['count']

    def img(f):
        return np.asarray(Image.open(io.BytesIO(z.read(f))).convert('RGBA')).reshape(-1, 4)[:n]
    lo, hi = img(meta['means']['files'][0]).astype(np.float64), img(meta['means']['files'][1]).astype(np.float64)
    mn, mx = np.array(meta['means']['mins']), np.array(meta['means']['maxs'])
    v = mn + (mx - mn) * ((lo[:, :3] + hi[:, :3] * 256) / 65535)
    pos = np.sign(v) * (np.exp(np.abs(v)) - 1)
    quat = img(meta['quats']['files'][0])                       # raw: 3 x 8-bit + (252 + largest index)
    sc = img(meta['scales']['files'][0])[:, :3].astype(int)
    logscale = np.array(meta['scales']['codebook'])[sc]
    sh0 = img(meta['sh0']['files'][0])
    cb = np.array(meta['sh0']['codebook'])
    color = 0.5 + cb[sh0[:, :3].astype(int)] * 0.28209479177387814
    alpha = sh0[:, 3] / 255.0
    return pos, quat, logscale, color, alpha


def morton(p, bits=10):
    q = p - p.min(0)
    q = (q / max(q.max(), 1e-9) * ((1 << bits) - 1)).astype(np.uint64)
    code = np.zeros(len(p), np.uint64)
    for b in range(bits):
        for k in range(3):
            code |= ((q[:, k] >> np.uint64(b)) & np.uint64(1)) << np.uint64(3 * b + k)
    return code


def write_compressed_ply(path, pos, quat, logscale, color, alpha):
    n = len(pos)
    order = np.argsort(morton(pos))
    pos, quat, logscale, color, alpha = pos[order], quat[order], logscale[order], color[order], alpha[order]
    nch = (n + 255) // 256
    chunks = np.zeros((nch, 18), np.float32)
    packed = np.zeros((n, 4), np.uint32)

    def unorm(v, lo, hi, bits):
        t = (1 << bits) - 1
        r = np.where(hi - lo > 1e-12, (v - lo) / np.maximum(hi - lo, 1e-12), 0.0)
        return np.clip(np.round(r * t), 0, t).astype(np.uint32)
    for c in range(nch):
        s = slice(c * 256, min(n, (c + 1) * 256))
        p, l, col = pos[s], logscale[s], color[s]
        pmin, pmax, smin, smax = p.min(0), p.max(0), l.min(0), l.max(0)
        smin, smax = np.clip(smin, -20, 20), np.clip(smax, -20, 20)
        cmin, cmax = col.min(0), col.max(0)
        chunks[c] = [*pmin, *pmax, *smin, *smax, *cmin, *cmax]
        packed[s, 0] = (unorm(p[:, 0], pmin[0], pmax[0], 11) << 21) | (unorm(p[:, 1], pmin[1], pmax[1], 10) << 11) | unorm(p[:, 2], pmin[2], pmax[2], 11)
        lc = np.clip(l, -20, 20)
        packed[s, 2] = (unorm(lc[:, 0], smin[0], smax[0], 11) << 21) | (unorm(lc[:, 1], smin[1], smax[1], 10) << 11) | unorm(lc[:, 2], smin[2], smax[2], 11)
        packed[s, 3] = (unorm(col[:, 0], cmin[0], cmax[0], 8) << 24) | (unorm(col[:, 1], cmin[1], cmax[1], 8) << 16) | (unorm(col[:, 2], cmin[2], cmax[2], 8) << 8) | unorm(alpha[s], 0, 1, 8)
    # rotation: same "3 smallest + largest index" layout as SOG, 8 -> 10 bits
    q = quat.astype(np.uint32)
    up = lambda v: np.round(v.astype(np.float64) / 255 * 1023).astype(np.uint32)
    packed[:, 1] = ((q[:, 3] - 252) << 30) | (up(q[:, 0]) << 20) | (up(q[:, 1]) << 10) | up(q[:, 2])
    names = ['min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z', 'min_scale_x', 'min_scale_y', 'min_scale_z',
             'max_scale_x', 'max_scale_y', 'max_scale_z', 'min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b']
    head = ['ply', 'format binary_little_endian 1.0', f'element chunk {nch}'] + [f'property float {k}' for k in names] + \
           [f'element vertex {n}', 'property uint packed_position', 'property uint packed_rotation', 'property uint packed_scale', 'property uint packed_color', 'end_header']
    with open(path, 'wb') as f:
        f.write(('\n'.join(head) + '\n').encode())
        f.write(chunks.astype('<f4').tobytes())
        f.write(packed.astype('<u4').tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('sog'); ap.add_argument('obj'); ap.add_argument('out')
    ap.add_argument('--flip-z', action='store_true', help='source is upside down: rotate 180 deg about Z')
    ap.add_argument('--box', type=float, nargs=4, required=True, metavar=('X0', 'Z0', 'X1', 'Z1'), help='play area in the rotated frame')
    ap.add_argument('--view', type=float, default=25, help='keep splats this far around the play box (scenery)')
    ap.add_argument('--min-alpha', type=float, default=0.08)
    ap.add_argument('--max-height', type=float, default=25)
    ap.add_argument('--margin', type=float, default=1.0)
    ap.add_argument('--keep-far', type=float, default=0.35, help='fraction of small splats kept outside the play box')
    a = ap.parse_args()
    x0, z0, x1, z1 = a.box
    R = np.array([-1.0, -1.0, 1.0]) if a.flip_z else np.ones(3)

    # collision mesh first: it gives the ground level
    V, F = [], []
    for line in open(a.obj):
        if line.startswith('v '):
            V.append([float(t) for t in line.split()[1:4]])
        elif line.startswith('f '):
            F.append([int(t.split('/')[0]) - 1 for t in line.split()[1:4]])
    V = np.array(V)          # the decoded collision GLB is already in the upright (rotated) frame
    F = np.array(F)
    tri = V[F]
    cx, cz = tri[:, :, 0].mean(1), tri[:, :, 2].mean(1)
    keep = (cx > x0 - 1) & (cx < x1 + 1) & (cz > z0 - 1) & (cz < z1 + 1)
    tri = tri[keep]
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    flat = np.abs(nrm[:, 1]) / (np.linalg.norm(nrm, axis=1) + 1e-12) > 0.85
    fy = tri[flat][:, :, 1].mean(1)
    ground = float(np.median(fy[fy < np.percentile(fy, 5) + 1.5]))      # the terrain, not roofs / table tops
    shift = np.array([-x0 + a.margin, -ground, -z0 + a.margin])
    tri = tri + shift
    print(f'{len(F)} -> {len(tri)} collision triangles; ground at {ground:.2f} -> 0')
    uniq, inv = np.unique(np.round(tri.reshape(-1, 3), 4), axis=0, return_inverse=True)
    os.makedirs(a.out, exist_ok=True)
    json.dump({'positions': [round(float(c), 4) for c in uniq.reshape(-1)], 'indices': [int(i) for i in inv.reshape(-1)]}, open(os.path.join(a.out, 'collision.json'), 'w'))

    pos, quat, logscale, color, alpha = load_sog_full(a.sog)
    w = pos * R
    v = a.view
    m = (w[:, 0] > x0 - v) & (w[:, 0] < x1 + v) & (w[:, 2] > z0 - v) & (w[:, 2] < z1 + v) & (w[:, 1] - ground < a.max_height) & (alpha > a.min_alpha)
    # scenery outside the play box is only seen from afar: thin out its small splats
    inside = (w[:, 0] > x0) & (w[:, 0] < x1) & (w[:, 2] > z0) & (w[:, 2] < z1)
    rng = np.random.default_rng(1)
    big = np.exp(logscale.max(1)) > 0.04
    m &= inside | big | (rng.random(len(w)) < a.keep_far)
    print(f'{len(pos)} -> {m.sum()} splats')
    write_compressed_ply(os.path.join(a.out, 'scene.compressed.ply'), pos[m], quat[m], logscale[m], color[m], alpha[m])
    print('wrote', os.path.getsize(os.path.join(a.out, 'scene.compressed.ply')) // 1024, 'KB')
    tr = {'rotation': [0, 0, 180] if a.flip_z else [0, 0, 0], 'position': [float(shift[0]), float(shift[1]), float(shift[2])],
          'size': [x1 - x0 + 2 * a.margin, z1 - z0 + 2 * a.margin]}
    json.dump(tr, open(os.path.join(a.out, 'transform.json'), 'w'), indent=1)
    print(json.dumps(tr))


if __name__ == '__main__':
    main()
