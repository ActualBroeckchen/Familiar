"""The consolidation LLM call frames the Familiar's own reflection as its own
thinking: the first-person prompt rides as a SYSTEM message, with only a bare,
non-speaking cue in the `user` slot — never as a `user` turn that would frame the
entity as being handed the task.

httpx.post is patched so no network is needed; the fake captures the request
payload. This is the pin the whole-function `_call_llm` mocks in the other
consolidate tests can't provide (they replace the message construction entirely).
"""

from unittest.mock import patch

from phylactery import consolidate


class _FakeResp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"message": {"content": "- rolled up"}}]}


def test_call_llm_sends_prompt_as_system_with_bare_user_cue():
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["json"] = json
        return _FakeResp()

    with patch("httpx.post", fake_post):
        out = consolidate._call_llm(
            {"base_url": "http://x", "api_key": "k", "model": "m"},
            "I am the Familiar. I'm consolidating my daily memory entries into a weekly summary.",
        )

    assert out == "- rolled up"
    msgs = captured["json"]["messages"]
    users = [m for m in msgs if m["role"] == "user"]
    systems = [m for m in msgs if m["role"] == "system"]

    # Exactly one user turn, and it is only the bare non-speaking cue.
    assert len(users) == 1, "exactly one user turn (some providers refuse none)"
    assert users[0]["content"].strip().startswith("("), "the user turn is only a bare cue"
    assert "consolidating" not in users[0]["content"], "the reflection must not sit in the user turn"

    # The first-person consolidation reflection rides as a system message.
    assert any("I am the Familiar" in m["content"] for m in systems), \
        "the Familiar's own consolidation prompt is a system message, not a user turn"
