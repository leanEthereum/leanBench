#!/usr/bin/env bash
#
# Remote setup + bench runner. Driven by scripts/remote_bench.py over
# SSH. Idempotent; designed to survive a re-run on the same VM during
# debugging. Reads three env vars set by the orchestrator before this
# script is sourced:
#
#   REPO_URL    URL to clone leanBench from
#   BRANCH      branch to fetch and check out
#   BENCH_ARGS  argv passed verbatim to `uv run bench` (word-split)

set -euo pipefail

# Wait out cloud-init before touching apt — avoids dpkg-lock contention
# during the first ~60s after boot.
echo '==> [remote] waiting for cloud-init...'
sudo cloud-init status --wait >/dev/null 2>&1 || true

echo '==> [remote] installing build prerequisites...'
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    build-essential git curl ca-certificates pkg-config tmux

if ! command -v cargo >/dev/null 2>&1; then
    echo '==> [remote] installing rustup...'
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal
fi
. "$HOME/.cargo/env"

if ! command -v uv >/dev/null 2>&1; then
    echo '==> [remote] installing uv...'
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

if [ ! -d leanBench ]; then
    echo "==> [remote] cloning $REPO_URL"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" leanBench
fi
cd leanBench
git fetch origin "$BRANCH" --quiet
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"

# leanVM generates ~10k XMSS test signatures lazily on first bench
# invocation (~few minutes on slow VMs). When SIGNERS_CACHE_DIR points at
# a directory holding a content-addressed cache file pre-uploaded by the
# orchestrator, the lazy-init loads from disk in milliseconds instead.
mkdir -p "$HOME/leanBench-signers"
export SIGNERS_CACHE_DIR="$HOME/leanBench-signers"

echo '==> [remote] launching bench in detached tmux session...'
# Detach the long bench (cargo build + 17 workloads, can run > 30 min)
# so a dropped SSH/IAP tunnel can't kill it. The orchestrator polls
# bench.log + tmux session state separately.
cat > run-bench.sh <<RUN
#!/usr/bin/env bash
# shellcheck disable=SC2086
uv run bench $BENCH_ARGS > bench.log 2>&1
echo "EXIT=\$?" > bench.exit
RUN
chmod +x run-bench.sh
tmux kill-session -t leanbench 2>/dev/null || true
tmux new-session -d -s leanbench ./run-bench.sh
echo '==> [remote] tmux session leanbench started; orchestrator will poll'
