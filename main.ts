// Sokoban solver for make.fun bounty sokoban-solver-01-run-20261121.
//
// Written from scratch. The levels are a hallway plus independent rooms:
// a box pushed out of a room's door into the hallway can never be pushed
// back, so every box stays in its room. The solver decomposes the level
// into hallway + rooms, solves each room push-optimally with A* over
// pushes (admissible min-assignment heuristic, dead-cell and 2x2-freeze
// pruning, player-region normalisation), and concatenates the walks
// between rooms. No clock reads, no randomness, fixed expansion budgets
// only, so two executions write identical bytes.
//
// main.ts at the repository root, run as: node /bot/main.ts (Node 22,
// erasable TypeScript syntax only). Input /input/<id>/level.txt, output
// /output/<id>/solution.txt. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand
// in for /input and /output outside a container, as the kit's starter does.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed neighbour order everywhere: deterministic tie-breaking.
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

/** Per-room expansion budget (work-bounded, never clock-bounded). */
const ROOM_EXPANSIONS = 500_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Set<number>;
  boxes: number[];
  player: number;
}

interface Room {
  region: Set<number>;
  door: number;
  entry: number;
}

/** Parse XSB exactly as the checker's levelOf does: short rows pad with wall. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet: new Set(goals), boxes, player };
}

/**
 * Split the level into the hallway (the player's row) and rooms: flood
 * fill from each door cell (a floor cell adjacent to the hallway) without
 * crossing the hallway row. Each room's door cell is where the flood
 * started; its entry is the adjacent hallway cell.
 */
function decompose(lv: Level): Room[] {
  const py = Math.floor(lv.player / lv.w);
  const hall = new Set<number>();
  for (let x = 0; x < lv.w; x++) {
    const i = py * lv.w + x;
    if (!lv.wall[i]) hall.add(i);
  }
  const seen = new Set<number>(hall);
  const rooms: Room[] = [];
  for (const hc of [...hall].sort((a, b) => a - b)) {
    for (const d of [-lv.w, lv.w]) {
      const door = hc + d;
      if (door < 0 || door >= lv.w * lv.h || lv.wall[door] || seen.has(door)) continue;
      const region = new Set<number>();
      const stack = [door];
      seen.add(door);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        region.add(cur);
        for (const dd of [1, -1, lv.w, -lv.w]) {
          const n = cur + dd;
          if (n < 0 || n >= lv.w * lv.h || lv.wall[n] || seen.has(n)) continue;
          if (Math.floor(n / lv.w) === py) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      rooms.push({ region, door, entry: hc });
    }
  }
  return rooms;
}

/** Flood fill from `start` over cells passing `open`; returns the reached set. */
function flood(start: number, open: (c: number) => boolean, w: number, size: number): Set<number> {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const dd of [1, -1, w, -w]) {
      const n = cur + dd;
      if (n < 0 || n >= size || seen.has(n) || !open(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

/** Shortest walk (steps string) from `from` to `to` over `open` cells, or null. */
function bfsWalk(from: number, to: number, open: (c: number) => boolean, w: number, size: number): string | null {
  if (from === to) return '';
  const parent = new Int32Array(size).fill(-2);
  const step = new Int8Array(size).fill(-1);
  parent[from] = -1;
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    for (let d = 0; d < 4; d++) {
      const n = cur + DIRS[d]!.dy * w + DIRS[d]!.dx;
      if (n < 0 || n >= size || parent[n] !== -2 || !open(n)) continue;
      parent[n] = cur;
      step[n] = d;
      if (n === to) {
        let moves = '';
        for (let t = n; parent[t] !== -1; t = parent[t]!) moves = DIRS[step[t]!]!.ch + moves;
        return moves;
      }
      queue.push(n);
    }
  }
  return null;
}

/** All permutations of [0..n-1], in lexicographic order (deterministic). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push([...a]);
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      gen(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  gen(0);
  return out;
}

interface Push {
  cell: number;
  dir: number;
}

interface RoomSolution {
  steps: string;
  endPlayer: number;
  pushes: number;
}

/**
 * Solve one room push-optimally. The player walks on region + entry cells;
 * boxes stay on region cells. Returns the step string (walks + pushes)
 * and the player's final cell, or null when the budget runs out.
 */
function solveRoom(lv: Level, room: Room, boxes0: number[]): RoomSolution | null {
  const { w, wall, goalSet } = lv;
  const size = w * lv.h;
  const region = room.region;
  const goals = lv.goals.filter((g) => region.has(g));
  const boxes = [...boxes0].sort((a, b) => a - b);
  if (boxes.length === 0 || boxes.length !== goals.length) return null;

  const walkOpen = (c: number): boolean =>
    !wall[c] && (region.has(c) || c === room.entry);

  // Pairwise push distances over region cells (boxes ignore other boxes).
  const dist = new Map<number, Int32Array>();
  for (const s of region) {
    const d = new Int32Array(size).fill(-1);
    d[s] = 0;
    const q = [s];
    let head = 0;
    while (head < q.length) {
      const cur = q[head++]!;
      for (const dd of [1, -1, w, -w]) {
        const n = cur + dd;
        if (n < 0 || n >= size || d[n] !== -1 || !region.has(n)) continue;
        d[n] = d[cur]! + 1;
        q.push(n);
      }
    }
    dist.set(s, d);
  }

  // Live cells: reverse-pull reachability from the goals. A box on a
  // non-goal cell outside this set can never reach a goal.
  const live = new Uint8Array(size);
  {
    const queue: number[] = [];
    for (const g of goals) {
      live[g] = 1;
      queue.push(g);
    }
    let head = 0;
    while (head < queue.length) {
      const y = queue[head++]!;
      for (let d = 0; d < 4; d++) {
        const prev = y - (DIRS[d]!.dy * w + DIRS[d]!.dx);
        const stance = y - 2 * (DIRS[d]!.dy * w + DIRS[d]!.dx);
        if (!region.has(prev) || live[prev]) continue;
        if (stance < 0 || stance >= size || wall[stance]) continue;
        if (!region.has(stance) && stance !== room.entry) continue;
        live[prev] = 1;
        queue.push(prev);
      }
    }
  }

  const perms = permutations(boxes.length);
  const heuristic = (bs: number[]): number => {
    if (bs.length <= 4) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < bs.length; i++) {
          const d = dist.get(bs[i]!)![goals[p[i]!]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (const g of goals) {
        const d = dist.get(b)![g]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  // A 2x2 window counts as blocked only on walls/boxes: a floor cell the
  // player can stand on (e.g. the hallway entry beside a door box) is NOT
  // blocking, since the player standing there can push the box out of the
  // window. Treating non-room floor as blocked falsely froze door boxes.
  const blocked = (c: number, boxSet: Set<number>): boolean =>
    c < 0 || c >= size || wall[c] || boxSet.has(c);

  const deadlocked = (bs: number[]): boolean => {
    const boxSet = new Set(bs);
    for (const b of bs) {
      if (goalSet.has(b) || live[b]) continue;
      return true;
    }
    // 2x2 freeze: a window of four blocked cells holding a box, no goal.
    for (const b of bs) {
      if (goalSet.has(b)) continue;
      for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
        const x0 = (b % w) + ox;
        const y0 = Math.floor(b / w) + oy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= lv.h) continue;
        const cells = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
        if (cells.some((c) => goalSet.has(c))) continue;
        if (cells.every((c) => blocked(c, boxSet))) return true;
      }
    }
    return false;
  };

  const normPlayer = (p: number, boxSet: Set<number>): number => {
    const reach = flood(p, (c) => walkOpen(c) && !boxSet.has(c), w, size);
    let m = Infinity;
    for (const c of reach) if (c < m) m = c;
    return m;
  };

  const keyOf = (bs: number[], p: number): string => bs.join(',') + '|' + p;

  const startSet = new Set(boxes);
  if (deadlocked(boxes)) return null;
  const startPlayer = normPlayer(room.entry, startSet);

  const stBoxes: number[][] = [boxes];
  const stPlayer: number[] = [startPlayer];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stPushCell: number[] = [-1];
  const stPushDir: number[] = [-1];
  const bestG = new Map<string, number>([[keyOf(boxes, startPlayer), 0]]);
  // Heap entries [f, h, seq, stateId]; seq breaks ties deterministically.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const h0 = heuristic(boxes);
  if (h0 === Infinity) return null;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, h0, seq++, 0]);

  let expanded = 0;
  let goalId = -1;
  while (heap.length > 0) {
    const [, , , id] = heapPop();
    const bs = stBoxes[id]!;
    const g = stG[id]!;
    if (g > (bestG.get(keyOf(bs, stPlayer[id]!)) ?? Infinity)) continue;
    if (bs.every((b) => goalSet.has(b))) {
      goalId = id;
      break;
    }
    if (++expanded > ROOM_EXPANSIONS) return null;
    const boxSet = new Set(bs);
    const reach = flood(stPlayer[id]!, (c) => walkOpen(c) && !boxSet.has(c), w, size);
    for (const b of bs) {
      for (let d = 0; d < 4; d++) {
        const dv = DIRS[d]!.dy * w + DIRS[d]!.dx;
        const target = b + dv;
        if (!region.has(target) || boxSet.has(target)) continue;
        const behind = b - dv;
        if (!reach.has(behind)) continue;
        const nb = bs.slice();
        nb[nb.indexOf(b)] = target;
        nb.sort((a, b2) => a - b2);
        if (deadlocked(nb)) continue;
        const nSet = new Set(nb);
        const np = normPlayer(b, nSet);
        const h = heuristic(nb);
        if (h === Infinity) continue;
        const g2 = g + 1;
        const k = keyOf(nb, np);
        if (g2 >= (bestG.get(k) ?? Infinity)) continue;
        bestG.set(k, g2);
        const nid = stBoxes.length;
        stBoxes.push(nb);
        stPlayer.push(np);
        stG.push(g2);
        stParent.push(id);
        stPushCell.push(b);
        stPushDir.push(d);
        heapPush([g2 + h, h, seq++, nid]);
      }
    }
  }
  if (goalId < 0) return null;

  // Reconstruct the push list, then expand each push with the player's walk.
  const pushes: Push[] = [];
  for (let t = goalId; stParent[t] !== -1; t = stParent[t]!) {
    pushes.push({ cell: stPushCell[t]!, dir: stPushDir[t]! });
  }
  pushes.reverse();

  let player = room.entry;
  let cur = [...boxes];
  let steps = '';
  for (const { cell, dir } of pushes) {
    const dv = DIRS[dir]!.dy * w + DIRS[dir]!.dx;
    const behind = cell - dv;
    const curSet = new Set(cur);
    const walk = bfsWalk(player, behind, (c) => walkOpen(c) && !curSet.has(c), w, size);
    if (walk === null) return null;
    steps += walk;
    cur[cur.indexOf(cell)] = cell + dv;
    player = cell;
    steps += DIRS[dir]!.ch;
  }
  return { steps, endPlayer: player, pushes: pushes.length };
}

/** Replay moves on the level with the checker's rules; true when solved. */
function replayOk(lv: Level, moves: string): boolean {
  const box = new Uint8Array(lv.w * lv.h);
  for (const b of lv.boxes) box[b] = 1;
  let player = lv.player;
  for (const ch of moves) {
    const d = DIRS.find((x) => x.ch === ch);
    if (!d) return false;
    const dv = d.dy * lv.w + d.dx;
    const next = player + dv;
    if (lv.wall[next]) return false;
    if (box[next]) {
      const beyond = next + dv;
      if (lv.wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !lv.goalSet.has(i)) return false;
  return true;
}

/** Solve one level; '' when any room fails (a valid, scoreless answer). */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  if (lv.player < 0 || lv.boxes.length === 0) return '';
  let rooms = decompose(lv);
  if (rooms.length === 0) {
    // Fallback: treat the whole floor as one room (never expected).
    const region = new Set<number>();
    for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) region.add(i);
    rooms = [{ region, door: lv.player, entry: lv.player }];
  }
  let player = lv.player;
  let curBoxes = [...lv.boxes];
  let moves = '';
  for (const room of rooms) {
    const roomBoxes = curBoxes.filter((b) => room.region.has(b));
    const walk = bfsWalk(
      player,
      room.entry,
      (c) => !lv.wall[c] && !curBoxes.includes(c),
      lv.w,
      lv.w * lv.h,
    );
    if (walk === null) return '';
    moves += walk;
    player = room.entry;
    const res = solveRoom(lv, room, roomBoxes);
    if (res === null) return '';
    moves += res.steps;
    player = res.endPlayer;
    const outside = curBoxes.filter((b) => !room.region.has(b));
    curBoxes = [...outside, ...lv.goals.filter((g) => room.region.has(g))].sort((a, b) => a - b);
  }
  if (!replayOk(lv, moves)) return '';
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
