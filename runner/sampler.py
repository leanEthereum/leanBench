"""Background CPU / memory sampler.

Polls a target PID every ~100ms via psutil and returns aggregated stats.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

import psutil  # type: ignore


@dataclass
class Sample:
    cpu_percent: float   # sum across logical cores (can exceed 100)
    rss_bytes: int


class ResourceSampler:
    def __init__(self, pid: int, interval_ms: float = 100.0):
        self._proc = psutil.Process(pid)
        # Prime cpu_percent — first call returns 0.0 in psutil.
        try:
            self._proc.cpu_percent(interval=None)
        except psutil.NoSuchProcess:
            pass
        self._interval_s = interval_ms / 1000.0
        self._samples: list[Sample] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while not self._stop.is_set():
            try:
                cpu = self._proc.cpu_percent(interval=None)
                rss = self._proc.memory_info().rss
                # Include children's footprint too — cargo spawns rustc/linker/
                # leanMultisig helpers that matter.
                for child in self._proc.children(recursive=True):
                    try:
                        cpu += child.cpu_percent(interval=None)
                        rss += child.memory_info().rss
                    except psutil.Error:
                        pass
                self._samples.append(Sample(cpu, rss))
            except psutil.NoSuchProcess:
                break
            self._stop.wait(self._interval_s)

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        self._thread.join(timeout=1.0)
        return self.summary()

    def summary(self) -> dict[str, Any]:
        if not self._samples:
            return {"cpu_percent": None, "rss_bytes": None, "n_samples": 0}
        cpus = [s.cpu_percent for s in self._samples]
        rsss = [s.rss_bytes for s in self._samples]
        return {
            "cpu_percent": {
                "mean": round(sum(cpus) / len(cpus), 1),
                "peak": round(max(cpus), 1),
            },
            "rss_bytes": {
                "mean": int(sum(rsss) / len(rsss)),
                "peak": max(rsss),
            },
            "n_samples": len(self._samples),
            "interval_ms": int(self._interval_s * 1000),
        }
