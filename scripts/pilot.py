"""Prepare and exercise the private REA Workbench candidate through Desk Code."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import zipfile
from http.server import HTTPServer
from contextlib import closing
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / "tests"))
from fixture import DOC, EXPECTED, HOLDOUT, FixtureModel

PY = str(Path(sys.executable).resolve())
FIXTURE = str(APP / "tests" / "fixture.py")


def default_catalog():
    catalog = json.loads((APP / "vendor" / "catalog.json").read_bytes())
    catalog["source"] = str(APP / "vendor" / "rea-result")
    return catalog


def executable(name):
    found = shutil.which(name)
    if not found:
        raise RuntimeError(name + " is missing")
    return str(Path(found).resolve())


def config_for(desk, run, models, vendor=None):
    rea = Path(os.environ["APPDATA"]) / "npm" / "node_modules" / "rea-agents"
    meta = json.loads((rea / "package.json").read_bytes())
    if meta["version"] != "6.10.1":
        raise RuntimeError("The pilot requires rea-agents 6.10.1")
    imports = run / "imports"
    imports.mkdir(parents=True, exist_ok=True)
    return {
        "projects": str(run / "projects"), "imports": str(imports),
        "models": models, "docker": executable("docker.exe"),
        "rea": [executable("node.exe"), str(rea / "scripts" / "rea.mjs")],
        "local": [PY, "-B", FIXTURE, "plugin"],
        "mcp_client": [PY, "-B", str(desk / "desk_code" / "workbench_mcp_client.py")],
        "mcp": {"argv": [PY, "-B", FIXTURE, "mcp"], "tool": "lookup"},
        "vendor": vendor,
    }


def verify_import(desk, run, bundle):
    from desk_code.workbench_supervisor import Supervisor
    config = config_for(desk, run, {}, default_catalog())
    target = Path(config["imports"]) / "bundle.json"
    shutil.copyfile(bundle, target)
    second = Supervisor(config)
    restored = act(second, "importBundle", path=str(target))
    id = restored["id"]
    portable = act(second, "ruleEvidence", id=id, revision=restored["specRevision"], index=0)
    assert portable[0]["id"] == "E1" and "excerpt" not in portable[0]
    args = {"id": id, "input": {"artifact": "E2", "logs": HOLDOUT}, "step": None}
    assert not second.perform("run", args)["ok"]
    act(second, "approveSpec", id=id, revision=restored["specRevision"])
    act(second, "acceptCode", id=id, revision=restored["draft"]["revision"])
    return act(second, "run", **args)


def act(supervisor, op, **args):
    result = supervisor.perform(op, args)
    assert result["ok"], (op, result)
    return result["value"]


def acceptance(desk, second_desk=None):
    from desk_code.workbench_supervisor import Supervisor
    with tempfile.TemporaryDirectory(prefix="desk-workbench-pilot-") as td, HTTPServer(("127.0.0.1", 0), FixtureModel) as model:
        base = Path(td).resolve()
        config = config_for(desk, base / "one", {"fixture": {
            "endpoint": f"http://127.0.0.1:{model.server_port}/v1/chat/completions",
            "cloud": False, "model": "deterministic-fixture",
        }}, default_catalog())
        server = threading.Thread(target=model.serve_forever, daemon=True)
        server.start()
        try:
            first = Supervisor(config)
            imported = Path(config["imports"])
            log = imported / "behavior.txt"
            original_text = DOC + "api_key=synthetic_private_marker\n"
            log.write_text(original_text, encoding="utf-8")
            artifact = imported / "where.exe"
            shutil.copyfile(Path(os.environ["SystemRoot"]) / "System32" / "where.exe", artifact)

            id = act(first, "create", name="Log diagnostic")["id"]
            act(first, "import", id=id, path=str(log))
            result = act(first, "import", id=id, path=str(artifact))
            inspection = result["evidence"][1]["inspection"]
            assert inspection["evidenceId"].startswith("ev_")
            unsupported = imported / "unsupported.bin"
            unsupported.write_bytes(b"synthetic")
            assert not first.perform("import", {"id":id, "path":str(unsupported)})["ok"]
            assert not first.perform("prepareDraft", {"id":id, "connection":"unregistered"})["ok"]
            archive = imported / "sample.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("behavior.txt", DOC)
            result = act(first, "import", id=id, path=str(archive))
            assert result["evidence"][2]["inspection"]["evidenceId"].startswith("ev_")
            act(first, "vendor", id=id, component="rea-result")
            draft = act(first, "prepareDraft", id=id, connection="fixture")
            assert "synthetic_private_marker" not in json.dumps(draft)
            decline = first.perform("confirmModel", {"ticket": draft["ticket"], "consent": False})
            assert not decline["ok"] and not FixtureModel.calls
            draft = act(first, "prepareDraft", id=id, connection="fixture")
            state = act(first, "confirmModel", ticket=draft["ticket"], consent=True)
            review = {"id": id, "revision": state["specRevision"]}
            row, = act(first, "ruleEvidence", **review, index=0)
            assert row["id"] == "E1" and "malformed records" in row["excerpt"]
            assert "synthetic_private_marker" not in row["excerpt"]
            assert not act(first, "ruleEvidence", **review, index=2)
            assert not first.perform("ruleEvidence", {**review, "index": True})["ok"]
            original = state["spec"]
            changed_rules = [dict(rule) for rule in original["rules"]]
            changed_rules[0] = {"text": "The test artifact has REA inspection evidence.",
                                "state": "Observed", "evidence": ["E2"]}
            changed = act(first, "saveSpec", id=id, spec={**original, "rules": changed_rules})
            assert not first.perform("ruleEvidence", {**review, "index": 0})["ok"]
            artifact_row, = act(first, "ruleEvidence", id=id, revision=changed["specRevision"], index=0)
            assert artifact_row["inspection"]["evidenceId"] == inspection["evidenceId"]
            assert "local" not in artifact_row
            state = act(first, "saveSpec", id=id, spec=original)
            act(first, "approveSpec", id=id, revision=state["specRevision"])
            code = act(first, "prepareCode", id=id, connection="fixture")
            assert "api_key" not in json.dumps(code)
            assert "where.exe" not in json.dumps(code)
            generated = act(first, "confirmModel", ticket=code["ticket"], consent=True)
            act(first, "acceptCode", id=id, revision=generated["draft"]["revision"])
            assert act(first, "testCode", id=id)["passed"]
            ambient = first.runtime.generated(
                'export function run(): unknown { return Boolean(process.env.OPENAI_API_KEY); }', None)
            assert ambient is False
            try:
                first.runtime.run([PY, "-B", "-c", "import time; time.sleep(3)"], timeout=.1)
            except ValueError as exc:
                assert "time limit" in str(exc)
            else:
                raise AssertionError("Deadline did not stop a slow native operation")
            recipe = [
                {"id": "inspect", "kind": "rea", "from": "input.artifact"},
                {"id": "diagnose", "kind": "generated", "from": "input.logs"},
                {"id": "reference", "kind": "mcp", "from": "diagnose"},
                {"id": "plugin", "kind": "local", "from": "reference"},
            ]
            act(first, "saveRecipe", id=id, steps=recipe)
            assert not first.perform("saveRecipe", {"id":id, "steps":[
                {"id": "bad", "kind": "local", "from": "future"}
            ]})["ok"]
            args = {"id": id, "input": {"artifact": "E2", "logs": HOLDOUT}, "step": None}
            assert not first.perform("run", {**args, "input": {"logs": HOLDOUT}})["ok"]
            actual = act(first, "run", **args)
            assert actual["diagnose"] == EXPECTED
            assert actual["reference"]["summary"] == EXPECTED
            assert actual["plugin"]["input"]["summary"] == EXPECTED
            assert act(first, "get", id=id)["steps"] == recipe
            export = act(first, "export", id=id)
            export_dir = Path(export["path"])
            assert {"index.ts", "cli.ts", "behavior.test.ts", "bundle.json"} <= {path.name for path in export_dir.iterdir()}
            assert first.runtime.generated((export_dir / "index.ts").read_text(encoding="utf-8"), HOLDOUT,
                                           (export_dir / "cli.ts").read_text(encoding="utf-8")) == actual["diagnose"]
            assert all("synthetic_private_marker" not in path.read_text(encoding="utf-8") for path in export_dir.iterdir() if path.is_file())
            assert (export_dir / "vendor/rea-result/LICENSE").is_file()
            assert json.loads((export_dir / "provenance.json").read_bytes())[0]["commit"] == "8bb01b514ac766c0c3ecc8f362bd38186eaec9c2"
            if second_desk:
                command = [PY, "-B", str(Path(__file__).resolve()), "verify-import",
                           "--desk", str(second_desk), "--bundle", export["bundle"]]
                result = subprocess.run(command, capture_output=True, text=True, timeout=50, check=True)
                repro = json.loads(result.stdout)
            else:
                repro = verify_import(desk, base / "two", export["bundle"])
            assert repro == actual
            first.cancel.set()
            assert not first.perform("run", args)["ok"]
            with closing(sqlite3.connect(first.receipts)) as db:
                n = db.execute("SELECT count(*) FROM receipts").fetchone()[0]
            assert len(FixtureModel.calls) == 2
            print(json.dumps({"passed": True, "rea": inspection["evidenceId"], "mcp": "local-stdio",
                              "generated": "docker-network-none", "receipts": n, "model": "localhost-fixture",
                              "roundtrip": "separate Desk Code checkout and process" if second_desk else "independent private stores", "heldOut": EXPECTED}))
        finally:
            model.shutdown()
            server.join(timeout=5)


def launch_window(config, smoke=False):
    from desk_code.workbench_supervisor import Supervisor
    # Stage only the runtime in OS temp so it inherits Windows' normal renderer ACLs.
    with tempfile.TemporaryDirectory(prefix="desk-workbench-electron-") as td:
        dist = Path(td) / "dist"
        shutil.copytree(APP / "node_modules/electron/dist", dist, copy_function=shutil.copyfile)
        # Electron and its public runtime files are the only content in this disposable directory.
        # Grant the renderer read/execute here without changing the project or host defaults.
        icacls = Path(os.environ["SystemRoot"]) / "System32" / "icacls.exe"
        subprocess.run([str(icacls), str(dist), "/grant", "*S-1-15-2-1:(OI)(CI)(RX)"],
                       capture_output=True, check=True, timeout=15)
        return Supervisor(config).launch(dist / "electron.exe", APP, smoke)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("self-test", "smoke", "launch", "demo", "sample-smoke", "verify-import"))
    parser.add_argument("--desk", type=Path, default=os.environ.get("WORKBENCH_DESK_ROOT"))
    parser.add_argument("--local-model")
    parser.add_argument("--local-endpoint", default="http://127.0.0.1:11434/v1/chat/completions")
    parser.add_argument("--cloud-model")
    parser.add_argument("--vendor-catalog", type=Path)
    parser.add_argument("--second-desk", type=Path)
    parser.add_argument("--bundle", type=Path)
    args = parser.parse_args()
    if args.desk is None:
        parser.error("Provide --desk or configure WORKBENCH_DESK_ROOT")
    desk = args.desk.resolve(strict=True)
    sys.path.insert(0, str(desk))
    if args.action == "self-test":
        acceptance(desk, args.second_desk.resolve(strict=True) if args.second_desk else None)
        return 0
    if args.action == "verify-import":
        if args.bundle is None:
            parser.error("Provide --bundle")
        with tempfile.TemporaryDirectory(prefix="desk-workbench-second-") as td:
            print(json.dumps(verify_import(desk, Path(td), args.bundle.resolve(strict=True))))
        return 0
    models = {}
    if args.local_model:
        models["local"] = {"endpoint": args.local_endpoint, "model": args.local_model, "cloud": False}
    if args.cloud_model:
        models["openai"] = {"endpoint": "https://api.openai.com/v1/chat/completions",
                            "model": args.cloud_model, "cloud": True, "key_env": "OPENAI_API_KEY"}
    vendor = json.loads(args.vendor_catalog.read_bytes()) if args.vendor_catalog else default_catalog()
    if args.action == "smoke":
        with tempfile.TemporaryDirectory(prefix="desk-workbench-ui-") as td:
            config = config_for(desk, Path(td), {}, vendor)
            return launch_window(config, smoke=True)
    if args.action in {"demo", "sample-smoke"}:
        smoke = args.action == "sample-smoke"
        with tempfile.TemporaryDirectory(prefix="desk-workbench-sample-") as td, HTTPServer(("127.0.0.1", 0), FixtureModel) as server:
            models = {"demo-fixture": {"endpoint": f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                                      "model": "Deterministic demo fixture", "cloud": False}}
            run = Path(td) if smoke else APP / ".pilot" / "demo"
            config = config_for(desk, run, models, vendor)
            imports = Path(config["imports"])
            (imports / "behavior.txt").write_text(DOC, encoding="utf-8")
            shutil.copyfile(Path(os.environ["SystemRoot"]) / "System32" / "where.exe", imports / "where.exe")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                return launch_window(config, smoke=smoke)
            finally:
                server.shutdown()
                thread.join(timeout=5)
    config = config_for(desk, APP / ".pilot", models, vendor)
    return launch_window(config)


if __name__ == "__main__":
    sys.exit(main())
