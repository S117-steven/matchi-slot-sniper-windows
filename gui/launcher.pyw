# -*- coding: utf-8 -*-
"""Fault-reporting entry point for the MATCHi desktop GUI."""
from __future__ import annotations

import ctypes
import runpy
import traceback
from datetime import datetime
from pathlib import Path


GUI_DIR = Path(__file__).resolve().parent
STARTUP_LOG = GUI_DIR.parent / "logs" / "gui-startup.log"


def _report_startup_failure() -> None:
    details = traceback.format_exc()
    try:
        STARTUP_LOG.parent.mkdir(exist_ok=True)
        with STARTUP_LOG.open("a", encoding="utf-8") as log:
            log.write(f"\n[{datetime.now().isoformat()}] GUI startup failed\n{details}\n")
    except Exception:
        pass

    try:
        ctypes.windll.user32.MessageBoxW(
            0,
            f"MATCHi 场地抢订启动失败。\n\n错误已写入：\n{STARTUP_LOG}",
            "MATCHi 启动错误",
            0x10,
        )
    except Exception:
        pass


try:
    runpy.run_path(str(GUI_DIR / "manager.pyw"), run_name="__main__")
except BaseException:
    _report_startup_failure()
    raise
