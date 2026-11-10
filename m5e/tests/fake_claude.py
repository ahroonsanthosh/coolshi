#!/usr/bin/env python3
"""A stand-in for the `claude` command in the tests: prints what Claude Code prints in each situation (the
message shapes come from Claude Code's own stream-json output), so the tests never use a real plan.
FAKE_SCENARIO picks the situation, FAKE_LOG records how it was started."""
import json
import os
import sys
import time

argv = sys.argv[1:]
scenario = os.environ.get("FAKE_SCENARIO", "ok")


def out(obj):
    print(json.dumps(obj), flush=True)


if argv[:1] == ["--help"]:
    print("Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --input-format <format>\n"
          "  --json-schema <schema>\n  --model <model>\n  --effort <level>\n  --tools <tools...>\n"
          "  --restricted\n  --safe-mode\n  --strict-mcp-config\n  --no-session-persistence\n"
          "  --system-prompt <prompt>\n  --system-prompt-file <file>\n  --verbose")
    sys.exit(0)

if argv[:2] == ["auth", "status"]:
    out(json.loads(os.environ.get("FAKE_STATUS", '{"loggedIn": true, "authMethod": "claude.ai", '
                                                 '"apiProvider": "firstParty", "subscriptionType": "max"}')))
    sys.exit(0)

request = json.loads(sys.stdin.readline())
model = argv[argv.index("--model") + 1]
if os.environ.get("FAKE_LOG"):
    with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": argv, "model": model, "request": request,
                            "env": sorted(k for k in os.environ if k.startswith(("ANTHROPIC", "CLAUDE")))}) + "\n")
reset = int(time.time()) + 5400
ANSWER = {"shots": [{"id": "c01s01", "what": "two founders laughing at a cafe table", "people": "two founders",
                     "setting": "cafe", "shot_type": "group", "energy": 4, "hook": 4, "focus_ok": True,
                     "framing_ok": True, "filler": False, "best_part": "middle", "action": False,
                     "photo_moment": False, "tags": ["cafe", "laughing"]}]}


def init(source="none"):
    out({"type": "system", "subtype": "init", "apiKeySource": source, "model": model, "session_id": "s"})


def answer(info=None):
    out({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t1", "name": "StructuredOutput", "input": ANSWER}]}})
    out({"type": "rate_limit_event", "rate_limit_info": info or {"status": "allowed", "resetsAt": reset,
                                                                 "isUsingOverage": False}})
    out({"type": "result", "subtype": "success", "is_error": False, "result": json.dumps(ANSWER),
         "structured_output": ANSWER})


if scenario == "ok" or (scenario == "opus_limit" and "opus" not in model):
    init()
    answer()
elif scenario in ("limit", "opus_limit"):
    init()
    out({"type": "rate_limit_event", "rate_limit_info": {
        "status": "rejected", "resetsAt": reset, "isUsingOverage": False,
        "rateLimitType": "seven_day_opus" if scenario == "opus_limit" else "five_hour"}})
    out({"type": "assistant", "error": "rate_limit", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "You've hit your limit · resets 3pm (Europe/Dublin)"}]}})
    out({"type": "result", "subtype": "success", "is_error": True,
         "result": "You've hit your limit · resets 3pm (Europe/Dublin)"})
elif scenario == "text_limit":
    init()
    out({"type": "assistant", "error": "rate_limit", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "You've hit your weekly limit · resets Mon 9am"}]}})
    out({"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your weekly limit"})
elif scenario == "overage":
    init()
    answer({"status": "rejected", "resetsAt": reset, "rateLimitType": "five_hour", "overageStatus": "allowed",
            "isUsingOverage": True})
elif scenario == "warn_extra":
    init()
    answer({"status": "allowed_warning", "resetsAt": reset, "rateLimitType": "five_hour", "utilization": 0.92,
            "overageStatus": "allowed", "isUsingOverage": False})
elif scenario == "warn":
    init()
    answer({"status": "allowed_warning", "resetsAt": reset, "rateLimitType": "five_hour", "utilization": 0.91,
            "isUsingOverage": False})
elif scenario == "apikey":
    init("ANTHROPIC_API_KEY")
    time.sleep(30)
    answer()
elif scenario == "hang":
    init()
    time.sleep(30)
