//! Workload implementations. Each returns a Record with samples_ns and a
//! workload-specific metadata blob.

use anyhow::Result;

use crate::{make_record, time_loop, CommonArgs, Record};

pub mod leansig {
    use super::*;
    use ::leansig::serialization::Serializable;
    use ::leansig::signature::generalized_xmss::instantiations_poseidon::lifetime_2_to_the_20::target_sum::SIGTargetSumLifetime20W4NoOff as Scheme;
    use ::leansig::signature::{SignatureScheme, SignatureSchemeSecretKey};
    use ::leansig::MESSAGE_LENGTH;
    // leanSig pins rand 0.9; use the aliased import.
    use rand_09::{rngs::StdRng, Rng, SeedableRng};

    const VARIANT: &str = "SIGTargetSumLifetime20W4NoOff";

    pub fn keygen(args: &CommonArgs) -> Result<Record> {
        // Keygen is the heaviest operation (lifetime 2^20). Warmup = 0; we
        // measure the real cost from sample 0. Callers wanting stability use
        // higher --samples.
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let mut rng = StdRng::seed_from_u64(args.seed ^ i as u64);
            let t = std::time::Instant::now();
            let _ = Scheme::key_gen(&mut rng, 0, Scheme::LIFETIME as usize);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            "leansig.keygen",
            samples,
            args.warmup,
            serde_json::json!({ "variant": VARIANT, "lifetime_log2": 20 }),
        ))
    }

    pub fn sign(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let (_pk, sk) = Scheme::key_gen(&mut rng, 0, Scheme::LIFETIME as usize);
        let prepared = sk.get_prepared_interval();
        // Pick a fixed epoch inside the prepared window to avoid variance
        // from differing epoch positions.
        let epoch = prepared.clone().next().unwrap() as u32;
        let msg: [u8; MESSAGE_LENGTH] = rng.random();

        let samples = time_loop(args, || {
            let _ = Scheme::sign(&sk, epoch, &msg).expect("sign");
        });
        // Capture one signature size for the record.
        let sig = Scheme::sign(&sk, epoch, &msg).expect("sign");
        let sig_bytes = sig.to_bytes().len();
        Ok(make_record(
            "leansig.sign",
            samples,
            args.warmup,
            serde_json::json!({
                "variant": VARIANT,
                "lifetime_log2": 20,
                "message_bytes": MESSAGE_LENGTH,
                "signature_bytes": sig_bytes,
            }),
        ))
    }

    pub fn verify(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let (pk, sk) = Scheme::key_gen(&mut rng, 0, Scheme::LIFETIME as usize);
        let prepared = sk.get_prepared_interval();
        let epoch = prepared.clone().next().unwrap() as u32;
        let msg: [u8; MESSAGE_LENGTH] = rng.random();
        let sig = Scheme::sign(&sk, epoch, &msg).expect("sign");

        let samples = time_loop(args, || {
            assert!(Scheme::verify(&pk, epoch, &msg, &sig));
        });
        let sig_bytes = sig.to_bytes().len();
        Ok(make_record(
            "leansig.verify",
            samples,
            args.warmup,
            serde_json::json!({
                "variant": VARIANT,
                "lifetime_log2": 20,
                "signature_bytes": sig_bytes,
            }),
        ))
    }
}

pub mod xmss_wl {
    use super::*;
    use ::backend::KoalaBear;
    use ::xmss::signers_cache::{message_for_benchmark, BENCHMARK_SLOT};
    use ::xmss::{xmss_key_gen, xmss_sign, xmss_verify, MESSAGE_LEN_FE};
    use rand::{rngs::StdRng, RngExt, SeedableRng};

    pub fn keygen(args: &CommonArgs) -> Result<Record> {
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let mut rng = StdRng::seed_from_u64(args.seed ^ i as u64);
            let seed: [u8; 32] = rng.random();
            let t = std::time::Instant::now();
            let _ = xmss_key_gen(seed, BENCHMARK_SLOT, BENCHMARK_SLOT + 1);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            "xmss.keygen",
            samples,
            args.warmup,
            serde_json::json!({ "slot_range": 1, "log_lifetime": 32 }),
        ))
    }

    pub fn sign(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let seed: [u8; 32] = rng.random();
        let (sk, _pk) = xmss_key_gen(seed, BENCHMARK_SLOT, BENCHMARK_SLOT + 1).expect("keygen");
        let msg: [KoalaBear; MESSAGE_LEN_FE] = message_for_benchmark();

        let samples = time_loop(args, || {
            let _ = xmss_sign(&mut rng, &sk, &msg, BENCHMARK_SLOT).expect("sign");
        });
        // One signature for size metadata.
        let sig = xmss_sign(&mut rng, &sk, &msg, BENCHMARK_SLOT).expect("sign");
        let sig_bytes = postcard::to_allocvec(&sig).unwrap_or_default().len();
        Ok(make_record(
            "xmss.sign",
            samples,
            args.warmup,
            serde_json::json!({ "message_len_fe": MESSAGE_LEN_FE, "signature_bytes": sig_bytes }),
        ))
    }

    pub fn verify(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let seed: [u8; 32] = rng.random();
        let (sk, pk) = xmss_key_gen(seed, BENCHMARK_SLOT, BENCHMARK_SLOT + 1).expect("keygen");
        let msg: [KoalaBear; MESSAGE_LEN_FE] = message_for_benchmark();
        let sig = xmss_sign(&mut rng, &sk, &msg, BENCHMARK_SLOT).expect("sign");

        let samples = time_loop(args, || {
            xmss_verify(&pk, &msg, &sig, BENCHMARK_SLOT).expect("verify");
        });
        let sig_bytes = postcard::to_allocvec(&sig).unwrap_or_default().len();
        Ok(make_record(
            "xmss.verify",
            samples,
            args.warmup,
            serde_json::json!({ "signature_bytes": sig_bytes }),
        ))
    }
}

pub mod aggregate {
    use super::*;
    use ::rec_aggregation::{
        benchmark::{run_aggregation_benchmark, BenchmarkReport},
        AggregationTopology,
    };

    /// Per-node entry for the JSON `proof_kib_by_path` field.
    /// `path = []` is the root; deeper paths are the children/leaves.
    /// `depth` is convenience metadata (path length) so consumers don't have
    /// to rederive it.
    #[derive(serde::Serialize)]
    struct ProofSizeEntry {
        path: Vec<usize>,
        depth: usize,
        kib: usize,
    }

    /// Run the timed sample loop and return (samples_ns, proof_sizes_per_node, raw_reports).
    ///
    /// Proof sizes are deterministic for a given topology, so we surface them
    /// once as a flat per-path list (for the index summary) — the same data
    /// is also available inside `reports[i].nodes[j].stats.proof_kib` if
    /// callers want it from the raw stream.
    ///
    /// The full `Vec<BenchmarkReport>` is also kept and dumped into the JSON
    /// record so we never have to re-bench just to extract a metric we
    /// happened not to surface — `time_secs`, `cycles`, `memory`,
    /// `poseidons`, `dots`, `n_xmss` per node per iteration are all
    /// recoverable from the result file.
    ///
    /// `silent=true` suppresses leanMultisig's ANSI render so the only thing
    /// the runner prints is its own one-line JSON record.
    fn run_loop(args: &CommonArgs, topology: &AggregationTopology)
        -> (Vec<u128>, Vec<ProofSizeEntry>, Vec<BenchmarkReport>)
    {
        let mut samples = Vec::with_capacity(args.samples);
        let mut proof_sizes: Vec<ProofSizeEntry> = Vec::new();
        let mut reports: Vec<BenchmarkReport> = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let t = std::time::Instant::now();
            let report = run_aggregation_benchmark(topology, false, true);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
                if proof_sizes.is_empty() {
                    proof_sizes = report.nodes.iter()
                        .map(|n| ProofSizeEntry {
                            path: n.path.clone(),
                            depth: n.path.len(),
                            kib: n.stats.proof_kib,
                        })
                        .collect();
                }
                reports.push(report);
            }
        }
        (samples, proof_sizes, reports)
    }

    /// Pull out the root and (assumed-uniform) leaf proof sizes for the
    /// summary fields. Mid-tier sizes can be read off `proof_kib_by_path`
    /// when needed; we expose root + leaf as scalars because they're the
    /// two values most analyses care about (root → published proof,
    /// leaf → safe-target proof).
    fn root_and_leaf_kib(entries: &[ProofSizeEntry]) -> (Option<usize>, Option<usize>) {
        let root = entries.iter().find(|e| e.depth == 0).map(|e| e.kib);
        let leaf = entries.iter().map(|e| e.depth).max()
            .and_then(|d| entries.iter().find(|e| e.depth == d).map(|e| e.kib));
        (root, leaf)
    }

    /// One leaf aggregator over `n` raw XMSS signatures at LOG_INV_RATE_PROD=2.
    /// Aggregation internally does heavy one-time setup (DFT twiddles, bytecode,
    /// signer cache). First call amortises it, so the warmup iterations matter
    /// — we count only post-warmup samples.
    fn flat_n_r2(args: &CommonArgs, n: usize) -> Result<Record> {
        let topology = AggregationTopology { raw_xmss: n, children: vec![], log_inv_rate: 2, overlap: 0 };
        let (samples, proof_sizes, reports) = run_loop(args, &topology);
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.flat_{n}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "raw_xmss": n,
                "log_inv_rate": 2,
                "topology": "flat",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
            }),
        ))
    }

    pub fn flat_125_r2(args: &CommonArgs) -> Result<Record> { flat_n_r2(args, 125) }
    pub fn flat_250_r2(args: &CommonArgs) -> Result<Record> { flat_n_r2(args, 250) }
    pub fn flat_500_r2(args: &CommonArgs) -> Result<Record> { flat_n_r2(args, 500) }
    pub fn flat_1000_r2(args: &CommonArgs) -> Result<Record> { flat_n_r2(args, 1000) }

    /// 2-to-1 recursion: root combines two `n`-sig leaves at LOG_INV_RATE_PROD=2.
    /// Reports total wall time including both leaves + the recursion step.
    /// Subtract `2 × aggregate.flat_<n>_r2` for the recursion-only cost.
    fn tree_2xn_r2(args: &CommonArgs, n: usize) -> Result<Record> {
        let leaf = AggregationTopology { raw_xmss: n, children: vec![], log_inv_rate: 2, overlap: 0 };
        let topology = AggregationTopology {
            raw_xmss: 0,
            children: vec![leaf.clone(), leaf],
            log_inv_rate: 2,
            overlap: 0,
        };
        let (samples, proof_sizes, reports) = run_loop(args, &topology);
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.tree_2x{n}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "leaf_raw_xmss": n,
                "fan_in": 2,
                "log_inv_rate": 2,
                "topology": "2-to-1 recursion",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": format!("recursion-only time = root node `time_secs` from any report; or total - 2 × aggregate.flat_{n}_r2 as a fallback"),
            }),
        ))
    }

    pub fn tree_2x125_r2(args: &CommonArgs) -> Result<Record> { tree_2xn_r2(args, 125) }
    pub fn tree_2x250_r2(args: &CommonArgs) -> Result<Record> { tree_2xn_r2(args, 250) }
    pub fn tree_2x500_r2(args: &CommonArgs) -> Result<Record> { tree_2xn_r2(args, 500) }

    /// 4-to-1 recursion: root combines four `n`-sig leaves at LOG_INV_RATE_PROD=2.
    /// Reports total wall time including all four leaves + the recursion step.
    /// Subtract `4 × aggregate.flat_<n>_r2` for the recursion-only cost.
    fn tree_4xn_r2(args: &CommonArgs, n: usize) -> Result<Record> {
        let leaf = AggregationTopology { raw_xmss: n, children: vec![], log_inv_rate: 2, overlap: 0 };
        let topology = AggregationTopology {
            raw_xmss: 0,
            children: vec![leaf.clone(), leaf.clone(), leaf.clone(), leaf],
            log_inv_rate: 2,
            overlap: 0,
        };
        let (samples, proof_sizes, reports) = run_loop(args, &topology);
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.tree_4x{n}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "leaf_raw_xmss": n,
                "fan_in": 4,
                "log_inv_rate": 2,
                "topology": "4-to-1 recursion",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": format!("recursion-only time = root node `time_secs` from any report; or total - 4 × aggregate.flat_{n}_r2 as a fallback"),
            }),
        ))
    }

    pub fn tree_4x125_r2(args: &CommonArgs) -> Result<Record> { tree_4xn_r2(args, 125) }
    pub fn tree_4x250_r2(args: &CommonArgs) -> Result<Record> { tree_4xn_r2(args, 250) }
    pub fn tree_4x500_r2(args: &CommonArgs) -> Result<Record> { tree_4xn_r2(args, 500) }

    /// 8-to-1 recursion: root combines eight `n`-sig leaves at LOG_INV_RATE_PROD=2.
    /// Reports total wall time including all eight leaves + the recursion step.
    /// Subtract `8 × aggregate.flat_<n>_r2` for the recursion-only cost.
    fn tree_8xn_r2(args: &CommonArgs, n: usize) -> Result<Record> {
        let leaf = AggregationTopology { raw_xmss: n, children: vec![], log_inv_rate: 2, overlap: 0 };
        let topology = AggregationTopology {
            raw_xmss: 0,
            children: vec![
                leaf.clone(), leaf.clone(), leaf.clone(), leaf.clone(),
                leaf.clone(), leaf.clone(), leaf.clone(), leaf,
            ],
            log_inv_rate: 2,
            overlap: 0,
        };
        let (samples, proof_sizes, reports) = run_loop(args, &topology);
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.tree_8x{n}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "leaf_raw_xmss": n,
                "fan_in": 8,
                "log_inv_rate": 2,
                "topology": "8-to-1 recursion",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": format!("recursion-only time = root node `time_secs` from any report; or total - 8 × aggregate.flat_{n}_r2 as a fallback"),
            }),
        ))
    }

    pub fn tree_8x125_r2(args: &CommonArgs) -> Result<Record> { tree_8xn_r2(args, 125) }
    pub fn tree_8x250_r2(args: &CommonArgs) -> Result<Record> { tree_8xn_r2(args, 250) }
    pub fn tree_8x500_r2(args: &CommonArgs) -> Result<Record> { tree_8xn_r2(args, 500) }
}
