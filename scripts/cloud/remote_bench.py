"""Run a benchmark on a fresh remote VM and pull the result file back.

End-to-end: create VM → install rust + uv → clone repo → run `uv run bench`
→ scp result JSON into local `results/` → destroy VM.

VM is destroyed in a `try/finally`, including on Ctrl-C, so leaks should
require an actively crashed Python interpreter (in which case the orphan
is tagged `lean-bench=true` for cleanup).

Usage:
    # Run the default machine matrix (sequential, prompts y/N first):
    uv run remote-bench --credentials gcp-credentials.json

    # Or pin a single machine type:
    uv run remote-bench --credentials gcp-credentials.json \\
        --machine-type n2-standard-8

`--project` defaults to the `project_id` field in the credentials JSON.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from .provisioners import Instance, InstanceSpec
from .provisioners.gcp import GCPProvisioner


# Default machine matrix used when `--machine-type` is not given.
# Anchored to EIP-7870, with a clean SIMD-generation A/B at 4 vCPU
# (n1 vs c4-4 isolates AVX2 vs AVX-512) and a Rayon-scaling line on
# Granite Rapids (c4-4 / c4-8 / c4-16, same uArch).
DEFAULT_MACHINE_TYPES = [
    "n1-standard-4",   # 2  physical cores, Skylake / AVX2 — older-gen AVX2 baseline
    "c4-standard-4",   # 2  physical cores, Granite Rapids / AVX-512 — A/B partner for n1
    "c4-standard-8",   # 4  physical cores, Granite Rapids / AVX-512 — Full Node tier
    "c4-standard-16",  # 8  physical cores, Granite Rapids / AVX-512 — Attester tier
    "c4-standard-32",  # 16 physical cores, Granite Rapids / AVX-512 — high-end reference
]


REMOTE_SETUP_SH = Path(__file__).resolve().parent / "remote_setup.sh"


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=["gcp"], default="gcp")
    ap.add_argument("--credentials", type=Path, required=True,
                    help="Path to GCP service-account JSON key")
    ap.add_argument("--project", default=None,
                    help="GCP project ID. Defaults to the `project_id` field "
                         "in the credentials JSON.")
    ap.add_argument("--zone", default="us-central1-a")
    ap.add_argument("--machine-type", default=None,
                    help="GCP machine type (e.g. n2-standard-8). If omitted, "
                         "iterate sequentially through DEFAULT_MACHINE_TYPES "
                         "(prompts y/N before starting).")
    ap.add_argument("--yes", "-y", action="store_true",
                    help="Skip the y/N prompt when running the default matrix.")
    ap.add_argument("--parallel", action=argparse.BooleanOptionalAction, default=True,
                    help="Run the matrix concurrently (one VM per machine, "
                         "default) — output is line-prefixed by machine. "
                         "Pass `--no-parallel` to run sequentially instead "
                         "(slower wallclock, lower peak GCP concurrency).")
    ap.add_argument("--image-family", default="ubuntu-2404-lts-amd64",
                    help="GCP image family. Ubuntu 24.04 is published under "
                         "arch-suffixed families: `ubuntu-2404-lts-amd64` "
                         "(x86_64) or `ubuntu-2404-lts-arm64` (e.g. for "
                         "T2A / Axion machine types).")
    ap.add_argument("--image-project", default="ubuntu-os-cloud",
                    help="Image source project (e.g. ubuntu-os-cloud, debian-cloud)")
    ap.add_argument("--repo-url", default=None,
                    help="Where the VM should clone leanBench from. "
                         "Defaults to `git remote get-url origin` of the local checkout.")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--bench-args", default="",
                    help="Extra args passed to `uv run bench` on the remote "
                         "(e.g. \"--include-keygen --samples 50\")")
    ap.add_argument("--keep-on-failure", action="store_true",
                    help="Don't destroy the VM if the bench fails — useful for debugging")
    ap.add_argument("--out-dir", type=Path, default=Path("results"))
    ap.add_argument("--ssh-timeout-s", type=int, default=300)
    ap.add_argument("--signers-cache", type=Path, default=None,
                    help="Path to a local benchmark_signers_cache_<hash>.bin file to "
                         "pre-upload to each VM. Skips the ~few-minute lazy regen on "
                         "first bench. If omitted, auto-discovered from "
                         "~/.cargo/git/checkouts/leanmultisig-*/<sha>*/target/signers-cache/.")
    ap.add_argument("--no-signers-cache", action="store_true",
                    help="Disable signers-cache upload (override auto-discovery).")
    args = ap.parse_args()

    if not args.credentials.is_file():
        sys.exit(f"credentials file not found: {args.credentials}")

    # Hard-fail early on missing CLI prerequisites — easier to debug than a
    # subprocess `FileNotFoundError` deep in the provisioner stack.
    if args.provider == "gcp" and shutil.which("gcloud") is None:
        sys.exit(
            "gcloud CLI not found on PATH. Install it first:\n"
            "  macOS:  brew install --cask google-cloud-sdk\n"
            "  other:  https://cloud.google.com/sdk/docs/install"
        )

    if args.repo_url is None:
        args.repo_url = _detect_repo_url()
        if not args.repo_url:
            sys.exit("could not auto-detect --repo-url; pass it explicitly")

    # Resolve the signers-cache: --no-signers-cache disables; --signers-cache
    # PATH is taken as-is; otherwise auto-discover. Logged once here so
    # per-VM noise stays minimal.
    if args.no_signers_cache:
        args.signers_cache = None
        print("signers-cache: disabled by --no-signers-cache")
    elif args.signers_cache is None:
        args.signers_cache = _discover_signers_cache()
        if args.signers_cache:
            size_mb = args.signers_cache.stat().st_size / (1024 * 1024)
            print(f"signers-cache (auto): {args.signers_cache} ({size_mb:.1f} MiB)")
        else:
            print("signers-cache (auto): none found — VMs will regen on first bench")
    elif not args.signers_cache.is_file():
        sys.exit(f"--signers-cache file not found: {args.signers_cache}")

    # Default --project to the SA key's project_id field — one less flag in
    # the common case where you bench in the project that owns the SA.
    if args.project is None:
        try:
            args.project = json.loads(args.credentials.read_text()).get("project_id")
        except (OSError, ValueError) as e:
            sys.exit(f"could not read project_id from {args.credentials}: {e}")
        if not args.project:
            sys.exit("--project not given and credentials JSON has no project_id field")

    if args.machine_type:
        machines = [args.machine_type]
    else:
        machines = list(DEFAULT_MACHINE_TYPES)
        print("No --machine-type given. Default matrix:")
        for m in machines:
            print(f"  • {m}")
        print()
        if not args.yes and not _confirm("Bench all of these (sequentially)?"):
            print("aborted.")
            sys.exit(0)

    if args.provider == "gcp":
        prov = GCPProvisioner(
            project=args.project,
            zone=args.zone,
            credentials_path=args.credentials.resolve(),
        )
    else:
        sys.exit(f"unknown provider: {args.provider}")

    # Track all currently-live VMs so the signal handler can tear them down
    # regardless of which threads are running. Keyed by machine_type.
    import threading
    live_lock = threading.Lock()
    live_instances: dict[str, Instance] = {}

    def cleanup_signal(_sig, _frame):
        print("\n==> caught signal; destroying live instance(s)...")
        with live_lock:
            for mt, inst in list(live_instances.items()):
                try:
                    prov.destroy(inst)
                except Exception as e:
                    print(f"    error destroying {mt}: {e}")
        prov.close()
        sys.exit(130)

    signal.signal(signal.SIGINT, cleanup_signal)
    signal.signal(signal.SIGTERM, cleanup_signal)

    summaries: list[dict] = []
    failures: list[tuple[str, str]] = []

    def _run(machine_type: str) -> None:
        # Prefix every remote line with the machine type when running in
        # parallel — otherwise output from 4 boxes interleaves illegibly.
        prefix = f"[{machine_type}] " if (args.parallel and len(machines) > 1) else ""
        try:
            summary = run_one_machine(
                prov, args, machine_type, live_instances, live_lock, prefix=prefix,
            )
            if summary:
                summaries.append(summary)
        except Exception as e:
            print(f"\nerror on {machine_type}: {e}", file=sys.stderr)
            failures.append((machine_type, str(e)))

    try:
        if args.parallel and len(machines) > 1:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=len(machines)) as pool:
                # Submit all and let the pool wait for completion on exit.
                for fut in [pool.submit(_run, m) for m in machines]:
                    fut.result()
        else:
            for machine_type in machines:
                print()
                _run(machine_type)
    finally:
        prov.close()

    print()
    for s in summaries:
        _print_summary(s)
    if failures:
        print()
        print("Failed machines:")
        for m, err in failures:
            print(f"  • {m}: {err}")
        sys.exit(1)


def run_one_machine(
    prov,
    args,
    machine_type: str,
    live_instances: dict,
    live_lock,
    prefix: str = "",
) -> dict | None:
    """Provision one VM, run the bench, scp the result back, destroy it.

    `live_instances[machine_type]` tracks the live VM so the top-level
    signal handler can destroy every concurrent run on Ctrl-C. `live_lock`
    serialises mutation across threads in parallel mode.
    """
    # Make VM names unique even when several runs are spawned in the same
    # second (parallel mode). Embed the machine type in the name too.
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    short = machine_type.replace("standard-", "s").replace("highcpu-", "h")
    vm_name = f"lean-bench-{short}-{timestamp}"
    spec = InstanceSpec(
        name=vm_name,
        machine_type=machine_type,
        image_family=args.image_family,
        extras={"image_project": args.image_project},
        labels={"lean-bench": "true", "lean-bench-ephemeral": "true"},
    )

    inst: Instance | None = None
    summary: dict | None = None
    try:
        print(f"{prefix}==> creating {vm_name}")
        print(f"{prefix}    {machine_type} · {args.image_family} · {args.zone}")
        inst = prov.create(spec)
        with live_lock:
            live_instances[machine_type] = inst

        print(f"{prefix}==> waiting for SSH (timeout {args.ssh_timeout_s}s)")
        prov.wait_ssh_ready(inst, timeout_s=args.ssh_timeout_s)

        if args.signers_cache is not None:
            print(f"{prefix}==> uploading signers cache ({args.signers_cache.name})")
            prov.ssh_exec(inst, 'mkdir -p "$HOME/leanBench-signers"', prefix=prefix)
            prov.scp_to(inst, args.signers_cache,
                        f"leanBench-signers/{args.signers_cache.name}")

        print(f"{prefix}==> running setup + bench")
        if not prefix:
            print("─" * 64)
        bench_args = f"--label {machine_type} {args.bench_args}".strip()
        # shlex.quote wraps each value in shell-safe single quotes so a
        # malicious branch / args string can't break out into bash.
        env_exports = (
            f"export REPO_URL={shlex.quote(args.repo_url)}\n"
            f"export BRANCH={shlex.quote(args.branch)}\n"
            f"export BENCH_ARGS={shlex.quote(bench_args)}\n"
        )
        cmd = env_exports + REMOTE_SETUP_SH.read_text()
        rc = prov.ssh_exec(inst, cmd, prefix=prefix)
        if not prefix:
            print("─" * 64)
        if rc != 0:
            raise RuntimeError(f"benchmark exited with code {rc}")

        marker = prov.ssh_capture(
            inst,
            "cd leanBench && ls -t results/*.json 2>/dev/null "
            "| grep -v 'results/index.json' | head -1",
        )
        if not marker:
            raise RuntimeError("bench finished but no result JSON found on remote")
        remote_path = f"leanBench/{marker}"

        args.out_dir.mkdir(parents=True, exist_ok=True)
        local_path = args.out_dir / Path(marker).name
        print(f"{prefix}==> pulling result back → {local_path}")
        prov.scp_back(inst, remote_path, local_path)

        summary = _summary(local_path)

    except Exception:
        if args.keep_on_failure and inst is not None:
            print(
                f"\n{prefix}VM {inst.name} retained for debugging. "
                f"When done:\n  gcloud compute instances delete {inst.name} "
                f"--zone={args.zone} --quiet",
                file=sys.stderr,
            )
            with live_lock:
                live_instances.pop(machine_type, None)
            inst = None  # skip destroy in finally
        raise
    finally:
        if inst is not None:
            print(f"{prefix}==> destroying {inst.name}")
            try:
                prov.destroy(inst)
            except Exception as e:
                print(f"{prefix}    error destroying (cleanup manually!): {e}", file=sys.stderr)
            with live_lock:
                live_instances.pop(machine_type, None)

    return summary


def _confirm(prompt: str) -> bool:
    try:
        ans = input(f"{prompt} [y/N] ").strip().lower()
    except EOFError:
        return False
    return ans in ("y", "yes")


def _detect_repo_url() -> str | None:
    """Pick a remote to clone on the VM. Prefer the current branch's
    upstream, fall back to `origin`, fall back to the first remote."""
    def _git(*args: str) -> str | None:
        r = subprocess.run(["git", *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None

    remote = None
    branch = _git("branch", "--show-current")
    if branch:
        remote = _git("config", "--get", f"branch.{branch}.remote")
    if not remote:
        remotes = (_git("remote") or "").splitlines()
        if "origin" in remotes:
            remote = "origin"
        elif remotes:
            remote = remotes[0]
    if not remote:
        return None
    return _git("remote", "get-url", remote)


def _discover_signers_cache() -> Path | None:
    """Find a local benchmark_signers_cache_<footprint>.bin matching the
    pinned leanMultisig SHA in workloads/Cargo.toml. The cache file is
    content-addressed by the hash of signer #0's pubkey, so it's stable
    across leanMultisig SHAs as long as the XMSS scheme params don't change
    — but we still narrow to the pinned-SHA checkout dir to avoid grabbing
    a stale file from an older Rust toolchain or build."""
    cargo_toml = Path("workloads/Cargo.toml")
    if not cargo_toml.is_file():
        return None
    text = cargo_toml.read_text()
    m = re.search(r'leanMultisig\.git",\s*rev\s*=\s*"([0-9a-f]+)"', text)
    if not m:
        return None
    sha_prefix = m.group(1)[:7]
    home = Path(os.path.expanduser("~"))
    matches = sorted(
        glob.glob(str(home / f".cargo/git/checkouts/leanmultisig-*/{sha_prefix}*"
                              "/target/signers-cache/benchmark_signers_cache_*.bin")),
        key=lambda p: Path(p).stat().st_mtime,
        reverse=True,
    )
    return Path(matches[0]) if matches else None


def _summary(local_path: Path) -> dict:
    """Reduce a fresh result file to the headline numbers for stdout."""
    rec = json.loads(local_path.read_text())
    return {
        "label": rec.get("machine", {}).get("label"),
        "cpu":   rec.get("machine", {}).get("cpu_model"),
        "cores": (rec.get("machine", {}).get("physical_cores"),
                  rec.get("machine", {}).get("logical_cores")),
        "memory_gb": rec.get("machine", {}).get("memory_gb"),
        "workloads": [
            {"name":    w.get("name"),
             "mean_ms": (w.get("timing") or {}).get("mean_ns", 0) / 1e6,
             "p95_ms":  ((w.get("timing") or {}).get("p95_ns") or 0) / 1e6,
             "n":       (w.get("timing") or {}).get("n")}
            for w in rec.get("workloads", [])
        ],
        "file": str(local_path),
    }


def _print_summary(s: dict) -> None:
    print()
    print(f"  {s['label']}  —  {s['cpu']}")
    print(f"  {s['cores'][0]}p / {s['cores'][1]}l cores · {s['memory_gb']} GB RAM")
    print()
    print(f"  {'workload':<32} {'mean':>10} {'p95':>10}   n")
    for w in s["workloads"]:
        print(f"  {w['name']:<32} {w['mean_ms']:>9.3f}ms {w['p95_ms']:>9.3f}ms  {w['n']}")
    print()
    print(f"  saved → {s['file']}")


if __name__ == "__main__":
    main()
