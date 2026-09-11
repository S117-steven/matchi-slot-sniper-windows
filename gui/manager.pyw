# -*- coding: utf-8 -*-
"""MATCHi 场地抢订桌面控制台。"""
from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import webview


CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000 if os.name == "nt" else 0)
GUI_DIR = Path(__file__).resolve().parent
REPO_DIR = GUI_DIR.parent
WEB_DIR = GUI_DIR / "web"
LOG_DIR = REPO_DIR / "logs"
RUN_DIR = REPO_DIR / "gui-runs"
SETTINGS_FILE = GUI_DIR / "settings.json"
CLI_SCRIPT = REPO_DIR / "src" / "cli.mjs"
CARD_LIST_SCRIPT = REPO_DIR / "scripts" / "list-value-cards.mjs"
GUI_STARTUP_LOG = LOG_DIR / "gui-startup.log"

FACILITIES = {
    "atl": {
        "facilitySlug": "atl",
        "facilityId": 2560,
        "facilityName": "ATL Victoriastadion",
        "sportId": 2,
        "sportName": "Badminton",
        "advanceDays": 14,
        "dailyBookingLimitMinutes": 600,
    },
}

def _safe_settings() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _node_executable() -> str:
    found = shutil.which("node")
    if found:
        return found
    candidates = [
        Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "nodejs" / "node.exe",
        Path(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")) / "nodejs" / "node.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise RuntimeError("找不到 Node.js，请确认 node 已安装并加入 PATH")


class Api:
    def __init__(self):
        self._process: subprocess.Popen | None = None
        self._utility_process: subprocess.Popen | None = None
        self._worker_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._closing_event = threading.Event()
        self._lock = threading.Lock()
        self._process_lock = threading.Lock()
        self._termination_lock = threading.Lock()
        self._terminating_pids: set[int] = set()
        self._last_event: dict | None = None
        self._current_log: Path | None = None
        self._current_state: Path | None = None
        LOG_DIR.mkdir(exist_ok=True)
        RUN_DIR.mkdir(exist_ok=True)

    def _js(self, code: str) -> None:
        # Evaluating JavaScript while WebView2 is tearing down can block the
        # closing event or race a disposed native window.
        if self._closing_event.is_set():
            return
        try:
            if webview.windows:
                webview.windows[0].evaluate_js(code)
        except Exception:
            pass

    def _log(self, message: str, level: str = "info") -> None:
        payload = json.dumps(str(message), ensure_ascii=False)
        self._js(f"window.addLog({payload}, {json.dumps(level)})")

    def _push_event(self, event: dict) -> None:
        self._last_event = event
        payload = json.dumps(event, ensure_ascii=False)
        self._js(f"window.handleBackendEvent({payload})")

    def get_defaults(self) -> str:
        saved = _safe_settings()
        target = date.today() + timedelta(days=14)
        defaults = {
            "email": saved.get("email", ""),
            "facility": saved.get("facility", "atl"),
            "targetDate": saved.get("targetDate", target.isoformat()),
            "startTime": saved.get("startTime", "07:00"),
            "durationMinutes": int(saved.get("durationMinutes", 60)),
            "quantity": int(saved.get("quantity", 1)),
            "allowNonConsecutiveCourts": bool(saved.get("allowNonConsecutiveCourts", True)),
            "minimumLeadHours": int(saved.get("minimumLeadHours", 168)),
            "maxValueCardChargeSek": float(saved.get("maxValueCardChargeSek", 70)),
            "allowOverbookingOnUncertain": bool(saved.get("allowOverbookingOnUncertain", True)),
            "maxOverbookCourts": int(saved.get("maxOverbookCourts", 2)),
            "mode": saved.get("mode", "confirm"),
            "valueCardId": saved.get("valueCardId"),
            "facilities": FACILITIES,
        }
        return json.dumps(defaults, ensure_ascii=False)

    def get_value_cards(self, email: str = "", password: str = "") -> str:
        if self._closing_event.is_set():
            raise RuntimeError("窗口正在关闭")
        email = str(email).strip()
        password = str(password)
        if not email or "@" not in email or not password:
            raise ValueError("请先输入有效邮箱和密码")
        env = os.environ.copy()
        env["MATCHI_EMAIL"] = email
        env["MATCHI_PASSWORD"] = password
        env["PYTHONIOENCODING"] = "utf-8"
        proc = None
        try:
            proc = subprocess.Popen(
                [_node_executable(), str(CARD_LIST_SCRIPT)],
                cwd=str(REPO_DIR),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=CREATE_NO_WINDOW,
            )
            with self._process_lock:
                self._utility_process = proc
            if self._closing_event.is_set():
                self._start_process_termination(proc)
            try:
                stdout, _stderr = proc.communicate(timeout=35)
            except subprocess.TimeoutExpired as exc:
                self._start_process_termination(proc)
                try:
                    proc.wait(timeout=3)
                except Exception:
                    pass
                raise RuntimeError("读取 Value Card 超时，请稍后重试") from exc
        finally:
            env["MATCHI_PASSWORD"] = ""
            if proc is not None:
                with self._process_lock:
                    if self._utility_process is proc:
                        self._utility_process = None
        if self._closing_event.is_set():
            raise RuntimeError("窗口正在关闭")
        if proc is None or proc.returncode != 0:
            raise RuntimeError("读取 Value Card 失败，请检查登录信息或稍后重试")
        data = json.loads(stdout)
        cards = data.get("cards", [])
        if not isinstance(cards, list):
            raise RuntimeError("MATCHi 返回了无法识别的 Value Card 数据")
        self._log(f"已读取 {len(cards)} 张 Value Card 的实时余额")
        return json.dumps({"count": len(cards), "cards": cards}, ensure_ascii=False)

    def get_history(self) -> str:
        items = []
        state_dir = REPO_DIR / "state" / "gui"
        if state_dir.exists():
            for path in sorted(state_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)[:10]:
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    items.append({
                        "file": str(path),
                        "status": data.get("status", "unknown"),
                        "createdAt": data.get("createdAt"),
                        "completedAt": data.get("completedAt"),
                        "target": data.get("target"),
                        "receipt": data.get("receipt"),
                    })
                except Exception:
                    continue
        return json.dumps(items, ensure_ascii=False)

    def start_booking(self, config_json: str = "{}") -> str:
        if self._closing_event.is_set():
            return "closing"
        with self._lock:
            if self._worker_thread and self._worker_thread.is_alive():
                self._log("已有任务正在运行或等待放票", "warning")
                return "already_running"
            try:
                raw = json.loads(config_json)
                prepared = self._validate_and_build(raw)
            except Exception as exc:
                self._log(f"配置错误：{exc}", "error")
                return f"error:{exc}"

            self._stop_event.clear()
            self._last_event = None
            self._worker_thread = threading.Thread(
                target=self._run_cli,
                args=(prepared,),
                daemon=True,
                name="matchi-gui-worker",
            )
            self._worker_thread.start()
            return "started"

    def stop_booking(self) -> str:
        self._stop_event.set()
        with self._process_lock:
            processes = [proc for proc in (self._process, self._utility_process) if proc is not None]
        if any(proc.poll() is None for proc in processes):
            self._log("正在终止 MATCHi 任务及其全部子进程…", "warning")
        for proc in processes:
            self._start_process_termination(proc)
        self._push_event({"type": "stopped", "at": datetime.now().isoformat()})
        return "stopping"

    def request_shutdown(self) -> str:
        """Make a native-window close non-blocking and safe during startup."""
        if self._closing_event.is_set():
            return "closing"
        self._closing_event.set()
        self._stop_event.set()
        with self._process_lock:
            processes = [proc for proc in (self._process, self._utility_process) if proc is not None]
        for proc in processes:
            self._start_process_termination(proc)
        self._write_lifecycle_log("window-closing", processes=len(processes))
        return "closing"

    def open_logs(self) -> str:
        LOG_DIR.mkdir(exist_ok=True)
        if os.name == "nt":
            os.startfile(str(LOG_DIR))
        return str(LOG_DIR)

    def _validate_and_build(self, raw: dict) -> dict:
        email = str(raw.get("email", "")).strip()
        password = str(raw.get("password", ""))
        if not email or "@" not in email:
            raise ValueError("请输入有效 MATCHi 邮箱")
        if not password:
            raise ValueError("请输入 MATCHi 密码；密码不会保存到磁盘")

        facility_key = str(raw.get("facility", "atl"))
        if facility_key not in FACILITIES:
            raise ValueError("当前版本仅开放已验证的 ATL Victoriastadion")
        facility = FACILITIES[facility_key]

        target_date = str(raw.get("targetDate", ""))
        try:
            parsed_date = datetime.strptime(target_date, "%Y-%m-%d").date()
        except ValueError as exc:
            raise ValueError("目标日期格式无效") from exc
        start_time = str(raw.get("startTime", ""))
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):00", start_time):
            raise ValueError("开始时间必须是整点 HH:00")

        duration = int(raw.get("durationMinutes", 60))
        if duration not in (60, 120, 180):
            raise ValueError("时长只能是 60、120 或 180 分钟")
        if int(start_time[:2]) * 60 + duration > 24 * 60:
            raise ValueError("开始时间加预订时长不能跨越午夜")
        quantity = int(raw.get("quantity", 1))
        if not 1 <= quantity <= 6:
            raise ValueError("场地数量必须在 1 到 6 之间")
        if quantity * duration > int(facility["dailyBookingLimitMinutes"]):
            raise ValueError(f"目标场地总分钟数超过 ATL 当前每日 {facility['dailyBookingLimitMinutes']} 分钟上限")
        minimum_lead = int(raw.get("minimumLeadHours", 168))
        if not 1 <= minimum_lead <= 720:
            raise ValueError("远期保护必须在 1 到 720 小时之间")
        max_charge = float(raw.get("maxValueCardChargeSek", 0))
        if max_charge <= 0:
            raise ValueError("Value Card 最大扣款必须大于 0")
        mode = str(raw.get("mode", "confirm"))
        if mode not in ("dry-run", "confirm", "value-card"):
            raise ValueError("执行模式无效")
        value_card_id = int(raw.get("valueCardId") or 0)
        value_card_name = str(raw.get("valueCardName", "")).strip()
        value_card_balance = float(raw.get("valueCardBalance") or 0)
        allow_overbooking = bool(raw.get("allowOverbookingOnUncertain", False))
        max_overbook_courts = int(raw.get("maxOverbookCourts", 0))
        if not 0 <= max_overbook_courts <= 6:
            raise ValueError("最多允许超订场地数必须在 0 到 6 之间")
        if not allow_overbooking:
            max_overbook_courts = 0
        if mode == "value-card":
            if value_card_id <= 0 or not value_card_name:
                raise ValueError("请先读取并选择一张 Value Card")
            if value_card_balance < max_charge:
                raise ValueError(f"所选 Value Card 余额 {value_card_balance:g} SEK 低于最大扣款 {max_charge:g} SEK")

        fingerprint = f"{facility_key}-{target_date}-{start_time.replace(':', '')}-d{duration}-q{quantity}"
        transaction_id = f"gui-{fingerprint}"
        state_relative = Path("state") / "gui" / f"{fingerprint}.json"
        run_stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        execution_id = f"{run_stamp}-{time.time_ns()}-{fingerprint}"
        run_path = RUN_DIR / f"{run_stamp}-{fingerprint}"
        run_path.mkdir(parents=True, exist_ok=False)

        config = {
            **facility,
            "timeZone": "Europe/Stockholm",
            "targetDate": target_date,
            "startTime": start_time,
            "durationMinutes": duration,
            "courtPreferences": [],
            "allowAnyCourt": True,
            "quantity": quantity,
            "preferConsecutiveCourts": True,
            "allowNonConsecutiveCourts": bool(raw.get("allowNonConsecutiveCourts", True)),
            "releaseAt": None,
            "loginLeadSeconds": 300,
            "prewarmLeadSeconds": 2,
            "pollIntervalMs": 1000,
            "releaseBurstIntervalMs": 250,
            "releaseBurstSeconds": 3,
            "retryJitterMs": 250,
            "pollTimeoutSeconds": 180,
            "keepPollingIfUnavailable": True,
            "unavailableTargetGraceSeconds": 30,
            "replacementTimeoutSeconds": 20,
            "replacementPollIntervalMs": 1000,
            "replacementMaxRounds": 12,
            "allowOverbookingOnUncertain": allow_overbooking,
            "maxOverbookCourts": max_overbook_courts,
            "mode": mode,
            "requiredTargetDate": target_date,
            "requiredStartTime": start_time,
            "requiredQuantity": quantity,
            "requiredDurationMinutes": duration,
            "minimumLeadHours": minimum_lead,
            "valueCardId": value_card_id or None,
            "valueCardName": value_card_name,
            "valueCardBalanceObserved": value_card_balance,
            "valueCardCheckedAt": datetime.now().isoformat(),
            "maxTotalSek": round(max_charge + max(20, quantity * duration / 60 * 10), 2),
            "maxValueCardChargeSek": max_charge,
            "transactionId": transaction_id,
            "executionId": execution_id,
            "stateFile": str(state_relative),
        }
        config_path = run_path / "config.json"
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        safe_saved = {
            "email": email,
            "facility": facility_key,
            "targetDate": target_date,
            "startTime": start_time,
            "durationMinutes": duration,
            "quantity": quantity,
            "allowNonConsecutiveCourts": bool(raw.get("allowNonConsecutiveCourts", True)),
            "minimumLeadHours": minimum_lead,
            "maxValueCardChargeSek": max_charge,
            "allowOverbookingOnUncertain": allow_overbooking,
            "maxOverbookCourts": max_overbook_courts,
            "mode": mode,
            "valueCardId": value_card_id or None,
        }
        SETTINGS_FILE.write_text(json.dumps(safe_saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        return {
            "email": email,
            "password": password,
            "config": config,
            "configPath": config_path,
            "statePath": REPO_DIR / state_relative,
            "logPath": LOG_DIR / f"gui-{run_stamp}-{fingerprint}.log",
            "runPath": run_path,
            "parsedDate": parsed_date,
        }

    def _run_cli(self, prepared: dict) -> None:
        if self._closing_event.is_set() or self._stop_event.is_set():
            prepared["password"] = ""
            return
        config = prepared["config"]
        log_path: Path = prepared["logPath"]
        self._current_log = log_path
        self._current_state = prepared["statePath"]
        started = time.time()
        prepared["startedAtEpoch"] = started
        awake_enabled = self._set_awake(True)
        if not awake_enabled:
            self._log("Windows 防睡眠请求失败；请手动关闭睡眠/待机，避免错过放票时间", "warning")
            self._push_event({
                "type": "power-warning",
                "message": "Windows 防睡眠请求失败，请手动关闭睡眠/待机",
                "at": datetime.now().isoformat(),
            })

        args = [
            _node_executable(),
            str(CLI_SCRIPT),
            "run",
            "--config",
            str(prepared["configPath"]),
        ]
        if config["mode"] == "value-card":
            args.append("--allow-value-card-payment")

        env = os.environ.copy()
        env["MATCHI_EMAIL"] = prepared["email"]
        env["MATCHI_PASSWORD"] = prepared["password"]
        env["PYTHONIOENCODING"] = "utf-8"
        if config["mode"] == "value-card":
            env["MATCHI_ALLOW_VALUE_CARD_PAYMENT"] = "YES"
        prepared["password"] = ""

        self._push_event({
            "type": "manager-started",
            "at": datetime.now().isoformat(),
            "logFile": str(log_path),
            "target": {
                "date": config["targetDate"],
                "startTime": config["startTime"],
                "quantity": config["quantity"],
                "durationMinutes": config["durationMinutes"],
            },
        })
        self._log("任务配置已保存（不含密码）")
        self._log(f"日志文件：{log_path.name}")

        rc = -1
        try:
            with log_path.open("w", encoding="utf-8") as log_file:
                if self._closing_event.is_set() or self._stop_event.is_set():
                    return
                proc = subprocess.Popen(
                    args,
                    cwd=str(REPO_DIR),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=CREATE_NO_WINDOW,
                    env=env,
                )
                with self._process_lock:
                    self._process = proc
                env["MATCHI_PASSWORD"] = ""

                # Covers a close that races the small interval between Popen
                # and publishing the process reference.
                if self._closing_event.is_set() or self._stop_event.is_set():
                    self._start_process_termination(proc)

                assert proc.stdout is not None
                for raw_line in proc.stdout:
                    line = raw_line.rstrip("\r\n")
                    if self._closing_event.is_set() or self._stop_event.is_set():
                        self._start_process_termination(proc)
                        break
                    if not line:
                        continue
                    log_file.write(line + "\n")
                    log_file.flush()
                    if line.startswith("MATCHI_EVENT "):
                        try:
                            self._push_event(json.loads(line[len("MATCHI_EVENT "):]))
                        except Exception:
                            self._log("收到无法解析的后台事件", "warning")
                    else:
                        self._log(line, "error" if line.startswith("错误：") else "info")

                proc.wait()
                rc = proc.returncode
        except Exception as exc:
            if not self._closing_event.is_set():
                self._log(f"后台启动失败：{exc}", "error")
                self._push_event({"type": "error", "message": str(exc), "at": datetime.now().isoformat()})
        finally:
            with self._process_lock:
                if self._process is locals().get("proc"):
                    self._process = None
            self._set_awake(False)
            if not self._closing_event.is_set():
                elapsed = round(time.time() - started, 1)
                report = self._load_report(prepared, rc, elapsed)
                self._js(f"window.finishRun({json.dumps(report, ensure_ascii=False)})")

    def _load_report(self, prepared: dict, rc: int, elapsed: float) -> dict:
        state = None
        path: Path = prepared["statePath"]
        state_is_current = False
        if prepared["config"]["mode"] == "value-card" and path.exists():
            try:
                recent_mtime = path.stat().st_mtime >= float(prepared.get("startedAtEpoch", 0)) - 1.0
                candidate = json.loads(path.read_text(encoding="utf-8")) if recent_mtime else None
                expected_execution_id = prepared["config"].get("executionId")
                state_is_current = bool(
                    recent_mtime
                    and isinstance(candidate, dict)
                    and candidate.get("executionId") == expected_execution_id
                )
                state = candidate if state_is_current else None
            except Exception:
                state = None
                state_is_current = False
        stopped = self._stop_event.is_set()
        if stopped:
            status = "stopped"
        elif state_is_current and state and state.get("status") == "completed":
            status = "completed"
        elif state_is_current and state and state.get("status") == "completed-verification-warning":
            status = "verification-warning"
        elif state_is_current and state and state.get("status") == "partial":
            status = "partial"
        elif state_is_current and state and state.get("status") == "failed-or-uncertain":
            status = "uncertain"
        elif rc != 0:
            status = "uncertain" if state_is_current and state else "failed"
        elif rc == 0:
            status = "completed-no-payment" if prepared["config"]["mode"] != "value-card" else "submitted"
        else:
            status = "failed"
        return {
            "status": status,
            "exitCode": rc,
            "elapsedSeconds": elapsed,
            "logFile": str(prepared["logPath"]),
            "stateFile": str(path) if state_is_current and path.exists() else None,
            "state": state,
            "lastEvent": self._last_event,
        }

    @staticmethod
    def _terminate_process_tree(pid: int) -> None:
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    creationflags=CREATE_NO_WINDOW,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                )
            else:
                os.kill(pid, 15)
        except Exception:
            pass

    def _start_process_termination(self, proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            return
        pid = int(proc.pid)
        with self._termination_lock:
            if pid in self._terminating_pids:
                return
            self._terminating_pids.add(pid)

        def terminate() -> None:
            try:
                self._terminate_process_tree(pid)
                try:
                    proc.wait(timeout=3)
                except Exception:
                    pass
            finally:
                with self._termination_lock:
                    self._terminating_pids.discard(pid)

        threading.Thread(
            target=terminate,
            daemon=True,
            name=f"matchi-terminate-{pid}",
        ).start()

    @staticmethod
    def _write_lifecycle_log(event: str, **details) -> None:
        try:
            GUI_STARTUP_LOG.parent.mkdir(exist_ok=True)
            suffix = " ".join(f"{key}={value}" for key, value in details.items())
            with GUI_STARTUP_LOG.open("a", encoding="utf-8") as log:
                log.write(f"[{datetime.now().isoformat()}] {event}{(' ' + suffix) if suffix else ''}\n")
        except Exception:
            pass

    @staticmethod
    def _set_awake(enabled: bool) -> bool:
        if os.name != "nt":
            return True
        try:
            continuous = 0x80000000
            system_required = 0x00000001
            flags = continuous | system_required if enabled else continuous
            return bool(ctypes.windll.kernel32.SetThreadExecutionState(flags))
        except Exception:
            return False


if __name__ == "__main__":
    api = Api()
    window = webview.create_window(
        title="MATCHi 场地抢订控制台",
        url=(WEB_DIR / "index.html").as_uri(),
        js_api=api,
        width=760,
        height=820,
        min_size=(680, 680),
        x=40,
        y=30,
    )

    def _closing(*_args):
        # Never wait for child-process cleanup on WebView2's UI thread.
        api.request_shutdown()

    def _force_visible(*_args):
        """Undo a minimized/hidden state inherited from a shortcut launcher."""
        handle = 0
        try:
            window.show()
            window.restore()
        except Exception:
            pass

        try:
            native = getattr(window, "native", None)
            handle = int(native.Handle.ToInt64()) if native is not None else 0
            if handle:
                ctypes.windll.user32.ShowWindow(handle, 9)  # SW_RESTORE
                # Briefly raise the window, then immediately return it to normal
                # z-order. This avoids leaving the controller always-on-top.
                flags = 0x0001 | 0x0040  # SWP_NOSIZE | SWP_SHOWWINDOW
                ctypes.windll.user32.SetWindowPos(handle, -1, 40, 30, 0, 0, flags)
                ctypes.windll.user32.SetWindowPos(handle, -2, 40, 30, 0, 0, flags)
                ctypes.windll.user32.SetForegroundWindow(handle)
        except Exception:
            pass

        try:
            GUI_STARTUP_LOG.parent.mkdir(exist_ok=True)
            visible = bool(ctypes.windll.user32.IsWindowVisible(handle)) if handle else False
            with GUI_STARTUP_LOG.open("a", encoding="utf-8") as log:
                log.write(
                    f"[{datetime.now().isoformat()}] window-ready "
                    f"handle={handle} visible={visible}\n"
                )
        except Exception:
            pass

    try:
        window.events.closing += _closing
        window.events.shown += _force_visible
        window.events.loaded += _force_visible
    except Exception:
        pass
    webview.start(gui="edgechromium")
