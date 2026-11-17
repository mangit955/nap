"""The committed task sets are the seeded draw, and nothing else."""

from __future__ import annotations

from nap_harbor.task_sets import (
    DEV_SIZE,
    POPULATION_FILE,
    SET_FILES,
    TEST_SIZE,
    draw,
    include_flags,
    main,
    read_ids,
    render,
)


def test_the_committed_sets_are_exactly_the_seeded_draw():
    drawn = draw(read_ids(POPULATION_FILE))
    for name, path in SET_FILES.items():
        assert path.read_text() == render(name, drawn[name]), f"{path.name} is not the draw"


def test_the_sets_are_the_planned_sizes_and_disjoint():
    test = read_ids(SET_FILES["test"])
    dev = read_ids(SET_FILES["dev"])
    assert len(test) == TEST_SIZE
    assert len(dev) == DEV_SIZE
    assert set(test).isdisjoint(dev)


def test_every_task_is_a_namespaced_id_from_the_dataset():
    population = read_ids(POPULATION_FILE)
    assert len(population) == 89
    assert all(task.startswith("terminal-bench/") for task in population)
    for path in SET_FILES.values():
        assert set(read_ids(path)) <= set(population)


def test_the_draw_does_not_depend_on_the_listing_order():
    population = read_ids(POPULATION_FILE)
    assert draw(list(reversed(population))) == draw(population)


def test_a_different_seed_gives_a_different_draw():
    population = read_ids(POPULATION_FILE)
    assert draw(population, seed=1)["test"] != draw(population)["test"]


def test_a_set_becomes_harbor_include_flags(capsys):
    assert include_flags(["terminal-bench/a", "terminal-bench/b"]) == [
        "-i",
        "terminal-bench/a",
        "-i",
        "terminal-bench/b",
    ]
    assert main(["dev"]) == 0
    printed = capsys.readouterr().out.split()
    assert printed[0::2] == ["-i"] * DEV_SIZE
    assert main(["nope"]) == 2
