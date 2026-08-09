"""Tests for component.py.

This is the Streamlit UI layer being fully replaced by the Electron/Svelte
redesign (see CLAUDE.md's migration addendum), so coverage here favors the
non-UI orchestration logic (call_llm, generate, _fetch_opencode_models,
_load_viewer_template, _render_preview) with lighter smoke coverage of
render() itself, driven through the streamlit stub in tests/conftest.py.
"""
import json
import os

import nbtlib
import pytest
from nbtlib import tag

import component as component_module
from component import BuilderGPTComponent, get_component


@pytest.fixture(autouse=True)
def _reset_singleton():
    """component.py hand-rolls a process-wide singleton; isolate tests from it."""
    BuilderGPTComponent._initialized = False
    BuilderGPTComponent._instance = None
    BuilderGPTComponent._viewer_template = None
    yield
    BuilderGPTComponent._initialized = False
    BuilderGPTComponent._instance = None
    BuilderGPTComponent._viewer_template = None


@pytest.fixture
def fake_artifact_manager(monkeypatch):
    calls = {"registered": [], "written": []}

    def register_artifact_type(kind):
        calls["registered"].append(kind)

    def write_artifact(*args, **kwargs):
        calls["written"].append((args, kwargs))

    monkeypatch.setattr(component_module.artifact_manager, "register_artifact_type", register_artifact_type)
    monkeypatch.setattr(component_module.artifact_manager, "write_artifact", write_artifact)
    return calls


# --- __init__ / singleton ----------------------------------------------------

def test_init_loads_prompts_and_block_list(fake_artifact_manager):
    comp = BuilderGPTComponent()
    assert "SYS_GEN" in comp.prompts
    assert isinstance(comp.block_id_list, str) and comp.block_id_list
    assert fake_artifact_manager["registered"] == ["schem", "mcfunction"]


def test_get_component_returns_singleton(fake_artifact_manager):
    first = get_component()
    second = get_component()
    assert first is second


def test_second_init_copies_state_without_reregistering(fake_artifact_manager):
    first = BuilderGPTComponent()
    second = BuilderGPTComponent()
    assert second.prompts == first.prompts
    assert second.block_id_list == first.block_id_list
    # register_artifact_type only called during the first construction
    assert fake_artifact_manager["registered"] == ["schem", "mcfunction"]


# --- call_llm -----------------------------------------------------------------

class _FakeChoice:
    def __init__(self, content):
        self.message = type("Msg", (), {"content": content})


class _FakeCompletions:
    def __init__(self, content):
        self._content = content
        self.received_kwargs = None

    def create(self, **kwargs):
        self.received_kwargs = kwargs
        return type("Resp", (), {"choices": [_FakeChoice(self._content)]})


class _FakeChat:
    def __init__(self, content):
        self.completions = _FakeCompletions(content)


class _FakeOpenAIClient:
    captured_init_kwargs = None

    def __init__(self, **kwargs):
        _FakeOpenAIClient.captured_init_kwargs = kwargs
        self.chat = _FakeChat("hello from llm")


@pytest.fixture
def fake_openai(monkeypatch):
    import openai
    monkeypatch.setattr(openai, "OpenAI", _FakeOpenAIClient)
    return _FakeOpenAIClient


@pytest.mark.parametrize(
    "provider,expected_url_fragment",
    [
        ("Google Gemini", "generativelanguage.googleapis.com"),
        ("OpenCode", "console.opencode.ai"),
        ("OpenAI", "api.openai.com"),
        ("Custom (OpenAI Compatible)", None),
    ],
)
def test_call_llm_picks_base_url_per_provider(fake_artifact_manager, fake_openai, provider, expected_url_fragment):
    comp = BuilderGPTComponent()
    result = comp.call_llm(provider, "some-model", "key", None, "sys", "user prompt")

    assert result == "hello from llm"
    if expected_url_fragment:
        assert expected_url_fragment in fake_openai.captured_init_kwargs["base_url"]
    else:
        assert fake_openai.captured_init_kwargs["base_url"] is None


def test_call_llm_uses_none_api_key_placeholder_when_blank(fake_artifact_manager, fake_openai):
    comp = BuilderGPTComponent()
    comp.call_llm("OpenAI", "model", "   ", None, "sys", "user")
    assert fake_openai.captured_init_kwargs["api_key"] == "none"


def test_call_llm_message_payload_includes_image_content(fake_artifact_manager, monkeypatch, tmp_path):
    import openai

    captured = {}

    class _CapturingCompletions:
        def create(self, **kwargs):
            captured.update(kwargs)
            return type("Resp", (), {"choices": [_FakeChoice("ok")]})

    class _CapturingClient:
        def __init__(self, **kwargs):
            self.chat = type("Chat", (), {"completions": _CapturingCompletions()})()

    monkeypatch.setattr(openai, "OpenAI", _CapturingClient)

    comp = BuilderGPTComponent()
    img_path = tmp_path / "ref.jpg"
    img_path.write_bytes(b"\xff\xd8\xff\xe0fakejpeg")

    comp.call_llm("OpenAI", "model", "key", None, "sys prompt", "describe this", image_path=str(img_path))

    user_message = captured["messages"][1]
    assert user_message["role"] == "user"
    types_present = {block["type"] for block in user_message["content"]}
    assert types_present == {"text", "image_url"}


def test_call_llm_wraps_exceptions(fake_artifact_manager, monkeypatch):
    import openai

    class _BoomCompletions:
        def create(self, **kwargs):
            raise RuntimeError("upstream failure")

    class _BoomClient:
        def __init__(self, **kwargs):
            self.chat = type("Chat", (), {"completions": _BoomCompletions()})()

    monkeypatch.setattr(openai, "OpenAI", _BoomClient)

    comp = BuilderGPTComponent()
    with pytest.raises(Exception, match="LLM API Error"):
        comp.call_llm("OpenAI", "model", "key", None, "sys", "user")


# --- generate -------------------------------------------------------------

def test_generate_schem_path_saves_and_registers_artifact(fake_artifact_manager, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    comp = BuilderGPTComponent()
    monkeypatch.setattr(comp, "call_llm", lambda *a, **k: "MyStructure")

    class _FakeSchematic:
        def save(self, folder, name, version_tag):
            os.makedirs(folder, exist_ok=True)
            with open(os.path.join(folder, name + ".schem"), "w") as f:
                f.write("fake")

    monkeypatch.setattr(component_module.core, "text_to_schem", lambda *a, **k: _FakeSchematic())
    monkeypatch.setattr(component_module.core, "input_version_to_mcs_tag", lambda v: "TAG")

    path = comp.generate(
        provider="OpenAI", model="m", api_key="k", base_url=None,
        description="a small house", version="JE_1_20_1", export_type="schem",
    )

    assert path.endswith(".schem")
    assert os.path.isfile(path)
    assert len(fake_artifact_manager["written"]) == 1


def test_generate_mcfunction_path_renames_temp_file(fake_artifact_manager, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    comp = BuilderGPTComponent()
    monkeypatch.setattr(comp, "call_llm", lambda *a, **k: "MyStructure")

    os.makedirs("generated", exist_ok=True)
    temp_path = os.path.join("generated", "temp.mcfunction")
    with open(temp_path, "w") as f:
        f.write("setblock 0 0 0 minecraft:stone\n")

    monkeypatch.setattr(component_module.core, "text_to_schem", lambda *a, **k: temp_path)
    monkeypatch.setattr(component_module.core, "input_version_to_mcs_tag", lambda v: "TAG")

    path = comp.generate(
        provider="OpenAI", model="m", api_key="k", base_url=None,
        description="a small house", version="JE_1_20_1", export_type="mcfunction",
    )

    assert path.endswith(".mcfunction")
    assert os.path.isfile(path)
    assert not os.path.exists(temp_path)


def test_generate_returns_none_when_text_to_schem_fails(fake_artifact_manager, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    comp = BuilderGPTComponent()
    monkeypatch.setattr(comp, "call_llm", lambda *a, **k: "MyStructure")
    monkeypatch.setattr(component_module.core, "text_to_schem", lambda *a, **k: None)
    monkeypatch.setattr(component_module.core, "input_version_to_mcs_tag", lambda v: "TAG")

    result = comp.generate(
        provider="OpenAI", model="m", api_key="k", base_url=None,
        description="a small house", version="JE_1_20_1", export_type="schem",
    )
    assert result is None


def test_generate_reports_progress(fake_artifact_manager, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    comp = BuilderGPTComponent()
    monkeypatch.setattr(comp, "call_llm", lambda *a, **k: "MyStructure")
    monkeypatch.setattr(component_module.core, "text_to_schem", lambda *a, **k: None)
    monkeypatch.setattr(component_module.core, "input_version_to_mcs_tag", lambda v: "TAG")

    progress_calls = []

    class _Progress:
        def progress(self, value):
            progress_calls.append(value)

    comp.generate(
        provider="OpenAI", model="m", api_key="k", base_url=None,
        description="a small house", version="JE_1_20_1", export_type="schem",
        progress=_Progress(),
    )
    assert progress_calls == [0.2, 0.6, 0.8]


# --- _fetch_opencode_models -------------------------------------------------

def test_fetch_opencode_models_categorizes_and_sorts(monkeypatch):
    import requests

    class _Resp:
        status_code = 200

        def json(self):
            return {
                "data": [
                    {"id": "z-model"},
                    {"id": "a-model-free"},
                    {"id": "m-reasoning-thinker"},
                    {"id": ""},
                ]
            }

    monkeypatch.setattr(requests, "get", lambda *a, **k: _Resp())

    models = BuilderGPTComponent._fetch_opencode_models()

    ids = [m[0] for m in models]
    assert ids == sorted(ids)
    assert "" not in ids
    labels = dict(models)
    assert "Gratuito" in labels["a-model-free"]


def test_fetch_opencode_models_returns_none_on_non_200(monkeypatch):
    import requests

    class _Resp:
        status_code = 500

        def json(self):
            return {}

    monkeypatch.setattr(requests, "get", lambda *a, **k: _Resp())
    assert BuilderGPTComponent._fetch_opencode_models() is None


def test_fetch_opencode_models_returns_none_on_exception(monkeypatch):
    import requests

    def _raise(*a, **k):
        raise ConnectionError("network down")

    monkeypatch.setattr(requests, "get", _raise)
    assert BuilderGPTComponent._fetch_opencode_models() is None


# --- _load_viewer_template ---------------------------------------------------

def test_load_viewer_template_embeds_assets_and_caches(fake_artifact_manager):
    comp = BuilderGPTComponent()
    first = comp._load_viewer_template()
    assert "__THREE_MODULE__" not in first  # placeholder replaced
    assert BuilderGPTComponent._viewer_template is not None

    second = comp._load_viewer_template()
    assert second is first  # served from the class-level cache


# --- _render_preview ---------------------------------------------------------

def _write_fixture_schem(path):
    payload = {
        "Width": tag.Short(1),
        "Height": tag.Short(1),
        "Length": tag.Short(1),
        "Palette": tag.Compound({"minecraft:stone": tag.Int(0)}),
        "BlockData": tag.ByteArray([0]),
    }
    nbtlib.File(payload, gzipped=True).save(str(path))


def test_render_preview_missing_file_warns(fake_artifact_manager):
    from app.preview import PreviewOptions

    comp = BuilderGPTComponent()
    options = PreviewOptions(0, 0, 1, 1, 100, True, False, True)
    # Should not raise even though the file doesn't exist.
    comp._render_preview("/does/not/exist.schem", None, options)


def test_render_preview_success_renders_html(fake_artifact_manager, tmp_path, monkeypatch):
    from app.preview import PreviewOptions

    schem_path = tmp_path / "fixture.schem"
    _write_fixture_schem(schem_path)

    rendered = {}
    monkeypatch.setattr(component_module, "html", lambda content, height=None: rendered.update(content=content, height=height))

    comp = BuilderGPTComponent()
    options = PreviewOptions(0, 0, 1, 1, 100, True, False, True)
    comp._render_preview(str(schem_path), None, options)

    assert "params_json" not in rendered  # sanity: we captured the html() call, not raw dict
    assert rendered["height"] == 720
    assert "__PAYLOAD__" not in rendered["content"]


# --- render() smoke coverage --------------------------------------------------

def test_render_smoke_no_generate_click(fake_artifact_manager, monkeypatch):
    """Exercise the top-to-bottom layout path without triggering generate()."""
    import streamlit as st

    monkeypatch.setattr(st, "button", lambda *a, **k: False)
    monkeypatch.setattr(st, "selectbox", lambda label, options, **k: options[0])
    monkeypatch.setattr(st, "text_area", lambda *a, **k: "")
    monkeypatch.setattr(st, "file_uploader", lambda *a, **k: None)

    comp = BuilderGPTComponent()
    comp.render()  # should not raise


def test_render_smoke_generate_click_without_api_key_shows_error(fake_artifact_manager, monkeypatch):
    import streamlit as st

    errors = []
    monkeypatch.setattr(st, "error", lambda msg: errors.append(msg))
    monkeypatch.setattr(st, "selectbox", lambda label, options, **k: options[0])
    monkeypatch.setattr(st, "text_area", lambda *a, **k: "a description")
    monkeypatch.setattr(st, "text_input", lambda label, **k: "")
    monkeypatch.setattr(st, "file_uploader", lambda *a, **k: None)

    def fake_button(label, **kwargs):
        return label == "Generate"

    monkeypatch.setattr(st, "button", fake_button)

    comp = BuilderGPTComponent()
    comp.render()

    assert any("API Key" in msg for msg in errors)
