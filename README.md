# leanBench

**Performance benchmarks for leanSig and leanMultisig across hardware.**

Run one command on a target machine → get a JSON file with sign / verify /
aggregate timings plus CPU and memory usage, committed back to this repo →
GitHub Pages renders it with charts grouped by machine.

## Three workload groups

1. **leanSig** (the research crate at `leanEthereum/leanSig`, variant
   `SIGTargetSumLifetime20W4NoOff`) — keygen / sign / verify
2. **xmss** (the XMSS inside `leanEthereum/leanMultisig`, which is what
   leanSpec actually consumes) — keygen / sign / verify at crate defaults
3. **leanMultisig aggregation** at `LOG_INV_RATE_PROD=2` — one flat
   1000-sig leaf aggregation + one 2-to-1 recursion over two 500-sig leaves

Key-generation is opt-in (`--include-keygen`) because lifetime-2^20 keygen
is slow and rarely tells you something interesting about a machine.

## Running on a target machine

Dependencies: **rustc** (rustup) and **uv**. That's it — uv manages the
Python side (psutil); cargo fetches everything the runner binary needs.

```bash
# Once per machine:
curl -LsSf https://astral.sh/uv/install.sh | sh          # uv
curl https://sh.rustup.rs -sSf | sh                      # rustc

git clone <this-repo> leanBench
cd leanBench

# Run (default workloads, ~5-10 min on a modern machine).
# --label is optional; defaults to a CPU-derived slug.
uv run bench
```

The result lands in `results/<timestamp>__<fingerprint>.json`. Commit and
push it on your own schedule — the site rebuilds on every push to `main`.

`uv run` resolves deps from `pyproject.toml` + `uv.lock` on first invocation
and caches the venv under `.venv/`. No `pip install`, no activate step.

### Running on a remote VM (GCP)

Spin up a fresh VM, install everything, run the benchmark, pull the result
JSON back locally, destroy the VM:

```bash
# Run the default machine matrix (asks y/N before kicking off):
uv run remote-bench --credentials gcp-credentials.json

# Or pin a single machine type:
uv run remote-bench \
    --credentials gcp-credentials.json \
    --machine-type n2-standard-8 \
    --image-family ubuntu-2404-lts-amd64
```

The default matrix is intentionally small and EIP-7870-anchored:

  - `n1-standard-4` — Skylake / AVX2, older-gen baseline
  - `c4-standard-4` — Granite Rapids / AVX-512, A/B partner for n1 (isolates SIMD gen)
  - `c4-standard-8` — Granite Rapids / AVX-512, EIP-7870 Full Node tier
  - `c4-standard-16` — Granite Rapids / AVX-512, EIP-7870 Attester tier
  - `c4-standard-32` — Granite Rapids / AVX-512, high-end Rayon-scaling reference

Parallel by default (~30 min wall time, all four VMs running at once,
output line-prefixed with machine type so streams stay readable). Pass
`--no-parallel` for sequential runs (lower peak GCP concurrency, ~2 h
total). Use `--yes` / `-y` to skip the prompt in unattended runs.

Ubuntu 24.04 ships as arch-suffixed image families on GCP — use
`ubuntu-2404-lts-amd64` for x86_64 machine types (e.g. `n2-*`, `c3-*`,
`c4-*`) and `ubuntu-2404-lts-arm64` for ARM (e.g. `t2a-*`, Axion).

`--project` defaults to the `project_id` field in the credentials JSON;
pass it explicitly only if you want to bench in a different project.

The result lands in `./results/<timestamp>__<fingerprint>.json` ready for
you to commit. The VM is destroyed in a `try/finally`, including on
Ctrl-C; orphans are tagged `lean-bench=true` so they're easy to spot.

#### One-time GCP setup (least-privilege)

Don't use your personal `gcloud` session for this — create a dedicated
service account with a custom role limited to exactly what the script
needs.

1. **Create a service account**:
   ```bash
   gcloud iam service-accounts create lean-bench \
       --display-name="leanBench remote runner" \
       --project=$PROJECT
   ```

2. **Create a custom role with only these permissions**:
   - `compute.instances.create`
   - `compute.instances.delete`
   - `compute.instances.get`
   - `compute.instances.setMetadata`
   - `compute.instances.setLabels`
   - `compute.disks.create`
   - `compute.subnetworks.use`
   - `compute.subnetworks.useExternalIp`
   - `compute.zones.get`
   - `compute.projects.get`
   - `iap.tunnelInstances.accessViaIAP`

   ```bash
   gcloud iam roles create leanBenchRunner --project=$PROJECT \
       --title="leanBench runner" \
       --permissions=compute.instances.create,compute.instances.delete,compute.instances.get,compute.instances.setMetadata,compute.instances.setLabels,compute.disks.create,compute.subnetworks.use,compute.subnetworks.useExternalIp,compute.zones.get,compute.projects.get,iap.tunnelInstances.accessViaIAP
   ```

   To add a permission to an existing role:
   ```bash
   gcloud iam roles update leanBenchRunner --project=$PROJECT \
       --add-permissions=<permission.name>
   ```

3. **Grant the role to the SA** (optionally with an IAM Condition scoping
   to the `lean-bench=true` label so even a leaked key can only manage
   VMs the script itself created):
   ```bash
   gcloud projects add-iam-policy-binding $PROJECT \
       --member="serviceAccount:lean-bench@$PROJECT.iam.gserviceaccount.com" \
       --role="projects/$PROJECT/roles/leanBenchRunner"
   ```

4. **Create a JSON key** and stash it locally (gitignored):
   ```bash
   gcloud iam service-accounts keys create gcp-credentials.json \
       --iam-account="lean-bench@$PROJECT.iam.gserviceaccount.com"
   ```

5. **Enable required APIs once**:
   ```bash
   gcloud services enable compute.googleapis.com iap.googleapis.com --project=$PROJECT
   ```

The script activates the SA in a temp `CLOUDSDK_CONFIG` directory per
invocation — your normal `gcloud` session is never touched, and no auth
material persists after the script exits.

For extra safety, run benchmarks in their own GCP project so a compromise
stays contained, billing is isolated, and you can set a low budget alert
specifically for benchmark VMs.

### Preview locally before pushing

```bash
uv run serve         # http://localhost:8000
uv run serve --port 4000 --no-browser
```

Serves `site/` and `results/` **live** from their source locations —
edit `site/app.js`, drop a new run JSON into `results/`, just refresh the
browser. `/results/index.json` is regenerated on every request so it always
reflects what's on disk.

Flags worth knowing:
- `--label "nickname"` — override the auto-detected hostname label
- `--include-keygen` — also run leansig.keygen (slow) and xmss.keygen
- `--only <workload-name>` — run just one; repeatable
- `--samples N` (default 30) — samples per workload after `--warmup 3` warm-ups
- `--notes "quiet machine, no other load"` — free-form note attached to the record

Output lands at `results/<YYYY-MM-DDTHH-MM-SSZ>__<fingerprint>.json`. The
fingerprint is a 10-char hash of (CPU model, physical cores, memory GB, OS
family) — stable across runs on the same machine so the site groups them.

## Layout

```
leanBench/
├─ pyproject.toml                primary project; uv commands live here
├─ uv.lock
├─ runner/                       Python orchestrator (entry: `uv run bench`)
│  ├─ bench.py                   invokes binary, samples resources, writes JSON
│  ├─ sysinfo.py                 CPU / RAM / OS detection + fingerprint
│  └─ sampler.py                 psutil-based CPU/memory polling
├─ workloads/                    Rust binary, one subcommand per workload → JSON stdout
│  ├─ Cargo.toml                 pins leanSig + leanMultisig SHAs
│  └─ src/main.rs                workload dispatch + per-sample timing
├─ scripts/
│  ├─ build_index.py             scans results/*.json → results/index.json (CI)
│  └─ dev_server.py              live-reload preview (uv run serve)
├─ results/                      committed JSON, one file per run
├─ schema/v1.json                JSON Schema for current record shape
├─ site/                         static site (vanilla JS + Chart.js via CDN)
│  ├─ index.html                 list of machines; cross-machine comparison
│  ├─ run.html                   per-run detail with per-workload charts
│  ├─ app.js
│  └─ style.css
└─ .github/workflows/
   └─ deploy-pages.yml           on push: rebuild index + deploy site to Pages
```

## Schema evolution

`schema_version: 1` in every record. **Additive-only** evolution: new
versions may add fields but must never remove or repurpose existing ones.
The site branches on `schema_version` where necessary so old records always
render.

If a field is no longer meaningful in v2+, stop writing it — don't repurpose
the key.

## Deploy

1. Enable GitHub Pages: Settings → Pages → Source: *GitHub Actions*.
2. Push to `main` — the `deploy-pages.yml` workflow rebuilds
   `results/index.json`, stages `site/` + `results/`, and deploys.

No `gh-pages` branch; no manual steps after initial setup.

## Reproducibility notes

- SHAs of leanSig and leanMultisig are pinned in `Cargo.toml` and baked
  into the runner binary by `build.rs` — the output JSON records them.
- Runner uses deterministic seeds (`--seed`, default `0xC0FFEE`).
- The fingerprint is coarse by design — OS release and kernel changes
  don't break machine grouping. The full OS/kernel string is still in the
  record for diagnosis.

## Known caveats

- Aggregation benchmark returns total wall-clock including upstream
  one-time setup (DFT twiddles, bytecode init) on the first call. We use
  a per-workload warmup to amortize it; first process launch on a cold
  signer cache still regenerates 10k XMSS keys (~minutes on first run
  ever, cached thereafter).
- CPU percentage is summed across logical cores — a fully-utilized 16-core
  machine reports 1600%, not 100%.
- No turbo / governor pinning baked in. For mainnet-grade numbers, set
  the CPU governor to `performance` and disable turbo before running.
