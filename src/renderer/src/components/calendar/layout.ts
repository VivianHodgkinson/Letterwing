/** Side-by-side columns for overlapping events: each cluster of overlaps shares its width */
export function layout<T extends { s: number; t: number }>(items: T[]): (T & { col: number; cols: number })[] {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.t - a.t)
  const out: (T & { col: number; cols: number })[] = []
  let cluster: (T & { col: number; cols: number })[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
    for (const c of cluster) c.cols = cols
    out.push(...cluster)
    cluster = []
  }
  for (const it of sorted) {
    if (it.s >= clusterEnd && cluster.length) flush()
    const ends: number[] = []
    for (const c of cluster) ends[c.col] = Math.max(ends[c.col] ?? -Infinity, c.t)
    let col = ends.findIndex((end) => end <= it.s)
    if (col < 0) col = ends.length
    cluster.push({ ...it, col, cols: 1 })
    clusterEnd = Math.max(clusterEnd, it.t)
  }
  flush()
  return out
}
