# Sokoban solver

Entry for the make.fun bounty
[sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121):
one program answers five drawn Sokoban levels, each in as few pushes as
possible. Run as `node /bot/main.ts` (Node 22, standard library only);
it reads `/input/<id>/level.txt` (XSB) and writes
`/output/<id>/solution.txt` (moves in `u/d/l/r`).

## Idea

The generator's levels are a hallway one square wide plus one to four
rooms off it, and a box pushed out of a room's door into the hallway can
never be pushed back — so every box stays in its room and the rooms are
independent problems, joined only by the player's walk. The solver:

1. decomposes the level into the hallway (the player's row) and rooms
   (flood fill from each door cell, never crossing the hallway row);
2. solves each room push-optimally with A\* over pushes: states are
   box positions plus the player's reachable region (normalised to its
   lowest cell), the heuristic is the minimum assignment of boxes to
   goals over box-travel distances, and successors are pruned by
   dead-cell analysis (reverse-pull reachability from the goals) and
   2x2 freeze detection;
3. concatenates the walks between rooms (plain BFS with the boxes as
   walls) and the per-room step strings, and replays the whole answer
   on the level as a self-check before writing it.

The search is bounded by a fixed expansion budget per room, never by
the clock, and all tie-breaking is fixed — two runs write identical
bytes. No dependencies, no network, no clock reads.

## Verification

On the kit's practice set the solver scores 1,000,000 (every instance
at its push-optimal count P\*), against 200,000 for the house baseline
plain-astar 1.0.0; the full set runs in under a second. It also scores
1,000,000 on six further freshly drawn sets (30 levels) from the
competition's own generator. See the kit's `grade-local` output
(`5000 of 5000 points`, `L1 regrade reproduced byte for byte`).

Written from scratch for this bounty; no public solver code is used.
