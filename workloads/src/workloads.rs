//! Workload implementations. Each returns a Record with samples_ns and a
//! workload-specific metadata blob.

use anyhow::Result;

use crate::{make_record, time_loop, CommonArgs, Record};

pub mod xmss_wl {
    // GeneralizedXMSS at LOG_LIFETIME=32 — the variant leanVM's mainnet
    // ships. Mirrors leanSpec's PROD_CONFIG (DIMENSION=46,
    // BASE=8, TARGET_SUM=200, LOG_LIFETIME=32) — see
    // workspace/leanSpec/src/lean_spec/subspecs/xmss/constants.py.
    use super::*;
    use ::leansig::serialization::Serializable;
    use ::leansig::signature::SignatureScheme;
    use ::leansig_wrapper::{LeanSigScheme as Scheme, LOG_LIFETIME, MESSAGE_LENGTH};
    use ::rec_aggregation::signatures_cache::BENCHMARK_SLOT;
    use rand::{rngs::StdRng, RngExt, SeedableRng};

    pub fn keygen(args: &CommonArgs) -> Result<Record> {
        // Activate only one epoch — keygen scales linearly in epoch
        // count and lifetime 2^32 is infeasible to materialize in full.
        let mut samples = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let mut rng = StdRng::seed_from_u64(args.seed ^ i as u64);
            let t = std::time::Instant::now();
            let _ = Scheme::key_gen(&mut rng, BENCHMARK_SLOT as usize, 1);
            if i >= args.warmup {
                samples.push(t.elapsed().as_nanos());
            }
        }
        Ok(make_record(
            "xmss.keygen",
            samples,
            args.warmup,
            serde_json::json!({ "log_lifetime": LOG_LIFETIME, "num_active_epochs": 1 }),
        ))
    }

    pub fn sign(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let (_pk, sk) = Scheme::key_gen(&mut rng, BENCHMARK_SLOT as usize, 1);
        let msg: [u8; MESSAGE_LENGTH] = rng.random();

        let samples = time_loop(args, || {
            let _ = Scheme::sign(&sk, BENCHMARK_SLOT, &msg).expect("sign");
        });
        let sig = Scheme::sign(&sk, BENCHMARK_SLOT, &msg).expect("sign");
        let sig_bytes = sig.to_bytes().len();
        Ok(make_record(
            "xmss.sign",
            samples,
            args.warmup,
            serde_json::json!({
                "log_lifetime": LOG_LIFETIME,
                "message_bytes": MESSAGE_LENGTH,
                "signature_bytes": sig_bytes,
            }),
        ))
    }

    pub fn verify(args: &CommonArgs) -> Result<Record> {
        let mut rng = StdRng::seed_from_u64(args.seed);
        let (pk, sk) = Scheme::key_gen(&mut rng, BENCHMARK_SLOT as usize, 1);
        let msg: [u8; MESSAGE_LENGTH] = rng.random();
        let sig = Scheme::sign(&sk, BENCHMARK_SLOT, &msg).expect("sign");

        let samples = time_loop(args, || {
            assert!(Scheme::verify(&pk, BENCHMARK_SLOT, &msg, &sig));
        });
        let sig_bytes = sig.to_bytes().len();
        Ok(make_record(
            "xmss.verify",
            samples,
            args.warmup,
            serde_json::json!({
                "log_lifetime": LOG_LIFETIME,
                "signature_bytes": sig_bytes,
            }),
        ))
    }
}

pub mod aggregate {
    use super::*;
    use ::rec_aggregation::benchmark::{run_aggregation_benchmark, AggregationTopology, BenchmarkReport};
    use ::rec_aggregation::benchmark::{
        run_split_benchmark, run_merge_split_and_original_benchmark, run_merge_split_and_leaves_benchmark,
    };

    const LOG_INV_RATE: usize = 2;

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
    /// `silent=true` suppresses leanVM's ANSI render so the only thing
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
    pub fn flat_r2(args: &CommonArgs, n: usize) -> Result<Record> {
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

    /// `fan`-to-1 recursion: root combines `fan` `n`-sig leaves at LOG_INV_RATE_PROD=2.
    /// Reports total wall time including all leaves + the recursion step.
    /// Subtract `fan × aggregate.flat_<n>_r2` for the recursion-only cost.
    pub fn tree_r2(args: &CommonArgs, fan: usize, n: usize) -> Result<Record> {
        let leaf = AggregationTopology { raw_xmss: n, children: vec![], log_inv_rate: 2, overlap: 0 };
        let topology = AggregationTopology {
            raw_xmss: 0,
            children: vec![leaf; fan],
            log_inv_rate: 2,
            overlap: 0,
        };
        let (samples, proof_sizes, reports) = run_loop(args, &topology);
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.tree_{fan}x{n}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "leaf_raw_xmss": n,
                "fan_in": fan,
                "log_inv_rate": 2,
                "topology": format!("{fan}-to-1 recursion"),
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": format!("recursion-only time = root node `time_secs` from any report; or total - {fan} × aggregate.flat_{n}_r2 as a fallback"),
            }),
        ))
    }

    /// Closure-based variant of `run_loop`. Used by workloads that don't have
    /// an `AggregationTopology` (split / merge_split_* drivers).
    fn run_loop_with_runner<F: FnMut() -> BenchmarkReport>(
        args: &CommonArgs,
        mut runner: F,
    ) -> (Vec<u128>, Vec<ProofSizeEntry>, Vec<BenchmarkReport>) {
        let mut samples = Vec::with_capacity(args.samples);
        let mut proof_sizes: Vec<ProofSizeEntry> = Vec::new();
        let mut reports: Vec<BenchmarkReport> = Vec::with_capacity(args.samples);
        for i in 0..(args.samples + args.warmup) {
            let t = std::time::Instant::now();
            let report = runner();
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

    /// Benchmark `split_type_2` at index 0 of a K-component, N-per-component parent type-2
    /// at LOG_INV_RATE_PROD=2. Reports total wall time including parent type-2 setup
    /// (K leaf aggregations + 1 merge_many) plus the measured split.
    pub fn split_r2(args: &CommonArgs, per_component: usize, n_components: usize) -> Result<Record> {
        let (samples, proof_sizes, reports) = run_loop_with_runner(args, || {
            run_split_benchmark(per_component, n_components, LOG_INV_RATE, true)
        });
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.split_{n_components}x{per_component}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "per_component": per_component,
                "n_components": n_components,
                "log_inv_rate": LOG_INV_RATE,
                "operation": "split",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": "measured split sits at path=[] with kind=split_type2; setup nodes carry kind=aggregate_type1/merge_many_type1",
            }),
        ))
    }

    /// Benchmark `merge_many_type_1` over one split-derived type-1 (index 0 of a
    /// K-component parent type-2) and one freshly-aggregated original at LOG_INV_RATE_PROD=2.
    pub fn merge_split_and_original_r2(args: &CommonArgs, per_component: usize, n_components: usize) -> Result<Record> {
        let (samples, proof_sizes, reports) = run_loop_with_runner(args, || {
            run_merge_split_and_original_benchmark(per_component, n_components, LOG_INV_RATE, true)
        });
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.merge_split_and_original_{n_components}x{per_component}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "per_component": per_component,
                "n_components": n_components,
                "log_inv_rate": LOG_INV_RATE,
                "operation": "merge_split_and_original",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": "split-derived input at path=[1,0] (kind=split_type2); fresh original at path=[2] (kind=aggregate_type1); measured merge at path=[] (kind=merge_many_type1)",
            }),
        ))
    }

    /// Benchmark `aggregate_type_1` over one split-derived type-1 (index 0 of a
    /// K-component parent type-2) plus L fresh raw XMSS leaves at
    /// LOG_INV_RATE_PROD=2. Output claims N + L signers.
    pub fn merge_split_and_leaves_r2(
        args: &CommonArgs,
        per_component: usize,
        n_components: usize,
        n_new_leaves: usize,
    ) -> Result<Record> {
        let (samples, proof_sizes, reports) = run_loop_with_runner(args, || {
            run_merge_split_and_leaves_benchmark(per_component, n_components, n_new_leaves, LOG_INV_RATE, true)
        });
        let (root_kib, leaf_kib) = root_and_leaf_kib(&proof_sizes);
        Ok(make_record(
            &format!("aggregate.merge_split_and_leaves_{n_components}x{per_component}x{n_new_leaves}_r2"),
            samples,
            args.warmup,
            serde_json::json!({
                "per_component": per_component,
                "n_components": n_components,
                "n_new_leaves": n_new_leaves,
                "log_inv_rate": LOG_INV_RATE,
                "operation": "merge_split_and_leaves",
                "proof_kib_root": root_kib,
                "proof_kib_leaf": leaf_kib,
                "proof_kib_by_path": proof_sizes,
                "reports": reports,
                "note": "split-derived input at path=[1,0] (kind=split_type2); measured aggregate_type_1 at path=[] (kind=aggregate_type1), claiming N+L signers",
            }),
        ))
    }
}
