//! Bake the pinned leanSig / leanVM refs (SHA + branch name) into the
//! binary so each result is provenance-complete. The Python orchestrator
//! prints these as part of the run metadata and the site shows them in
//! the run-detail page.
//!
//! Env-var names (`LEANMULTISIG_SHA`, `LEANMULTISIG_BRANCH`) and the
//! TOML key (`leanmultisig-branch`) keep the historical "leanmultisig"
//! spelling so the on-disk result-file schema doesn't fork. leanVM is
//! the current upstream name (was renamed from leanMultisig 2026-06).
//!
//! Two modes, picked by the active cargo feature:
//!   - api-leansig: leanVM SHA from `leansig_wrapper`, leanSig SHA from
//!     the transitively-resolved `leansig` in Cargo.lock.
//!   - api-xmss: leanVM SHA from `xmss`. No leanSig dep — emit "n/a".

use std::{env, fs, path::PathBuf};

fn main() {
    let cargo_toml = manifest_dir().join("Cargo.toml");
    let cargo_lock = manifest_dir().join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", cargo_toml.display());
    println!("cargo:rerun-if-changed={}", cargo_lock.display());

    let Ok(toml) = fs::read_to_string(&cargo_toml) else { return };
    let lock = fs::read_to_string(&cargo_lock).unwrap_or_default();

    let api_leansig = env::var("CARGO_FEATURE_API_LEANSIG").is_ok();
    let api_xmss = env::var("CARGO_FEATURE_API_XMSS").is_ok();

    let (section, leanmultisig_dep, leansig_sha_override) = if api_xmss {
        ("[package.metadata.bench-pins.api-xmss]", "xmss", Some("n/a"))
    } else if api_leansig {
        ("[package.metadata.bench-pins.api-leansig]", "leansig_wrapper", None)
    } else {
        // No feature active (e.g. `cargo doc --no-default-features`); skip
        // baking. Downstream constants fall back to "unknown".
        return;
    };

    if let Some(override_sha) = leansig_sha_override {
        println!("cargo:rustc-env=LEANSIG_SHA={override_sha}");
    } else {
        // leansig is pulled transitively (we don't put a `rev =` on its
        // dep line), so the resolved SHA only exists in Cargo.lock.
        let leansig_sha = find_rev(&toml, "leansig")
            .or_else(|| find_lock_sha(&lock, "leansig"));
        if let Some(rev) = leansig_sha {
            println!("cargo:rustc-env=LEANSIG_SHA={rev}");
        }
    }

    if let Some(rev) = find_rev(&toml, leanmultisig_dep) {
        println!("cargo:rustc-env=LEANMULTISIG_SHA={rev}");
    }

    if let Some(b) = find_kv_in_section(&toml, section, "leansig-branch") {
        println!("cargo:rustc-env=LEANSIG_BRANCH={b}");
    }
    if let Some(b) = find_kv_in_section(&toml, section, "leanmultisig-branch") {
        println!("cargo:rustc-env=LEANMULTISIG_BRANCH={b}");
    }
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
}

/// Pull `rev = "..."` out of the line whose first token is `dep_name`.
fn find_rev(text: &str, dep_name: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        // Whole-token match — `leansig` must NOT match a line starting
        // with `leansig_wrapper`.
        if t.split_whitespace().next() != Some(dep_name) {
            continue;
        }
        if let Some(start) = t.find("rev = \"") {
            let after = &t[start + 7..];
            if let Some(end) = after.find('"') {
                return Some(after[..end].to_string());
            }
        }
    }
    None
}

/// Pull `<key> = "value"` out of the named section. Lines outside the
/// section header (and before the next `[…]` header) are ignored — keeps
/// keys with the same name in different sub-tables from leaking into
/// each other.
fn find_kv_in_section(text: &str, section: &str, key: &str) -> Option<String> {
    let needle = format!("{key} = \"");
    let mut in_section = false;
    for line in text.lines() {
        let t = line.trim();
        if t == section {
            in_section = true;
            continue;
        }
        if in_section && t.starts_with('[') {
            return None;
        }
        if in_section && let Some(start) = t.find(&needle) {
            let after = &t[start + needle.len()..];
            if let Some(end) = after.find('"') {
                return Some(after[..end].to_string());
            }
        }
    }
    None
}

/// Read the resolved git SHA for a `[[package]]` entry out of Cargo.lock.
/// Format we look for:
///
///     [[package]]
///     name = "<pkg>"
///     ...
///     source = "git+<url>?<refspec>#<sha>"
fn find_lock_sha(lock: &str, pkg: &str) -> Option<String> {
    let target = format!("name = \"{pkg}\"");
    let mut in_pkg = false;
    for line in lock.lines() {
        let t = line.trim();
        if t == target {
            in_pkg = true;
        } else if in_pkg && t.starts_with("source = \"git+") {
            if let Some(hash_pos) = t.rfind('#') {
                let after = &t[hash_pos + 1..];
                if let Some(end) = after.find('"') {
                    return Some(after[..end].to_string());
                }
            }
            return None;
        } else if in_pkg && t.starts_with("[[package]]") {
            in_pkg = false;
        }
    }
    None
}
