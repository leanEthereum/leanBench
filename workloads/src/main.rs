//! lean-bench-workloads — single binary that runs one workload per invocation
//! and prints a JSON record of per-sample timings on stdout.
//!
//! The Python orchestrator wraps each invocation to sample CPU and memory,
//! then merges everything into one committed run file. Per-invocation
//! process isolation means resource stats cover only that workload's work,
//! not the union.

use std::io::Write;
use std::time::Instant;

use anyhow::Result;
use clap::Parser;
use serde::Serialize;

mod workloads;

const LEANSIG_SHA: &str = match option_env!("LEANSIG_SHA") {
    Some(s) => s,
    None => "unknown",
};
const LEANMULTISIG_SHA: &str = match option_env!("LEANMULTISIG_SHA") {
    Some(s) => s,
    None => "unknown",
};

#[derive(Parser)]
#[command(version, about = "Run one leanSig / leanMultisig workload and emit JSON samples.")]
enum Cli {
    #[command(about = "leanSig key generation")]
    LeansigKeygen(CommonArgs),
    #[command(about = "leanSig sign (fixed instantiation)")]
    LeansigSign(CommonArgs),
    #[command(about = "leanSig verify")]
    LeansigVerify(CommonArgs),

    #[command(about = "XMSS (leanSpec-aligned) key generation")]
    XmssKeygen(CommonArgs),
    #[command(about = "XMSS sign")]
    XmssSign(CommonArgs),
    #[command(about = "XMSS verify")]
    XmssVerify(CommonArgs),

    #[command(name = "aggregate-flat",
              about = "Aggregation: flat n-sig leaf at LOG_INV_RATE_PROD=2")]
    AggregateFlat {
        /// Number of raw XMSS signatures to aggregate.
        n: usize,
        #[command(flatten)]
        common: CommonArgs,
    },
    #[command(name = "aggregate-tree",
              about = "Aggregation: fan-to-1 recursion over fan n-sig leaves at LOG_INV_RATE_PROD=2")]
    AggregateTree {
        /// Fan-in at the root (e.g. 2, 4, 8).
        fan: usize,
        /// Raw XMSS signatures per leaf.
        n: usize,
        #[command(flatten)]
        common: CommonArgs,
    },
}

#[derive(Parser, Clone)]
struct CommonArgs {
    /// Number of timed samples.
    #[arg(long, default_value_t = 30)]
    samples: usize,
    /// Warm-up iterations discarded before timing.
    #[arg(long, default_value_t = 3)]
    warmup: usize,
    /// Deterministic seed.
    #[arg(long, default_value_t = 0xC0FFEE)]
    seed: u64,
}

#[derive(Serialize)]
struct Record {
    workload: String,
    unit: &'static str,
    samples_ns: Vec<u128>,
    warmup: usize,
    meta: serde_json::Value,
    leansig_sha: &'static str,
    leanmultisig_sha: &'static str,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let rec = match cli {
        Cli::LeansigKeygen(a) => workloads::leansig::keygen(&a),
        Cli::LeansigSign(a)   => workloads::leansig::sign(&a),
        Cli::LeansigVerify(a) => workloads::leansig::verify(&a),
        Cli::XmssKeygen(a)    => workloads::xmss_wl::keygen(&a),
        Cli::XmssSign(a)      => workloads::xmss_wl::sign(&a),
        Cli::XmssVerify(a)    => workloads::xmss_wl::verify(&a),
        Cli::AggregateFlat { n, common } => workloads::aggregate::flat_r2(&common, n),
        Cli::AggregateTree { fan, n, common } => workloads::aggregate::tree_r2(&common, fan, n),
    }?;

    let out = serde_json::to_string(&rec)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(out.as_bytes())?;
    stdout.write_all(b"\n")?;
    Ok(())
}

/// Helper: time `f` for `args.samples` iterations after `args.warmup` warm-ups,
/// returning nanos-per-iter samples.
fn time_loop<F: FnMut()>(args: &CommonArgs, mut f: F) -> Vec<u128> {
    for _ in 0..args.warmup {
        f();
    }
    let mut samples = Vec::with_capacity(args.samples);
    for _ in 0..args.samples {
        let t = Instant::now();
        f();
        samples.push(t.elapsed().as_nanos());
    }
    samples
}

fn make_record(
    workload: &str,
    samples_ns: Vec<u128>,
    warmup: usize,
    meta: serde_json::Value,
) -> Record {
    Record {
        workload: workload.into(),
        unit: "ns",
        samples_ns,
        warmup,
        meta,
        leansig_sha: LEANSIG_SHA,
        leanmultisig_sha: LEANMULTISIG_SHA,
    }
}
