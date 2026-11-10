"""Claude through Claude Code: only on the subscription login, and it stops at the plan's limits.
Uses tests/fake_claude.py in place of the real `claude` command, so no plan usage."""
import json
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from m5e import brain  # noqa: E402

FAKE = Path(__file__).resolve().parent / "fake_claude.py"
CONTENT = [{"type": "text", "text": "Shot c01s01"}, {"type": "text", "text": "Log all 1 shots above."}]


@unittest.skipIf(os.name == "nt", "the fake claude command is a POSIX script")
class TestClaudeCode(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        exe = self.tmp / "claude"
        exe.write_text(f"#!/bin/sh\nexec \"{sys.executable}\" \"{FAKE}\" \"$@\"\n")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        self.log = self.tmp / "calls.jsonl"
        self.env = mock.patch.dict(os.environ, {"FAKE_LOG": str(self.log), "FAKE_SCENARIO": "ok"})
        self.env.start()
        self.patches = [mock.patch.object(brain, "_exe", lambda: str(exe)),
                        mock.patch.object(brain, "LIMIT_FILE", self.tmp / "claude_limit.json"),
                        mock.patch.object(brain, "STATE_DIR", self.tmp),
                        mock.patch.object(brain, "log", self.logged)]
        for p in self.patches:
            p.start()
        self.messages = []
        brain._session.clear()
        brain._warned.clear()
        brain._flag_cache.clear()
        brain._login.update(t=0.0, ok=False, why="")
        brain.configure(True)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.env.stop()

    def logged(self, m):
        self.messages.append(m)

    def ask(self, scenario, model="sonnet", timeout=60):
        os.environ["FAKE_SCENARIO"] = scenario
        return brain._ask(CONTENT, brain.ShotNotes, brain.DESCRIBE_SYSTEM, model=model, timeout=timeout)

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_answer_through_subscription_only(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-api03-x", "ANTHROPIC_BASE_URL": "http://x",
                                          "ANTHROPIC_AUTH_TOKEN": "t", "CLAUDE_CODE_USE_BEDROCK": "1",
                                          "CLAUDECODE": "1", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-x"}):
            out = self.ask("ok")
        self.assertEqual(out.shots[0].id, "c01s01")
        call = self.calls()[0]
        self.assertEqual(call["env"], ["CLAUDE_CODE_OAUTH_TOKEN"])     # no key, endpoint or provider switch
        argv = call["argv"]
        for flag in ("--restricted", "--safe-mode", "--strict-mcp-config", "--json-schema", "--system-prompt-file"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(call["request"]["message"]["content"], CONTENT)
        self.assertTrue(brain.available())

    def test_login_must_be_a_subscription(self):
        cases = {'{"loggedIn": false}': False,
                 '{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty"}': False,
                 '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "bedrock"}': False,
                 '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", '
                 '"apiKeySource": "apiKeyHelper"}': False,
                 '{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}': True,
                 '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", '
                 '"subscriptionType": "max"}': True}
        for status, ok in cases.items():
            with mock.patch.dict(os.environ, {"FAKE_STATUS": status}):
                self.assertEqual(brain.login(force=True)[0], ok, status)
        with mock.patch.dict(os.environ, {"FAKE_STATUS": '{"loggedIn": false}'}):
            brain.login(force=True)
            self.assertFalse(brain.available())
            with self.assertRaises(brain.BrainError):
                self.ask("ok")
        self.assertEqual(self.calls(), [])

    def test_limit_stops_and_is_remembered_until_reset(self):
        with self.assertRaises(brain.LimitHit):
            self.ask("limit")
        self.assertFalse(brain.available())
        saved = json.loads((self.tmp / "claude_limit.json").read_text())
        self.assertGreater(saved["*"]["until"], time.time() + 3600)
        brain._session.clear()                      # a new run (or the review page restarted) still waits
        self.assertFalse(brain.available())
        with self.assertRaises(brain.LimitHit):
            self.ask("ok")
        self.assertEqual(len(self.calls()), 1)      # no further requests while the limit is in force
        saved["*"]["until"] = time.time() - 1       # after the reset, Claude is used again
        (self.tmp / "claude_limit.json").write_text(json.dumps(saved))
        brain._session.clear()
        self.assertTrue(brain.available())

    def test_limit_message_text(self):
        with self.assertRaises(brain.LimitHit):
            self.ask("text_limit")
        self.assertFalse(brain.available())

    def test_paid_usage_stops_everything(self):
        with self.assertRaises(brain.LimitHit) as e:
            self.ask("overage")
        self.assertIn("paid usage credits", str(e.exception))
        self.assertFalse(brain.available())

    def test_extra_usage_on_stops_at_the_warning(self):
        out = self.ask("warn_extra")                # this answer is still inside the plan: keep it
        self.assertEqual(out.shots[0].id, "c01s01")
        self.assertFalse(brain.available())
        self.assertTrue(any("nothing is billed" in m for m in self.messages))

    def test_warning_alone_keeps_going(self):
        self.ask("warn")
        self.assertTrue(brain.available())
        self.assertTrue(any("91%" in m for m in self.messages))

    def test_model_limit_switches_model(self):
        out = self.ask("opus_limit", model="opus")
        self.assertEqual(out.shots[0].id, "c01s01")
        self.assertEqual([c["model"] for c in self.calls()], ["opus", "sonnet"])
        self.assertTrue(brain.available())

    def test_api_key_session_is_stopped(self):
        t = time.time()
        with self.assertRaises(brain.BrainError):
            self.ask("apikey")
        self.assertLess(time.time() - t, 20)        # killed at start-up, not left running

    def test_timeout(self):
        with self.assertRaises(brain.BrainError):
            self.ask("hang", timeout=2)

    def test_switched_off(self):
        brain.configure(False)
        self.assertFalse(brain.available())
        with self.assertRaises(brain.BrainError):
            self.ask("ok")
        self.assertEqual(self.calls(), [])


class TestSchema(unittest.TestCase):
    def test_inline_has_no_refs(self):
        for schema in (brain.ShotNotes, brain.DirectorPlan, brain.Review, brain.TalkPlan, brain.RefProfile):
            text = json.dumps(brain._inline(schema.model_json_schema()))
            self.assertNotIn("$ref", text)
            self.assertNotIn("$defs", text)

    def test_limit_wording(self):
        for t in ("You've hit your limit · resets 3pm", "You've reached your Opus limit", "Claude AI usage limit reached|1700000000",
                  "You're out of usage credits", "Opus 5 requires usage credits.", "Now using extra usage"):
            self.assertTrue(brain._is_limit(t), t)
        for t in ("API Error: 500 Internal server error", "Request timed out", ""):
            self.assertFalse(brain._is_limit(t), t)


if __name__ == "__main__":
    unittest.main()
