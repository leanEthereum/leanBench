//! Bake the pinned leanSig / leanMultisig refs (SHA + branch name) into
//! the binary so each result is provenance-complete. The Python
//! orchestrator prints these as part of the run metadata and the site
//! shows them in the run-detail page.

use std::{env, fs, path::PathBuf};

fn main() {
    let cargo_toml = manifest_dir().join("Cargo.toml");
    let cargo_lock = manifest_dir().join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", cargo_toml.display());
    println!("cargo:rerun-if-changed={}", cargo_lock.display());

    let Ok(toml) = fs::read_to_string(&cargo_toml) else { return };
    let lock = fs::read_to_string(&cargo_lock).unwrap_or_default();

    // Direct rev pins live on the dep line. For deps that defer to a
    // transitive spec (e.g. leansig, pulled via branch), the resolved
    // SHA only exists in Cargo.lock; fall back to that.
    let leansig_sha = find_rev(&toml, "leansig")
        .or_else(|| find_lock_sha(&lock, "leansig"));
    if let Some(rev) = leansig_sha {
        println!("cargo:rustc-env=LEANSIG_SHA={rev}");
    }
    if let Some(rev) = find_rev(&toml, "leansig_wrapper") {
        println!("cargo:rustc-env=LEANMULTISIG_SHA={rev}");
    }

    // Branch names live in [package.metadata.bench-pins] — cargo
    // disallows specifying both branch and rev on the same dep, so we
    // keep the branch info in a metadata table cargo ignores and read
    // it back here.
    if let Some(b) = find_kv(&toml, "leansig-branch") {
        println!("cargo:rustc-env=LEANSIG_BRANCH={b}");
    }
    if let Some(b) = find_kv(&toml, "leanmultisig-branch") {
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

/// Pull `<key> = "value"` out of the first line where it appears.
fn find_kv(text: &str, key: &str) -> Option<String> {
    let needle = format!("{key} = \"");
    for line in text.lines() {
        let t = line.trim();
        if let Some(start) = t.find(&needle) {
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
