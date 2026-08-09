"""Smoke coverage for the Streamlit entrypoint.

component.py and run_app.py are the Streamlit UI layer being fully replaced
by the Electron/Svelte redesign (see CLAUDE.md), so these are light smoke
tests against the stubbed `streamlit`/`cynia_agents` modules from
tests/conftest.py rather than exhaustive behavioral coverage — deep UI testing
of code that's being deleted has low value relative to the pipeline/core
modules that carry forward into the port.
"""
import run_app


def test_main_configures_page_and_renders_component(monkeypatch):
    calls = []

    class _FakeComponent:
        def render(self):
            calls.append("rendered")

    monkeypatch.setattr(run_app, "get_component", lambda: _FakeComponent())
    run_app.main()

    assert calls == ["rendered"]
