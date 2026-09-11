"""Local smoke test for the MATCHi desktop manager; never opens the UI or network."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import tempfile
import threading
import time
from pathlib import Path


manager_path = Path(__file__).with_name("manager.pyw")
loader = importlib.machinery.SourceFileLoader("matchi_gui_manager", str(manager_path))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="matchi-gui-smoke-") as temp_name:
    temp = Path(temp_name)
    module.RUN_DIR = temp / "runs"
    module.RUN_DIR.mkdir()
    module.SETTINGS_FILE = temp / "settings.json"
    api = module.Api()
    prepared = api._validate_and_build({
        "email": "smoke@example.com",
        "password": "memory-only-test-password",
        "facility": "atl",
        "targetDate": "2026-09-08",
        "startTime": "07:00",
        "durationMinutes": 120,
        "quantity": 3,
        "allowNonConsecutiveCourts": True,
        "minimumLeadHours": 168,
        "maxValueCardChargeSek": 420,
        "allowOverbookingOnUncertain": True,
        "maxOverbookCourts": 2,
        "valueCardId": 900002,
        "valueCardName": "Example Value Card",
        "valueCardBalance": 2200,
        "mode": "value-card",
    })
    config_text = prepared["configPath"].read_text(encoding="utf-8")
    settings_text = module.SETTINGS_FILE.read_text(encoding="utf-8")
    assert "memory-only-test-password" not in config_text
    assert "memory-only-test-password" not in settings_text
    config = json.loads(config_text)
    assert config["quantity"] == 3
    assert config["requiredQuantity"] == 3
    assert config["durationMinutes"] == 120
    assert config["preferConsecutiveCourts"] is True
    assert config["allowNonConsecutiveCourts"] is True
    assert config["keepPollingIfUnavailable"] is True
    assert config["prewarmLeadSeconds"] == 2
    assert config["releaseBurstIntervalMs"] == 250
    assert config["releaseBurstSeconds"] == 3
    assert config["retryJitterMs"] == 250
    assert config["unavailableTargetGraceSeconds"] == 30
    assert config["replacementTimeoutSeconds"] == 20
    assert config["replacementPollIntervalMs"] == 1000
    assert config["replacementMaxRounds"] == 12
    assert config["allowOverbookingOnUncertain"] is True
    assert config["maxOverbookCourts"] == 2
    assert config["maxValueCardChargeSek"] == 420
    assert config["valueCardId"] == 900002
    assert config["valueCardBalanceObserved"] == 2200
    assert config["executionId"]

    report_prepared = {
        "statePath": temp / "report-state.json",
        "logPath": temp / "report.log",
        "config": {"mode": "value-card", "executionId": config["executionId"]},
        "startedAtEpoch": time.time() - 1,
    }
    report_prepared["statePath"].write_text(
        json.dumps({"status": "completed", "executionId": "stale-execution"}),
        encoding="utf-8",
    )
    stale_report = api._load_report(report_prepared, 1, 0.1)
    assert stale_report["status"] == "failed"
    assert stale_report["state"] is None
    assert stale_report["stateFile"] is None
    report_prepared["statePath"].write_text(
        json.dumps({"status": "completed", "executionId": config["executionId"]}),
        encoding="utf-8",
    )
    current_report = api._load_report(report_prepared, 0, 0.1)
    assert current_report["status"] == "completed"

print("GUI manager smoke test passed; password was not persisted")

html = (Path(__file__).parent / "web" / "index.html").read_text(encoding="utf-8")
javascript = (Path(__file__).parent / "web" / "app.js").read_text(encoding="utf-8")
assert 'id="allow-overbooking"' in html
assert 'id="max-overbook"' in html
assert '<select id="start-time"' in html
assert 'value="07:30"' not in html
assert "allowOverbookingOnUncertain" in javascript
assert "maxOverbookCourts" in javascript
print("GUI overbooking controls smoke test passed")

assert isinstance(module.Api._set_awake(True), bool)
assert isinstance(module.Api._set_awake(False), bool)
print("GUI power-state guard smoke test passed")


class FakeProcess:
    pid = 987654

    def __init__(self):
        self.done = threading.Event()

    def poll(self):
        return 0 if self.done.is_set() else None

    def wait(self, timeout=None):
        if not self.done.wait(timeout):
            raise TimeoutError
        return 0


module.RUN_DIR = Path(tempfile.gettempdir()) / "matchi-gui-lifecycle-smoke-runs"
module.GUI_STARTUP_LOG = Path(tempfile.gettempdir()) / "matchi-gui-lifecycle-smoke.log"
closing_api = module.Api()
fake_process = FakeProcess()
closing_api._process = fake_process
termination_finished = threading.Event()


def slow_terminate(pid):
    assert pid == fake_process.pid
    time.sleep(0.3)
    fake_process.done.set()
    termination_finished.set()


closing_api._terminate_process_tree = slow_terminate
closing_api._js = lambda _code: (_ for _ in ()).throw(AssertionError("shutdown must not call JavaScript"))
started = time.perf_counter()
assert closing_api.request_shutdown() == "closing"
elapsed = time.perf_counter() - started
assert elapsed < 0.1, f"window close blocked for {elapsed:.3f}s"
assert closing_api._closing_event.is_set()
assert closing_api._stop_event.is_set()
assert termination_finished.wait(2)
assert closing_api.start_booking("{}") == "closing"
print("GUI close lifecycle smoke test passed; native close is non-blocking")
