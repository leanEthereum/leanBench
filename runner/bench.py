"""leanBench orchestrator.

Usage:
    python runner/bench.py --label my-laptop

Runs each workload in a separate subprocess of the Rust runner binary,
samples CPU/memory during the run, then writes one JSON file per run under
`results/<timestamp>__<fingerprint>.json`.

The output is committed as-is (no post-processing, no index rebuild — that
happens at deploy time in GH Actions).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import subprocess
import sys
from pathlib import Path

from runner import sysinfo
from runner.sampler import ResourceSampler

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# (cli-subcommand, workload-name, include-in-default-set, samples-override)
#
# xmss.sign uses rejection sampling against the WOTS+ TargetSum constraint;
# the per-sign cost is geometric and stays heavy-tailed (cv ≈ 0.85 across
# every machine in the matrix) regardless of how high the acceptance rate
# is — cv = √(1−p)/p ≈ 1 for any small p. n=30 gives a 95% CI on the mean
# of about ±30% (e.g. ±2.3 ms on a 7.6 ms mean on n1-standard-4); n=300
# tightens that to ~±10%. Other workloads sit at cv ≈ 0.05 and stay at
# n=30.
#
# (Pre-2026-05-05, leanMultisig WOTS+ also enforced a `V_GRINDING` lock
# that pushed acceptance to ≈ 1 in 2.3k attempts and the mean to ~220 ms.
# The grinding lock was removed in the 123 → 124 bit security rework, so
# the mean dropped ~45× — but the cv is unchanged.)
# Each row: (cli_args, workload_name, in_default_set, samples_override).
# `cli_args` is the argv passed to the Rust binary; for aggregate workloads
# the binary takes positional `n` (flat) or `fan n` (tree).
ALL_WORKLOADS: list[tuple[list[str], str, bool, int | None]] = [
    (["leansig-keygen"],       "leansig.keygen",          False, None),
    (["leansig-sign"],          "leansig.sign",            True,  None),
    (["leansig-verify"],        "leansig.verify",          True,  None),
    (["xmss-keygen"],           "xmss.keygen",             False, None),
    (["xmss-sign"],             "xmss.sign",               True,  300),
    (["xmss-verify"],           "xmss.verify",             True,  None),
    (["aggregate-flat", "125"],  "aggregate.flat_125_r2",   True,  None),
    (["aggregate-flat", "250"],  "aggregate.flat_250_r2",   True,  None),
    (["aggregate-flat", "500"],  "aggregate.flat_500_r2",   True,  None),
    (["aggregate-flat", "1000"], "aggregate.flat_1000_r2",  True,  None),
    (["aggregate-tree", "2", "125"], "aggregate.tree_2x125_r2", True, None),
    (["aggregate-tree", "2", "250"], "aggregate.tree_2x250_r2", True, None),
    (["aggregate-tree", "2", "500"], "aggregate.tree_2x500_r2", True, None),
    (["aggregate-tree", "4", "125"], "aggregate.tree_4x125_r2", True, None),
    (["aggregate-tree", "4", "250"], "aggregate.tree_4x250_r2", True, None),
    (["aggregate-tree", "4", "500"], "aggregate.tree_4x500_r2", True, None),
    (["aggregate-tree", "8", "125"], "aggregate.tree_8x125_r2", True, None),
    (["aggregate-tree", "8", "250"], "aggregate.tree_8x250_r2", True, None),
    (["aggregate-tree", "8", "500"], "aggregate.tree_8x500_r2", True, None),
]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default=None,
                    help="Human-readable nickname for this machine. "
                         "Defaults to hostname (or CPU-slug if hostname is generic).")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "results")
    ap.add_argument("--samples", type=int, default=30,
                    help="Timed samples per workload (warm-up excluded)")
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--include-keygen", action="store_true",
                    help="Also run leansig.keygen and xmss.keygen (slow)")
    ap.add_argument("--only", action="append", default=None,
                    help="Run only these workload names; repeatable. Implies --include-keygen "
                         "semantics if you list them explicitly.")
    ap.add_argument("--notes", default="",
                    help="Free-form note attached to the run record")
    return ap.parse_args()


def select_workloads(args) -> list[tuple[list[str], str, int | None]]:
    if args.only:
        requested = set(args.only)
        selected = [(cli, name, ovr) for (cli, name, _, ovr) in ALL_WORKLOADS if name in requested]
        missing = requested - {name for (_, name, _) in selected}
        if missing:
            sys.exit(f"unknown workload(s): {', '.join(sorted(missing))}")
        return selected
    return [
        (cli, name, ovr)
        for (cli, name, default, ovr) in ALL_WORKLOADS
        if default or args.include_keygen
    ]


RUST_DIR = ROOT / "workloads"


def build_runner() -> Path:
    """Build the Rust workload binary in release mode.

    Sets `RUSTFLAGS=-C target-cpu=native` in the subprocess env so deps
    (specifically leanMultisig's KoalaBear backend) compile with the host's
    SIMD target features. Without this, the build defaults to baseline
    x86-64 features, falls into leanMultisig's no-SIMD path
    (`type Packing = Self`), and trips a `w == 0` corner-case panic in its
    GKR sumcheck on x86_64 hosts.

    leanMultisig itself sets the same flag in its workspace
    `.cargo/config.toml` — that config doesn't apply when leanMultisig is
    consumed as a git dep, so we set it here instead.
    """
    print("Building lean-bench-workloads (release)...", flush=True)
    env = {**os.environ, "RUSTFLAGS": "-C target-cpu=native"}
    r = subprocess.run(
        ["cargo", "build", "--release", "--bin", "lean-bench-workloads",
         "--manifest-path", str(RUST_DIR / "Cargo.toml")],
        cwd=ROOT,
        env=env,
    )
    if r.returncode != 0:
        sys.exit("cargo build failed")
    return RUST_DIR / "target" / "release" / "lean-bench-workloads"


def run_workload(binary: Path, cli_args: list[str], samples: int, warmup: int) -> dict:
    """Run one workload subprocess, sample resources, return merged record."""
    proc = subprocess.Popen(
        [str(binary), *cli_args,
         "--samples", str(samples),
         "--warmup", str(warmup)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Delay sampler start slightly so we don't include the transient of
    # process startup. Rust binary loads dep crates, initializes etc.
    sampler = ResourceSampler(proc.pid, interval_ms=100)
    stdout_b, stderr_b = proc.communicate()
    resources = sampler.stop()

    if proc.returncode != 0:
        print(f"[error] {' '.join(cli_args)} exited {proc.returncode}")
        print(stderr_b.decode(errors="replace"), file=sys.stderr)
        return {}

    stdout = stdout_b.decode(errors="replace").strip()
    # Take the last line — stray cargo / tracing output may appear above.
    last_line = stdout.splitlines()[-1] if stdout else ""
    try:
        rec = json.loads(last_line)
    except json.JSONDecodeError as e:
        print(f"[error] {subcmd}: could not parse runner JSON: {e}\nstdout: {stdout!r}",
              file=sys.stderr)
        return {}

    samples_ns = rec.get("samples_ns", [])
    summary = _summarize(samples_ns)

    return {
        "name": rec["workload"],
        "unit": rec.get("unit", "ns"),
        "samples_ns": samples_ns,              # keep raw samples for charts
        "timing": summary,
        "resources": resources,
        "meta": {k: v for k, v in rec.items()
                 if k not in {"workload", "unit", "samples_ns", "warmup",
                              "leansig_sha", "leanmultisig_sha"}},
    }


def _summarize(samples: list[int]) -> dict:
    if not samples:
        return {}
    s = sorted(samples)
    n = len(s)
    mean = sum(s) / n
    var = sum((x - mean) ** 2 for x in s) / max(n - 1, 1)
    return {
        "n": n,
        "mean_ns": int(mean),
        "stddev_ns": int(math.sqrt(var)),
        "min_ns": int(s[0]),
        "p5_ns":  int(s[max(0, int(n * 0.05))]),
        "p50_ns": int(s[n // 2]),
        "p95_ns": int(s[max(0, int(n * 0.95) - 1)]),
        "max_ns": int(s[-1]),
    }


def read_provenance(binary: Path) -> dict:
    r = subprocess.run([str(binary), "provenance"], capture_output=True, text=True)
    if r.returncode != 0:
        return {"leansig_sha": "unknown", "leanmultisig_sha": "unknown"}
    return json.loads(r.stdout)


def main():
    args = parse_args()
    binary = build_runner()
    provenance = read_provenance(binary)

    machine = sysinfo.capture()
    label = args.label or sysinfo.auto_label()
    machine["label"] = label

    if args.label is None:
        print(f"Label (auto): {label}  (override with --label)")
    print(f"Machine: {machine['cpu_model']} ({machine['fingerprint']})")
    print(f"         {machine['physical_cores']} physical / "
          f"{machine['logical_cores']} logical cores, {machine['memory_gb']} GB RAM")
    print(f"         {machine['os']}")
    print()

    workloads_to_run = select_workloads(args)
    print(f"Running {len(workloads_to_run)} workload(s): "
          f"{', '.join(name for _, name, _ in workloads_to_run)}")
    print()

    workload_results = []
    for cli_args, name, samples_override in workloads_to_run:
        n = samples_override if samples_override is not None else args.samples
        suffix = f" (n={n})" if samples_override is not None else ""
        print(f"  → {name}{suffix} ...", end="", flush=True)
        rec = run_workload(binary, cli_args, n, args.warmup)
        if rec:
            mean_ms = rec["timing"]["mean_ns"] / 1e6
            print(f" {mean_ms:.2f} ms (n={rec['timing']['n']})")
            workload_results.append(rec)
        else:
            print(" FAILED")

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_id = f"{timestamp}__{machine['fingerprint']}"

    record = {
        "run_id": run_id,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "machine": machine,
        "toolchain": {**sysinfo.toolchain(), "git_shas": provenance},
        "workloads": workload_results,
        "notes": args.notes,
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out_dir / f"{run_id}.json"
    out_path.write_text(json.dumps(record, indent=2) + "\n")
    print()
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
