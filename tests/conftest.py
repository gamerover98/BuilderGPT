"""Shared test fixtures and stubs for optional/unavailable runtime dependencies.

Some of BuilderGPT's dependencies (cynia-agents, streamlit, openai, requests,
quickjs) are either private packages not published in a way this sandbox can
install, or require native build tooling unavailable here (quickjs needs a
C compiler toolchain). They are stubbed with minimal fakes so the modules
that import them can be imported and their *own* logic exercised — the stubs
carry no logic of their own and are never asserted against directly.
"""
from __future__ import annotations

import sys
import types


def _install_stub_module(name: str, **attrs) -> types.ModuleType:
    if name in sys.modules:
        return sys.modules[name]
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


def _noop_logger(*args, **kwargs):
    return None


# --- cynia_agents (private package, not installed) -------------------------
cynia_agents_pkg = _install_stub_module("cynia_agents")
cynia_agents_pkg.__path__ = []  # mark as package

log_writer_mod = _install_stub_module("cynia_agents.log_writer", logger=_noop_logger)
cynia_agents_pkg.log_writer = log_writer_mod


class _StubBaseComponent:
    """Minimal stand-in for cynia_agents.component_base.BaseComponent."""

    def __init__(self, *args, **kwargs):
        pass

    def render(self):  # pragma: no cover - overridden by subclasses
        raise NotImplementedError


component_base_mod = _install_stub_module(
    "cynia_agents.component_base", BaseComponent=_StubBaseComponent
)
cynia_agents_pkg.component_base = component_base_mod


class _StubArtifactManager:
    @staticmethod
    def save(*args, **kwargs):
        return None

    @staticmethod
    def load(*args, **kwargs):
        return None


artifact_manager_mod = _install_stub_module(
    "cynia_agents.artifact_manager",
    ArtifactManager=_StubArtifactManager,
    register_artifact_type=_noop_logger,
    write_artifact=_noop_logger,
)
cynia_agents_pkg.artifact_manager = artifact_manager_mod


# --- streamlit (heavy UI dependency, app is being replaced by Electron) ----
class _SessionState(dict):
    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError as exc:
            raise AttributeError(item) from exc

    def __setattr__(self, key, value):
        self[key] = value


def _st_noop(*args, **kwargs):
    return None


def _st_context_noop(*args, **kwargs):
    class _Ctx:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    return _Ctx()


class _AutoStub:
    """Catch-all stand-in for any streamlit attribute not explicitly stubbed.

    Callable (works as a plain function, a decorator, or a decorator
    factory — `@st.cache_data` and `@st.cache_data(ttl=3600)` both work) and
    usable as a context manager (`with st.spinner(...):`).
    """

    def __call__(self, *args, **kwargs):
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]  # used directly as a decorator: @st.something
        return self  # decorator factory or a plain widget call

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __getattr__(self, item):
        return _AutoStub()


class _WidgetColumnProxy:
    """Stand-in for a `st.columns(...)` cell: delegates `col.widget(...)` calls
    to the same top-level `st.widget` stub, so `col1.slider(...)` behaves
    exactly like `st.slider(...)` instead of needing its own definition."""

    def __getattr__(self, item):
        return getattr(streamlit_mod, item, _AutoStub())

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _slider_stub(label, min_value=None, max_value=None, value=None, **kwargs):
    return value if value is not None else min_value


def _checkbox_stub(label, value=False, **kwargs):
    return value


def _radio_stub(label, options, **kwargs):
    return options[0] if options else None


streamlit_mod = _install_stub_module(
    "streamlit",
    session_state=_SessionState(),
    __path__=[],
    set_page_config=_st_noop,
    write=_st_noop,
    error=_st_noop,
    warning=_st_noop,
    info=_st_noop,
    success=_st_noop,
    title=_st_noop,
    divider=_st_noop,
    image=_st_noop,
    progress=lambda *a, **k: _AutoStub(),
    slider=_slider_stub,
    checkbox=_checkbox_stub,
    radio=_radio_stub,
    text_area=lambda *a, **k: "",
    text_input=lambda *a, **k: "",
    selectbox=lambda label, options, **k: (options[k.get("index", 0)] if options else None),
    button=lambda *a, **k: False,
    file_uploader=lambda *a, **k: None,
    tabs=lambda labels: [_st_context_noop() for _ in labels],
    sidebar=_st_context_noop(),
    columns=lambda n, **k: [_WidgetColumnProxy() for _ in range(n if isinstance(n, int) else len(n))],
    spinner=_st_context_noop,
    expander=_st_context_noop,
    container=lambda *a, **k: _AutoStub(),
    markdown=_st_noop,
    caption=_st_noop,
)

components_mod = _install_stub_module("streamlit.components", __path__=[])
components_v1_mod = _install_stub_module("streamlit.components.v1", html=_st_noop)
streamlit_mod.components = components_mod
components_mod.v1 = components_v1_mod


def _streamlit_module_getattr(name):
    return _AutoStub()


streamlit_mod.__getattr__ = _streamlit_module_getattr


# --- openai / requests (network clients, network calls are out of scope) ---
class _StubOpenAIClient:
    def __init__(self, *args, **kwargs):
        pass


openai_mod = _install_stub_module("openai", OpenAI=_StubOpenAIClient)

requests_mod = _install_stub_module("requests")


def _requests_get_stub(*args, **kwargs):
    class _Resp:
        status_code = 200

        def json(self):
            return {}

    return _Resp()


requests_mod.get = _requests_get_stub
requests_mod.post = _requests_get_stub
