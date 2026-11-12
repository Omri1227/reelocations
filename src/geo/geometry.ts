export type LonLat = [number, number];

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Diagonal of a Nominatim bbox [south, north, west, east] in km. */
export function bboxDiagonalKm(b: [number, number, number, number]): number {
  return haversineKm({ lat: b[0], lon: b[2] }, { lat: b[1], lon: b[3] });
}

export function inBbox(p: { lat: number; lon: number }, b: [number, number, number, number], padKm = 0): boolean {
  const padLat = padKm / 111, padLon = padKm / (111 * Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)));
  return p.lat >= b[0] - padLat && p.lat <= b[1] + padLat && p.lon >= b[2] - padLon && p.lon <= b[3] + padLon;
}

/** Join way segments that share endpoints into as few polylines as possible. */
export function mergeLines(segments: LonLat[][]): LonLat[][] {
  const eq = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  const pool = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const out: LonLat[][] = [];
  while (pool.length) {
    let line = pool.shift()!;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const first = line[0], last = line[line.length - 1];
        if (eq(last, s[0])) line = line.concat(s.slice(1));
        else if (eq(last, s[s.length - 1])) line = line.concat([...s].reverse().slice(1));
        else if (eq(first, s[s.length - 1])) line = s.concat(line.slice(1));
        else if (eq(first, s[0])) line = [...s].reverse().concat(line.slice(1));
        else continue;
        pool.splice(i, 1); changed = true; break;
      }
    }
    out.push(line);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Douglas–Peucker simplification (tolerance in degrees; ~1e-4 ≈ 11 m). */
export function simplify(line: LonLat[], tol = 1e-4): LonLat[] {
  if (line.length <= 2) return line;
  const sqTol = tol * tol;
  const segDist = (p: LonLat, a: LonLat, b: LonLat) => {
    let [x, y] = a; let dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y; return dx * dx + dy * dy;
  };
  const keep = new Uint8Array(line.length); keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = segDist(line[i], line[s], line[e]); if (d > maxD) { maxD = d; idx = i; } }
    if (idx >= 0 && maxD > sqTol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return line.filter((_, i) => keep[i]);
}

/** Simplify until the total vertex count fits My Maps comfortably. */
export function fitLines(lines: LonLat[][], maxPoints = 1500): LonLat[][] {
  let tol = 2e-5, out = lines;
  for (let i = 0; i < 12; i++) {
    out = lines.map((l) => simplify(l, tol));
    if (out.reduce((n, l) => n + l.length, 0) <= maxPoints) break;
    tol *= 2;
  }
  return out;
}

export function lineLengthKm(lines: LonLat[][]): number {
  let km = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) km += haversineKm({ lon: l[i - 1][0], lat: l[i - 1][1] }, { lon: l[i][0], lat: l[i][1] });
  return km;
}
