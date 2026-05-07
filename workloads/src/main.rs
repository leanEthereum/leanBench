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

    // clap derive's kebab-case converter doesn't insert a dash between a
    // letter and a digit (`AggregateFlat500` → `aggregate-flat500`), so we
    // override the CLI name explicitly to keep the dash-separated form that
    // bench.py and humans expect.
    #[command(name = "aggregate-flat-125",
              about = "Aggregation: flat 125-sig leaf at LOG_INV_RATE_PROD=2")]
    AggregateFlat125(CommonArgs),
    #[command(name = "aggregate-flat-250",
              about = "Aggregation: flat 250-sig leaf at LOG_INV_RATE_PROD=2")]
    AggregateFlat250(CommonArgs),
    #[command(name = "aggregate-flat-500",
              about = "Aggregation: flat 500-sig leaf at LOG_INV_RATE_PROD=2")]
    AggregateFlat500(CommonArgs),
    #[command(name = "aggregate-flat-1000",
              about = "Aggregation: flat 1000-sig leaf at LOG_INV_RATE_PROD=2")]
    AggregateFlat1000(CommonArgs),
    #[command(name = "aggregate-tree-125",
              about = "Aggregation: 2-to-1 recursion over two 125-sig leaves at r=2")]
    AggregateTree125(CommonArgs),
    #[command(name = "aggregate-tree-250",
              about = "Aggregation: 2-to-1 recursion over two 250-sig leaves at r=2")]
    AggregateTree250(CommonArgs),
    #[command(name = "aggregate-tree-500",
              about = "Aggregation: 2-to-1 recursion over two 500-sig leaves at r=2")]
    AggregateTree500(CommonArgs),
    #[command(name = "aggregate-tree4-125",
              about = "Aggregation: 4-to-1 recursion over four 125-sig leaves at r=2")]
    AggregateTree4x125(CommonArgs),
    #[command(name = "aggregate-tree4-250",
              about = "Aggregation: 4-to-1 recursion over four 250-sig leaves at r=2")]
    AggregateTree4x250(CommonArgs),
    #[command(name = "aggregate-tree4-500",
              about = "Aggregation: 4-to-1 recursion over four 500-sig leaves at r=2")]
    AggregateTree4x500(CommonArgs),
    #[command(name = "aggregate-tree8-125",
              about = "Aggregation: 8-to-1 recursion over eight 125-sig leaves at r=2")]
    AggregateTree8x125(CommonArgs),
    #[command(name = "aggregate-tree8-250",
              about = "Aggregation: 8-to-1 recursion over eight 250-sig leaves at r=2")]
    AggregateTree8x250(CommonArgs),
    #[command(name = "aggregate-tree8-500",
              about = "Aggregation: 8-to-1 recursion over eight 500-sig leaves at r=2")]
    AggregateTree8x500(CommonArgs),

    #[command(about = "Print version/provenance JSON and exit")]
    Provenance,
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
    #[serde(flatten)]
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
        Cli::AggregateFlat125(a)  => workloads::aggregate::flat_125_r2(&a),
        Cli::AggregateFlat250(a)  => workloads::aggregate::flat_250_r2(&a),
        Cli::AggregateFlat500(a)  => workloads::aggregate::flat_500_r2(&a),
        Cli::AggregateFlat1000(a) => workloads::aggregate::flat_1000_r2(&a),
        Cli::AggregateTree125(a)  => workloads::aggregate::tree_2x125_r2(&a),
        Cli::AggregateTree250(a)  => workloads::aggregate::tree_2x250_r2(&a),
        Cli::AggregateTree500(a)  => workloads::aggregate::tree_2x500_r2(&a),
        Cli::AggregateTree4x125(a) => workloads::aggregate::tree_4x125_r2(&a),
        Cli::AggregateTree4x250(a) => workloads::aggregate::tree_4x250_r2(&a),
        Cli::AggregateTree4x500(a) => workloads::aggregate::tree_4x500_r2(&a),
        Cli::AggregateTree8x125(a) => workloads::aggregate::tree_8x125_r2(&a),
        Cli::AggregateTree8x250(a) => workloads::aggregate::tree_8x250_r2(&a),
        Cli::AggregateTree8x500(a) => workloads::aggregate::tree_8x500_r2(&a),
        Cli::Provenance => {
            let j = serde_json::json!({
                "leansig_sha": LEANSIG_SHA,
                "leanmultisig_sha": LEANMULTISIG_SHA,
            });
            println!("{}", serde_json::to_string_pretty(&j)?);
            return Ok(());
        }
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
