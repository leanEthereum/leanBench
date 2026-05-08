"""Cloud-agnostic VM provisioning interface.

The orchestrator (`scripts.cloud.remote_bench`) drives a `Provisioner` to create a
VM, run a benchmark on it, pull the result file back, and tear down. Each
concrete provisioner translates the abstract `InstanceSpec` into provider-
specific calls (gcloud / aws / hetzner / ssh).

When adding a new provider, implement the `Provisioner` protocol — no
changes to the orchestrator are needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


@dataclass
class InstanceSpec:
    name: str
    machine_type: str
    image_family: str
    # Provider-specific extras (e.g. GCP `image_project`, AWS `vpc_id`).
    # Each provisioner pulls what it needs and ignores the rest.
    extras: dict[str, Any] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)


@dataclass
class Instance:
    # Opaque to the orchestrator beyond `name`; everything provider-
    # specific lives in `data` (e.g. GCP `zone`, AWS `region` + `instance_id`).
    name: str
    data: dict[str, Any] = field(default_factory=dict)


class Provisioner(Protocol):
    def create(self, spec: InstanceSpec) -> Instance: ...
    def wait_ssh_ready(self, inst: Instance, timeout_s: int = 300) -> None: ...
    # Streams remote stdout/stderr to the caller's tty in real time. When
    # `prefix` is given, every line is prepended with it — useful when
    # several runs interleave on the same console (parallel mode).
    def ssh_exec(self, inst: Instance, cmd: str, prefix: str = "") -> int: ...
    # Captures stdout, raises on non-zero exit.
    def ssh_capture(self, inst: Instance, cmd: str) -> str: ...
    # `remote` is an absolute or home-relative path on the VM.
    def scp_back(self, inst: Instance, remote: str, local: Path) -> None: ...
    def scp_to(self, inst: Instance, local: Path, remote: str) -> None: ...
    def destroy(self, inst: Instance) -> None: ...
    # Release any provisioner-side resources (e.g. temp config dirs).
    def close(self) -> None: ...
