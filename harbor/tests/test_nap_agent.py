"""The half of the Terminal-Bench adapter that only exists when Harbor is installed.

Skips on a checkout without Harbor, and fails where Harbor has moved
something ``nap_harbor/agent.py`` depends on.
"""

from __future__ import annotations

from pathlib import Path

import pytest

harbor_base = pytest.importorskip("harbor.agents.base", reason="Harbor is not installed")

from nap_harbor.agent import NapAgent  # noqa: E402


class TestNapAgent:
    def test_is_an_agent_harbor_can_run(self):
        agent = NapAgent(logs_dir=Path("/jobs/t1/agent"))

        assert isinstance(agent, harbor_base.BaseAgent)
        assert NapAgent.name() == "nap"
        assert agent.version()

    def test_takes_its_model_from_harbor(self, tmp_path: Path):
        agent = NapAgent(logs_dir=tmp_path, model_name="nvidia/nemotron-3-ultra-550b-a55b:free")

        assert agent.model_name == "nvidia/nemotron-3-ultra-550b-a55b:free"
        assert agent.logs_dir == tmp_path
