"""Local pilot fixtures. Their rules and held-out answers are independently specified."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SOURCE = r'''
type Summary = { info: number; warn: number; error: number; malformed: number; messages: string[] };
export function run(input: unknown): Summary {
  if (!Array.isArray(input)) throw new TypeError("Expected an array of log lines");
  const out: Summary = {info:0,warn:0,error:0,malformed:0,messages:[]};
  for (const line of input) {
    const match = typeof line === "string" ? /^(INFO|WARN|ERROR) (.+)$/.exec(line) : null;
    if (!match) { out.malformed += 1; continue; }
    const level = match[1]!.toLowerCase() as "info"|"warn"|"error";
    out[level] += 1;
    out.messages.push(match[2]!);
  }
  return out;
}
'''.strip()

CASES = [
    {"name": "ordinary", "input": ["INFO boot", "ERROR dropped"],
     "expected": {"info": 1, "warn": 0, "error": 1, "malformed": 0, "messages": ["boot", "dropped"]}},
    {"name": "empty", "input": [],
     "expected": {"info": 0, "warn": 0, "error": 0, "malformed": 0, "messages": []}},
]
HOLDOUT = ["WARN first", "error lower case", None, "ERROR last", "INFO final"]
EXPECTED = {"info": 1, "warn": 1, "error": 1, "malformed": 2, "messages": ["first", "last", "final"]}
DOC = ("Input is an array of lines. A record starts with INFO, WARN or ERROR and one space, "
       "followed by a nonempty message. Count lines by severity and count malformed records. "
       "Keep valid messages in input order. Empty input returns zero counts and an empty list.\n")


def draft():
    return {"title": "Log diagnostic", "inputs": "JSON array of values",
            "outputs": "Counts by severity, malformed count, messages in the original order",
            "rules": [
                {"text": "Recognize uppercase INFO, WARN and ERROR followed by a nonempty message.",
                 "state": "Observed", "evidence": ["E1"]},
                {"text": "Count malformed input and preserve the order of valid messages.",
                 "state": "Observed", "evidence": ["E1"]},
                {"text": "Log formats outside the stated contract are unknown.",
                 "state": "Unknown", "evidence": []},
            ], "cases": CASES}


class FixtureModel(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 130000 or self.path != "/v1/chat/completions":
            self.send_error(400)
            return
        body = json.loads(self.rfile.read(length))
        messages = body["messages"]
        self.calls.append(messages)
        answer = {"source": SOURCE} if messages[0]["content"].startswith("Implement") else draft()
        data = json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def mcp():
    for line in sys.stdin:
        message = json.loads(line)
        if message["method"] == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "pilot-reference", "version": "1"}}
        elif message["method"] == "tools/call" and message["params"]["name"] == "lookup":
            result = {"content": [], "structuredContent": {
                "summary": message["params"]["arguments"]["input"],
                "reference": "Fixed fixture severity reference",
            }}
        else:
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "mcp":
        mcp()
    elif sys.argv[1] == "plugin":
        print(json.dumps({"input": json.load(sys.stdin), "plugin": "pilot-local"}))
