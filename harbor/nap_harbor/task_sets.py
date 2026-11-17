"""The locked Terminal-Bench task sets a scored run uses, and how they were drawn.

A score is only comparable with another on the same tasks, and only honest if nobody chose the
tasks after seeing how the agent did on them. So the sets are drawn once, by a seeded shuffle of
the whole dataset, and committed before any scored run: **test** is what a reported number comes
from and is never tuned against; **dev** is what a change is tried on first. The two are disjoint.

``tests/test_task_sets.py`` pins the seed below and a hash of the population as literals, and
redraws both sets and fails if a committed list differs, so a list edited by hand, a seed changed
to get a friendlier draw, or a population edited and redrawn is caught. Changing either on
purpose means a new set and a new baseline, never a quiet edit.

Standard library only. ``python -m nap_harbor.task_sets <dev|test>`` prints Harbor's ``-i`` flags
for a set, which is how the benchmark workflow passes it.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

#: Fixed before the draw and recorded here; the date the sets were drawn.
SEED = 20261117
TEST_SIZE = 25
DEV_SIZE = 10

TASK_SETS_DIR = Path(__file__).resolve().parents[1] / "task-sets"
POPULATION_FILE = TASK_SETS_DIR / "terminal-bench-2-1.txt"
SET_FILES = {
    "test": TASK_SETS_DIR / "terminal-bench-test.txt",
    "dev": TASK_SETS_DIR / "terminal-bench-dev.txt",
}


def read_ids(path: Path) -> list[str]:
    """Task ids in a set file, in order: one per line, ``#`` comments and blank lines skipped."""
    lines = (line.strip() for line in path.read_text().splitlines())
    return [line for line in lines if line and not line.startswith("#")]


def draw(population: list[str], seed: int = SEED) -> dict[str, list[str]]:
    """Test first, then dev from what is left, from one shuffle of the sorted population.

    Sorted first so the draw depends on which tasks exist, not on the order a listing gave them.
    """
    shuffled = sorted(population)
    random.Random(seed).shuffle(shuffled)
    return {
        "test": shuffled[:TEST_SIZE],
        "dev": shuffled[TEST_SIZE : TEST_SIZE + DEV_SIZE],
    }


def include_flags(ids: list[str]) -> list[str]:
    """Harbor's ``-i`` flags for a set, one pair per task."""
    return [flag for task in ids for flag in ("-i", task)]


def render(name: str, ids: list[str]) -> str:
    """A set file's text: a header that says how it was drawn, then its ids."""
    header = [
        f"# The Terminal-Bench {name} set: {len(ids)} tasks, drawn with seed {SEED} by",
        "# nap_harbor/task_sets.py from terminal-bench-2-1.txt. Never edit by hand; see that module.",
    ]
    return "\n".join([*header, *ids]) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) == 1 and argv[0] in SET_FILES:
        print(" ".join(include_flags(read_ids(SET_FILES[argv[0]]))))
        return 0
    if argv == ["--write"]:
        for name, ids in draw(read_ids(POPULATION_FILE)).items():
            SET_FILES[name].write_text(render(name, ids))
        return 0
    print("usage: python -m nap_harbor.task_sets <dev|test> | --write", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
