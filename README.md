# leanBench

**Performance benchmarks for leanSig and leanVM across hardware.**

Run one command on a target machine → get a JSON file with sign / verify /
aggregate timings plus CPU and memory usage, committed back to this repo →
GitHub Pages renders it with charts grouped by machine.

Flow: `workloads/` (Rust binary) → `runner/` (Python harness) →
`results/*.json` → `scripts/site/build_index.py` → `site/` (static, deployed
to Pages).

## Workload groups

1. **leanVM aggregation** at `LOG_INV_RATE_PROD=2` — flat
   aggregation over 125 / 250 / 500 / 1000 sigs, plus tree aggregation
   with fan-in 2 / 4 / 8 over 125 / 250 / 500-sig leaves. 13 aggregate
   variants total, all run by default. split / merge_many variants
   are devnet5-only and gated out of the default set.

## Running on a target machine

### Prerequisites

- **Python ≥ 3.10** and [**uv**](https://docs.astral.sh/uv/) — uv manages
  the Python side (`psutil`).
- **rustc ≥ 1.87** via [rustup](https://rustup.rs/) — release builds use
  `target-cpu=native`. Cargo fetches everything else.
- On Linux, you may need `build-essential` and `pkg-config` if they
  aren't already installed.
- For `uv run remote-bench` only: the **gcloud** CLI. See
  [One-time GCP setup](#one-time-gcp-setup-least-privilege).

### Run default workloads

```bash
uv run bench
```

| Option | Description |
|---|---|
| `--label <name>` | Override the auto-detected label (defaults to hostname, falling back to a CPU-derived slug if the hostname is generic) |
| `--only <workload>` | Run only the named workload(s); pass the flag multiple times to include more than one workload |
| `--samples <N>` | Timed samples per workload (default 30); more = tighter stats at the cost of wall time |
| `--warmup <N>` | Warm-up runs before timing (default 3); more reduces cold-start noise |
| `--notes <text>` | Free-form note attached to the record |
| `--features <feat>` | Pick the API mode: `api-leansig` (devnet4 / devnet5 leanVM, default) or `api-xmss` (leanVM main). Forwarded to `cargo build`. |

Output lands at `results/<YYYY-MM-DDTHH-MM-SSZ>__<fingerprint>.json`. The
fingerprint is a 10-char hash of (CPU model, physical cores, memory GB, OS
family) — stable across runs on the same machine so the site groups them.
## Running on a remote VM (GCP)

GCP is the only provider currently supported — contributions to add others are welcome. First time? See [One-time GCP setup (least-privilege)](#one-time-gcp-setup-least-privilege) for the service-account, role, and credentials JSON setup.

The command below spins up a fresh VM, installs everything, runs the
benchmark, pulls the result JSON back locally, and destroys the VM:

```bash
# Run the default machine matrix (asks y/N before kicking off):
uv run remote-bench --credentials gcp-credentials.json

# Or pin a single machine type:
uv run remote-bench \
    --credentials gcp-credentials.json \
    --machine-type n2-standard-8 \
    --image-family ubuntu-2404-lts-amd64

# Bench against leanVM main (api-xmss path). Bump the Cargo.toml
# pin on a working branch first, then point remote-bench at it:
uv run remote-bench \
    --credentials gcp-credentials.json \
    --branch <your-working-branch> \
    --bench-args='--features api-xmss'
```

The default matrix is intentionally small and EIP-7870-anchored — defined
in [`scripts/cloud/remote_bench.py`](scripts/cloud/remote_bench.py) as
`DEFAULT_MACHINE_TYPES`.

| Option | Description |
|---|---|
| `--credentials <path>` | Path to GCP service-account JSON key (required) |
| `--machine-type <name>` | Pin to one machine type; default runs the full matrix |
| `--no-parallel` | Run VMs sequentially (parallel by default) |
| `--yes` / `-y` | Skip the y/N prompt in unattended runs |
| `--image-family <name>` | `ubuntu-2404-lts-amd64` for x86_64, `ubuntu-2404-lts-arm64` for ARM |
| `--project <id>` | Defaults to `project_id` from the credentials JSON |

The result lands in `./results/<timestamp>__<fingerprint>.json`. Commit
and push to this repo to share your results publicly. The VM is destroyed
in a `try/finally`, including on Ctrl-C; orphans are tagged
`lean-bench=true` so they're easy to spot.

VMs are provisioned as **Spot** (`--provisioning-model=SPOT`) for ~60–80% off
list price. GCP can reclaim a Spot VM at any time — if a machine gets
preempted mid-bench, its result is lost for that run. The VM
self-deletes on preemption (`--instance-termination-action=DELETE`) so no
manual cleanup is needed.

## Preview locally before pushing

```bash
uv run serve         # http://localhost:8000
uv run serve --port 4000
```

Serves `site/` and `results/` **live** from their source locations —
edit `site/app.js`, drop a new run JSON into `results/`, just refresh the
browser. `/results/index.json` is regenerated on every request so it always
reflects what's on disk.

## Contribute to the public dataset

The site is the union of every committed run file. If your machine isn't
already represented — different CPU generation, ARM, unusual core count,
atypical OS — your numbers fill a gap.

### How to contribute

1. Run the bench (`uv run bench` locally, or `uv run remote-bench` for
   cloud).
2. The result lands in `results/<timestamp>__<fingerprint>.json`. Don't
   edit it.
3. Commit and open a PR against `main`.
4. On merge, the site rebuilds and your machine appears grouped by
   fingerprint.

### Make your numbers worth the merge

- **Quiet machine.** Close browsers, kill background tasks. Sign / verify
  are single-threaded; aggregation uses Rayon — co-tenants skew both.
- **Use `--notes` for context.** Cooling, ambient temp, shared-host
  status, anything a future reader needs to interpret the numbers.
- **Use `--label` for cloud VMs.** `--label "gcp-c4-standard-8"` reads
  better than the auto-detected hostname.
- **Multiple runs on the same machine are fine** — they group by hardware
  fingerprint and the site shows variance.

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
│  ├─ Cargo.toml                 pins leanSig + leanVM SHAs
│  ├─ build.rs                   bakes the pinned SHAs into the binary
│  └─ src/
│     ├─ main.rs                 workload dispatch + per-sample timing
│     └─ workloads.rs            per-workload setup and measurement
├─ scripts/
│  ├─ site/                      static-site tooling
│  │  ├─ build_index.py          scans results/*.json → results/index.json (CI)
│  │  └─ dev_server.py           live-reload preview (uv run serve)
│  └─ cloud/                     remote-VM orchestration
│     ├─ remote_bench.py         spin up + tear down cloud VMs (uv run remote-bench)
│     ├─ remote_setup.sh         bash run on the VM after SSH is up
│     └─ provisioners/           cloud-provider drivers (currently GCP only)
├─ results/                      committed JSON, one file per run
├─ site/                         static site (vanilla JS + Chart.js, vendored)
│  ├─ index.html                 per-branch progress dashboard (the front page)
│  ├─ run.html                   combo overview — cross-machine comparison, proof sizes, scaling on c4
│  ├─ result.html                per-result-file detail with per-workload charts
│  ├─ topology.html              aggregation-topology feasibility explorer
│  ├─ trend-annotations.json     annotations layered on the front page's per-branch charts
│  ├─ app.js / topology.js
│  ├─ style.css
│  └─ vendor/                    chart.umd.min.js (no CDN dependency)
└─ .github/workflows/
   └─ deploy-pages.yml           on push: rebuild index + deploy site to Pages
```

## One-time GCP setup (least-privilege)

Avoid using your personal `gcloud` session for this — create a dedicated
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

## Reproducibility notes

- SHAs of leanSig and leanVM are pinned in `Cargo.toml` and baked into
  the runner binary by `build.rs` — the output JSON records them.
  Result-file keys still use the historical `leanmultisig_sha` /
  `leanmultisig_branch` names so old runs keep deserializing through one
  parser path. UI labels say "leanVM".
- Runner uses a deterministic seed (`--seed`, default `0xC0FFEE`) for all
  RNG draws — keygen entropy, message generation, and per-iteration key
  variation. Two machines running the same SHA with the same seed operate
  on byte-identical inputs, so timing deltas reflect hardware and build,
  not RNG luck.
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
- No turbo / governor pinning baked in. Pinning the governor to
  `performance` and disabling turbo gives a flat baseline (same clock all
  the time, no thermal-driven drift), so results don't depend on what the
  machine was doing 5 seconds ago (governor state) or ambient room
  temperature (turbo headroom).
