"""Build a collision mesh for a Gaussian-splat space.

    uv run --no-project --with numpy --with pillow python tools/build_space.py spaces/apartment/scene.sog spaces/apartment --flip-x

Steps: decode splat centres (+opacity, scale) from .sog (v2) or 3DGS .ply -> rotate to y-up ->
find the floor (densest low horizontal slab) -> keep solid, opaque, small splats -> occupancy in the
body band -> greedy-merged boxes (one per run of cells with similar obstacle height) -> collision.json/.obj.
Also writes debug.png (top view: splat density, red = wall, blue = low furniture) and transform.json
(how to place the splat entity so it lines up with the mesh).
"""
import argparse, json, math, os, zipfile, io
from collections import deque
import numpy as np
from PIL import Image


def load_sog(path):
    z = zipfile.ZipFile(path)
    meta = json.loads(z.read('meta.json'))
    n = meta['count']

    def img(f):
        return np.asarray(Image.open(io.BytesIO(z.read(f))).convert('RGBA')).reshape(-1, 4)[:n].astype(np.float64)
    lo, hi = img(meta['means']['files'][0]), img(meta['means']['files'][1])
    mn, mx = np.array(meta['means']['mins']), np.array(meta['means']['maxs'])
    q = (lo[:, :3] + hi[:, :3] * 256) / 65535
    v = mn + (mx - mn) * q
    pos = np.sign(v) * (np.exp(np.abs(v)) - 1)
    sc = img(meta['scales']['files'][0])[:, :3].astype(int)
    cb = np.array(meta['scales']['codebook'])
    scale = np.exp(cb[sc]).max(axis=1)
    sh0 = img(meta['sh0']['files'][0])
    opacity = sh0[:, 3] / 255
    return pos, opacity, scale


def load_ply(path):
    with open(path, 'rb') as f:
        header = b''
        while not header.endswith(b'end_header\n'):
            header += f.readline()
        lines = header.decode().split('\n')
        n = int([l for l in lines if l.startswith('element vertex')][0].split()[-1])
        props = [l.split()[-1] for l in lines if l.startswith('property float')]
        data = np.frombuffer(f.read(n * 4 * len(props)), dtype=np.float32).reshape(n, len(props))
    col = {p: i for i, p in enumerate(props)}
    pos = data[:, [col['x'], col['y'], col['z']]].astype(np.float64)
    opacity = 1 / (1 + np.exp(-data[:, col['opacity']]))
    scale = np.exp(data[:, [col['scale_0'], col['scale_1'], col['scale_2']]]).max(axis=1)
    return pos, opacity, scale


def greedy_boxes(blocked, heights, levels):
    """merge blocked cells into rectangles of the same quantised height"""
    h, w = blocked.shape
    q = np.where(blocked, np.digitize(heights, levels), -1)
    used = np.zeros_like(blocked)
    boxes = []
    for z in range(h):
        for x in range(w):
            if q[z, x] < 0 or used[z, x]:
                continue
            k = q[z, x]
            x1 = x
            while x1 + 1 < w and q[z, x1 + 1] == k and not used[z, x1 + 1]:
                x1 += 1
            z1 = z
            while z1 + 1 < h and all(q[z1 + 1, i] == k and not used[z1 + 1, i] for i in range(x, x1 + 1)):
                z1 += 1
            used[z:z1 + 1, x:x1 + 1] = True
            boxes.append((x, z, x1 + 1, z1 + 1, float(heights[z:z1 + 1, x:x1 + 1].max())))
    return boxes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('splat')
    ap.add_argument('out')
    ap.add_argument('--flip-x', action='store_true', help='rotate 180 deg about X (y-down captures)')
    ap.add_argument('--scale', type=float, default=1.0, help='metres per splat unit')
    ap.add_argument('--yaw', type=float, default=0.0, help='extra rotation about up (deg)')
    ap.add_argument('--crop', type=float, nargs=4, metavar=('X0', 'Z0', 'X1', 'Z1'), help='keep this XZ box (after rotation, before shift)')
    ap.add_argument('--cell', type=float, default=0.25)
    ap.add_argument('--wall-h', type=float, default=2.7)
    ap.add_argument('--floor', type=float, default=None, help='force floor height (after rotation)')
    ap.add_argument('--min-pts', type=int, default=6, help='solid points per cell (body band) to block it')
    ap.add_argument('--info', action='store_true', help='only print bounds / histograms')
    a = ap.parse_args()

    pos, op, sc = (load_sog if a.splat.endswith('.sog') else load_ply)(a.splat)
    print(f'{len(pos)} splats')
    R = np.eye(3)
    if a.flip_x:
        R = np.diag([1.0, -1.0, -1.0]) @ R
    if a.yaw:
        t = math.radians(a.yaw)
        c, s = math.cos(t), math.sin(t)
        R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]) @ R
    p = (pos @ R.T) * a.scale
    solid = (op > 0.5) & (sc * a.scale < 0.12)
    ps = p[solid].copy()
    pf = p[op > 0.3].copy()      # floor coverage: any visible splat (floors are often big flat splats)
    print(f'{len(ps)} solid splats; bounds {ps.min(0).round(2)} .. {ps.max(0).round(2)}')

    # floor: the lowest dense horizontal slab
    hist, edges = np.histogram(ps[:, 1], bins=200)
    if a.floor is None:
        peak = hist.max()
        i = next(i for i in range(len(hist)) if hist[i] > 0.25 * peak)
        i = max(range(i, min(i + 6, len(hist))), key=lambda k: hist[k])
        floor = (edges[i] + edges[i + 1]) / 2
    else:
        floor = a.floor
    print(f'floor at y={floor:.3f}')
    if a.info:
        top = np.argsort(hist)[-8:][::-1]
        print('densest y slabs:', [(round((edges[k] + edges[k + 1]) / 2, 2), int(hist[k])) for k in top])
    ps[:, 1] -= floor
    pf[:, 1] -= floor

    if a.crop:
        x0, z0, x1, z1 = a.crop
    else:
        near = ps[np.abs(ps[:, 1]) < 0.1]
        x0, z0 = np.percentile(near[:, 0], 1), np.percentile(near[:, 2], 1)
        x1, z1 = np.percentile(near[:, 0], 99), np.percentile(near[:, 2], 99)
    print(f'crop x {x0:.2f}..{x1:.2f}  z {z0:.2f}..{z1:.2f}')
    margin = 0.5
    shift = np.array([-x0 + margin, 0, -z0 + margin])
    W, D = x1 - x0 + 2 * margin, z1 - z0 + 2 * margin
    C = a.cell
    w, h = int(math.ceil(W / C)), int(math.ceil(D / C))
    q = ps + shift
    ix, iz = np.floor(q[:, 0] / C).astype(int), np.floor(q[:, 2] / C).astype(int)
    ok = (ix >= 0) & (iz >= 0) & (ix < w) & (iz < h)
    band = ok & (q[:, 1] > 0.3) & (q[:, 1] < 1.8)
    cnt = np.zeros((h, w), int)
    np.add.at(cnt, (iz[band], ix[band]), 1)
    blocked = cnt >= a.min_pts

    # height of what is in the cell: 95th percentile of solid points below the ceiling
    heights = np.zeros((h, w))
    low = ok & (q[:, 1] > 0.15) & (q[:, 1] < a.wall_h - 0.1)
    keys_all = iz[low] * w + ix[low]
    order = np.lexsort((q[low, 1], keys_all))
    keys, ys = keys_all[order], q[low, 1][order]
    if len(keys):
        bnd = np.flatnonzero(np.diff(keys)) + 1
        for s, e in zip(np.r_[0, bnd], np.r_[bnd, len(keys)]):
            heights.flat[keys[s]] = ys[s + int((e - s - 1) * 0.95)]

    # cells with no floor splats at all are outside the capture -> wall
    qf = pf + shift
    fx_, fz_ = np.floor(qf[:, 0] / C).astype(int), np.floor(qf[:, 2] / C).astype(int)
    fl = (fx_ >= 0) & (fz_ >= 0) & (fx_ < w) & (fz_ < h) & (qf[:, 1] > -0.25) & (qf[:, 1] < 0.3)
    fcnt = np.zeros((h, w), int)
    np.add.at(fcnt, (fz_[fl], fx_[fl]), 1)
    nofloor = fcnt == 0

    def neigh(m):
        pad = np.pad(m, 1, constant_values=True)
        return sum(pad[1 + dz:h + 1 + dz, 1 + dx:w + 1 + dx].astype(int) for dz in (-1, 0, 1) for dx in (-1, 0, 1) if dz or dx)
    # close 1-cell gaps in walls, drop isolated specks
    for _ in range(2):
        blocked = blocked & (neigh(blocked) >= 3)          # drop specks and thin noise
    blocked = blocked | (~blocked & (neigh(blocked) >= 6))  # close 1-cell gaps
    nofloor = nofloor & (neigh(nofloor) >= 5)              # holes in a sparse floor are not walls
    blocked |= nofloor
    heights = np.where(blocked, np.clip(np.where(heights > 1.75, a.wall_h, np.maximum(heights, 0.4)), 0.4, a.wall_h), 0)
    heights[nofloor] = a.wall_h
    for m in (blocked,):
        m[0, :] = m[-1, :] = m[:, 0] = m[:, -1] = True
    heights[0, :] = heights[-1, :] = heights[:, 0] = heights[:, -1] = a.wall_h

    # keep only the largest open region
    lab = np.zeros((h, w), int)
    best, bestn, cur = 0, 0, 0
    for z in range(h):
        for x in range(w):
            if blocked[z, x] or lab[z, x]:
                continue
            cur += 1
            n = 0
            dq = deque([(z, x)])
            lab[z, x] = cur
            while dq:
                cz, cx = dq.popleft()
                n += 1
                for nz, nx in ((cz + 1, cx), (cz - 1, cx), (cz, cx + 1), (cz, cx - 1)):
                    if 0 <= nz < h and 0 <= nx < w and not blocked[nz, nx] and not lab[nz, nx]:
                        lab[nz, nx] = cur
                        dq.append((nz, nx))
            if n > bestn:
                best, bestn = cur, n
    others = (~blocked) & (lab != best)
    blocked |= others
    heights[others] = a.wall_h
    print(f'grid {w}x{h} @ {C} m; main open region {bestn * C * C:.1f} m2')

    # mesh: floor + one box per merged run
    P, I = [], []

    def quad(*v):
        n = len(P)
        P.extend(v)
        I.extend([n, n + 1, n + 2, n, n + 2, n + 3])

    def box(x0, y0, z0, x1, y1, z1):
        quad((x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0))
        quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
        quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0))
        quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1))
        quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0))
    quad((0, 0, 0), (0, 0, h * C), (w * C, 0, h * C), (w * C, 0, 0))
    boxes = greedy_boxes(blocked, heights, np.array([0.55, 0.85, 1.1, 1.5, 2.0]))
    for bx0, bz0, bx1, bz1, top in boxes:
        box(bx0 * C, 0, bz0 * C, bx1 * C, top, bz1 * C)
    os.makedirs(a.out, exist_ok=True)
    json.dump({'positions': [round(c, 4) for v in P for c in v], 'indices': I}, open(os.path.join(a.out, 'collision.json'), 'w'))
    with open(os.path.join(a.out, 'collision.obj'), 'w') as f:
        for v in P:
            f.write(f'v {v[0]:.4f} {v[1]:.4f} {v[2]:.4f}\n')
        for t in range(0, len(I), 3):
            f.write(f'f {I[t] + 1} {I[t + 1] + 1} {I[t + 2] + 1}\n')
    print(f'{len(boxes)} boxes, {len(I) // 3} triangles')

    # splat entity placement: world = Ry(yaw) * Rx(flip) * p * scale + (shift - floor * up)
    free = np.argwhere(~blocked)
    # spawn: the open cell farthest from any obstacle
    dist = np.where(blocked, 0, 999)
    for _ in range(40):
        pad = np.pad(dist, 1, constant_values=0)
        nd = np.minimum.reduce([pad[1 + dz:h + 1 + dz, 1 + dx:w + 1 + dx] + 1 for dz in (-1, 0, 1) for dx in (-1, 0, 1)])
        dist = np.where(blocked, 0, np.minimum(dist, nd))
    sz, sx = np.unravel_index(np.argmax(dist), dist.shape)
    tr = {'rotation': [180 if a.flip_x else 0, a.yaw, 0], 'scale': a.scale,
          'position': [float(shift[0]), float(-floor), float(shift[2])],
          'size': [w * C, h * C], 'start': [float((sx + 0.5) * C), float((sz + 0.5) * C)], 'openCells': int(len(free))}
    json.dump(tr, open(os.path.join(a.out, 'transform.json'), 'w'), indent=1)
    print(json.dumps(tr))

    # debug image
    dens = np.zeros((h, w))
    jx, jz = np.floor(q[:, 0] / C).astype(int), np.floor(q[:, 2] / C).astype(int)
    k = (jx >= 0) & (jz >= 0) & (jx < w) & (jz < h)
    np.add.at(dens, (jz[k], jx[k]), 1)
    ld = np.log1p(dens)
    g = (255 * np.clip(ld / max(1e-6, ld.max()), 0, 1)).astype(np.uint8)
    rgb = np.stack([g, g, g], -1).astype(np.float64)
    rgb[blocked] = np.array([200, 40, 40]) * 0.45 + rgb[blocked] * 0.55
    lowb = blocked & (heights < 1.75)
    rgb[lowb] = np.array([40, 120, 230]) * 0.6 + rgb[lowb] * 0.4
    rgb[sz, sx] = (0, 255, 0)
    Image.fromarray(rgb.astype(np.uint8)).resize((w * 6, h * 6), Image.NEAREST).save(os.path.join(a.out, 'debug.png'))


if __name__ == '__main__':
    main()
