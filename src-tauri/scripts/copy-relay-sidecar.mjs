#!/usr/bin/env node
// Tauri's `bundle.externalBin` validates the sidecar path exists at
// cargo-build time (via tauri-build), but the binary it points to is itself
// produced by cargo build. Chicken-and-egg: this script bridges it by
// dropping an empty placeholder file in `binaries/` before cargo runs, then
// overwriting it with the real `target/release/verun-mcp-relay` once that
// binary has been compiled.
//
// Run from BOTH `beforeBuildCommand` (creates placeholder) and
// `beforeBundleCommand` (copies real binary). Idempotent in either order.

import { execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(HERE, "..");

function detectTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  if (process.env.CARGO_BUILD_TARGET) return process.env.CARGO_BUILD_TARGET;
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const match = out.match(/^host:\s*(.+)$/m);
  if (!match) throw new Error("could not derive host triple from `rustc -vV`");
  return match[1].trim();
}

function findBuiltRelay(triple, exe) {
  const name = `verun-mcp-relay${exe}`;
  const candidates = [
    resolve(SRC_TAURI, "target", triple, "release", name),
    resolve(SRC_TAURI, "target", "release", name),
    resolve(SRC_TAURI, "..", "target", triple, "release", name),
    resolve(SRC_TAURI, "..", "target", "release", name),
  ];
  return candidates.find((p) => existsSync(p));
}

const triple = detectTargetTriple();
const exe = triple.includes("windows") ? ".exe" : "";
const destDir = resolve(SRC_TAURI, "binaries");
const dest = resolve(destDir, `verun-mcp-relay-${triple}${exe}`);

mkdirSync(destDir, { recursive: true });

const built = findBuiltRelay(triple, exe);
if (built) {
  copyFileSync(built, dest);
  chmodSync(dest, 0o755);
  console.log(`[copy-relay-sidecar] ${built} -> ${dest}`);
} else if (!existsSync(dest)) {
  // Pre-build pass: tauri-build only checks file existence, so an empty
  // placeholder satisfies it. cargo will compile the real binary; the
  // beforeBundleCommand pass replaces this stub with the executable.
  writeFileSync(dest, "");
  console.log(`[copy-relay-sidecar] placeholder created at ${dest}`);
} else {
  console.log(`[copy-relay-sidecar] no fresh binary, leaving existing ${dest}`);
}
