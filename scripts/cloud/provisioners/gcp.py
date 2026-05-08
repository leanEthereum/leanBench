"""GCP provisioner — drives `gcloud` as a subprocess.

Auth is fully scoped: the service-account key is activated inside a temp
CLOUDSDK_CONFIG directory, so nothing leaks into the caller's main gcloud
session. The temp dir is wiped on `close()`.

SSH goes via Identity-Aware Proxy tunneling (`--tunnel-through-iap`) so
the VM doesn't need an external IP — only the `iap.tunnelInstances.
accessViaIAP` permission on the SA.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import Instance, InstanceSpec


@dataclass
class GCPProvisioner:
    project: str
    zone: str
    credentials_path: Path
    cfg_dir: Path = field(init=False)
    _activated: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self.cfg_dir = Path(tempfile.mkdtemp(prefix="leanBench-gcloud-"))
        self._gcloud(
            "auth", "activate-service-account",
            "--key-file", str(self.credentials_path),
            check=True, quiet=True,
        )
        self._gcloud("config", "set", "project", self.project, check=True, quiet=True)
        self._activated = True

    def close(self) -> None:
        if self.cfg_dir.exists():
            shutil.rmtree(self.cfg_dir, ignore_errors=True)

    def __enter__(self) -> "GCPProvisioner":
        return self

    def __exit__(self, *_) -> None:
        self.close()

    def create(self, spec: InstanceSpec) -> Instance:
        image_project = spec.extras.get("image_project", "ubuntu-os-cloud")
        labels = ",".join(f"{k}={v}" for k, v in spec.labels.items())
        args = [
            "compute", "instances", "create", spec.name,
            "--zone", self.zone,
            "--machine-type", spec.machine_type,
            "--image-family", spec.image_family,
            "--image-project", image_project,
        ]
        if labels:
            args += ["--labels", labels]
        # Don't attach a service account to the VM. Without these flags, gcloud
        # attaches the default Compute SA, which requires the caller to hold
        # `iam.serviceAccounts.actAs` on it — a broad permission we want to
        # avoid. The VM never calls any GCP APIs anyway.
        args += ["--no-service-account", "--no-scopes"]
        # External IP enables outbound — apt + git + cargo registry need it.
        # SSH still goes via `--tunnel-through-iap` below, so no inbound port
        # is opened; the VM is ephemeral and has no service account, so the
        # public IP's blast radius is minimal. If you'd rather keep
        # `--no-address`, set up Cloud NAT on your VPC and re-enable that flag.
        self._gcloud(*args, check=True)
        return Instance(name=spec.name, data={"zone": self.zone})

    def wait_ssh_ready(self, inst: Instance, timeout_s: int = 300) -> None:
        deadline = time.time() + timeout_s
        last_err: str = ""
        while time.time() < deadline:
            r = self._gcloud(
                "compute", "ssh", inst.name,
                "--zone", self.zone, "--tunnel-through-iap",
                "--command", "true",
                check=False, quiet=True,
            )
            if r.returncode == 0:
                return
            lines = (r.stderr or "").strip().splitlines()
            last_err = lines[-1] if lines else ""
            time.sleep(5)
        raise RuntimeError(f"SSH not ready after {timeout_s}s: {last_err}")

    def ssh_exec(self, inst: Instance, cmd: str, prefix: str = "") -> int:
        """Stream stdout/stderr to caller's tty. If `prefix` is given, every
        line is prepended with it — useful when several runs interleave on
        the same console (parallel mode)."""
        if not prefix:
            r = subprocess.run(
                ["gcloud", "compute", "ssh", inst.name,
                 "--zone", self.zone, "--tunnel-through-iap",
                 "--command", cmd],
                env=self._env(),
            )
            return r.returncode

        # Per-line prefix path. Read stdout line-by-line and re-emit prefixed.
        # stderr is folded into stdout so error lines stay grouped with
        # whichever machine produced them.
        import sys as _sys
        proc = subprocess.Popen(
            ["gcloud", "compute", "ssh", inst.name,
             "--zone", self.zone, "--tunnel-through-iap",
             "--command", cmd],
            env=self._env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                _sys.stdout.write(f"{prefix}{line}")
                _sys.stdout.flush()
        finally:
            proc.wait()
        return proc.returncode

    def ssh_capture(self, inst: Instance, cmd: str) -> str:
        r = self._gcloud(
            "compute", "ssh", inst.name,
            "--zone", self.zone, "--tunnel-through-iap",
            "--command", cmd,
            check=True, quiet=True,
        )
        return (r.stdout or "").strip()

    def scp_back(self, inst: Instance, remote: str, local: Path) -> None:
        self._gcloud(
            "compute", "scp", "--tunnel-through-iap",
            "--zone", self.zone,
            f"{inst.name}:{remote}", str(local),
            check=True,
        )

    def scp_to(self, inst: Instance, local: Path, remote: str) -> None:
        self._gcloud(
            "compute", "scp", "--tunnel-through-iap",
            "--zone", self.zone,
            str(local), f"{inst.name}:{remote}",
            check=True,
        )

    def destroy(self, inst: Instance) -> None:
        self._gcloud(
            "compute", "instances", "delete", inst.name,
            "--zone", self.zone, "--quiet",
            check=True,
        )

    def _env(self) -> dict[str, str]:
        return {**os.environ, "CLOUDSDK_CONFIG": str(self.cfg_dir)}

    def _gcloud(self, *args: str, check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["gcloud", *args],
            env=self._env(),
            check=check,
            capture_output=quiet,
            text=True,
        )
