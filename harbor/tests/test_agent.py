"""The half of the adapter that only exists when Harbor is installed.

``test_trial.py`` deliberately needs nothing but Python, which leaves ``agent.py`` — every
line that couples to ``BaseAgent``, ``logs_dir``, ``AgentContext`` — imported by no gate at
all. These tests close that: they *skip* on a checkout without Harbor rather than failing it,
and they fail loudly on one where Harbor has moved something the agent depends on.

Install it with ``uv run --directory harbor --extra harbor --with pytest pytest`` to have them
run. CI runs the suite without the extra, so a skip here is expected and a failure is not.
"""

from __future__ import annotations

from pathlib import Path

import pytest

harbor_base = pytest.importorskip("harbor.agents.base", reason="Harbor is not installed")

from napbench_harbor.agent import NapbenchAgent, default_repo_root  # noqa: E402


class TestNapbenchAgent:
    def test_is_an_agent_harbor_can_run(self):
        """Every abstract member is implemented — otherwise this constructor raises."""
        agent = NapbenchAgent(logs_dir=Path("/jobs/t1/agent"))

        assert isinstance(agent, harbor_base.BaseAgent)
        assert NapbenchAgent.name() == "napbench"
        assert agent.version()

    def test_writes_where_harbor_told_it_to(self, tmp_path: Path):
        """The job directory is Harbor's to choose; the agent must not have one of its own."""
        agent = NapbenchAgent(logs_dir=tmp_path)

        assert agent.logs_dir == tmp_path

    def test_finds_the_checkout_it_was_installed_from(self):
        root = default_repo_root()

        assert (root / "apps" / "napbench" / "scripts" / "napbench-trial.ts").exists()
