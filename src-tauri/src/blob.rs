// Content-addressed blob store for attachments.
//
// Bytes live on disk under `<app_data>/blobs/<aa>/<full-hash>.bin`, sharded
// by the first two hex chars of the sha256 to avoid huge directories. Every
// blob has a row in the `blobs` table (hash PK + mime + size + ref_count +
// timestamps). Identical bytes from different paste sites collapse to one
// blob — that is the whole point of the redesign vs. base64-in-JSONL.
//
// Lifecycle:
//   - write_blob: hash → upsert row → write file if new → return ref
//   - incr_ref / decr_ref: bumped when a Step or output_lines row gains/loses
//     a reference (Phase 6 wires the GC walk that prunes unreferenced blobs)
//   - read_blob_bytes: filesystem read; the row is the source of truth for
//     refcount, the file is the source of truth for bytes

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePool;
use sqlx::FromRow;
use std::path::{Path, PathBuf};

use crate::task::epoch_ms;

/// Newtype wrapper around the resolved Tauri app data dir, registered as
/// managed state so `#[tauri::command]` handlers can pull it via `State`.
/// Newtype (rather than raw PathBuf) so Tauri's type-keyed state lookup does
/// not collide with anything else that might want to manage a PathBuf.
pub struct AppDataDir(pub PathBuf);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub hash: String,
    pub mime: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // single-row diagnostic helper; only consumed by tests today
pub struct BlobInfo {
    pub hash: String,
    pub mime: String,
    pub size: i64,
    pub ref_count: i64,
    pub created_at: i64,
    pub last_used_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub total_bytes: i64,
    pub referenced_bytes: i64,
    pub unreferenced_bytes: i64,
    pub blob_count: i64,
    pub referenced_count: i64,
    pub unreferenced_count: i64,
}

pub fn blobs_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("blobs")
}

pub fn blob_path(app_data_dir: &Path, hash: &str) -> PathBuf {
    let shard = hash.get(..2).unwrap_or("00");
    blobs_dir(app_data_dir)
        .join(shard)
        .join(format!("{hash}.bin"))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(digest.len() * 2);
    use std::fmt::Write as _;
    for b in digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Write bytes to the blob store and upsert the DB row. Idempotent: if the
/// blob already exists we just touch `last_used_at` and return the existing
/// ref. Refcount is **not** incremented here — callers (steps, JSONL writes)
/// own that.
pub async fn write_blob(
    pool: &SqlitePool,
    app_data_dir: &Path,
    mime: &str,
    bytes: &[u8],
) -> Result<BlobRef, String> {
    let hash = hash_bytes(bytes);
    let size = bytes.len() as i64;
    let now = epoch_ms();

    let existing: Option<(String,)> = sqlx::query_as("SELECT hash FROM blobs WHERE hash = ?")
        .bind(&hash)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    if existing.is_none() {
        let path = blob_path(app_data_dir, &hash);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create blob dir: {e}"))?;
        }
        // Write to a temp file then rename — avoids a half-written blob if
        // the process dies mid-write.
        let tmp = path.with_extension("bin.tmp");
        tokio::fs::write(&tmp, bytes)
            .await
            .map_err(|e| format!("Failed to write blob: {e}"))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|e| format!("Failed to finalize blob: {e}"))?;

        sqlx::query(
            "INSERT INTO blobs (hash, mime, size, ref_count, created_at, last_used_at) \
             VALUES (?, ?, ?, 0, ?, ?)",
        )
        .bind(&hash)
        .bind(mime)
        .bind(size)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("UPDATE blobs SET last_used_at = ? WHERE hash = ?")
            .bind(now)
            .bind(&hash)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(BlobRef {
        hash,
        mime: mime.to_string(),
        size,
    })
}

pub async fn read_blob_bytes(app_data_dir: &Path, hash: &str) -> Result<Vec<u8>, String> {
    let path = blob_path(app_data_dir, hash);
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read blob {hash}: {e}"))
}

#[allow(dead_code)] // single-row diagnostic helper; only consumed by tests today
pub async fn get_blob_info(pool: &SqlitePool, hash: &str) -> Result<Option<BlobInfo>, String> {
    sqlx::query_as::<_, BlobInfo>("SELECT * FROM blobs WHERE hash = ?")
        .bind(hash)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

pub async fn incr_ref(pool: &SqlitePool, hash: &str) -> Result<(), String> {
    sqlx::query("UPDATE blobs SET ref_count = ref_count + 1, last_used_at = ? WHERE hash = ?")
        .bind(epoch_ms())
        .bind(hash)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn decr_ref(pool: &SqlitePool, hash: &str) -> Result<(), String> {
    // Floor at zero — a buggy double-decrement should not blow up the row.
    sqlx::query("UPDATE blobs SET ref_count = MAX(0, ref_count - 1) WHERE hash = ?")
        .bind(hash)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract every `hash` string from a JSON array of `AttachmentRef`-shaped
/// objects (the on-disk format of `Step.attachments_json`). Returns an empty
/// `Vec` if `json` is `None` / empty / malformed — refcount drift is
/// preferable to a panic. The GC sweep eventually catches orphans regardless.
pub fn extract_hashes_from_attachments_json(json: Option<&str>) -> Vec<String> {
    let Some(s) = json else { return Vec::new() };
    let s = s.trim();
    if s.is_empty() {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(s) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| item.get("hash").and_then(|h| h.as_str()).map(String::from))
        .collect()
}

/// Extract every blob hash referenced by a single NDJSON `output_lines` row.
/// Currently only `verun_user_message` carries refs; other types return
/// empty. Tolerant of malformed lines for the same reason as
/// `extract_hashes_from_attachments_json`.
pub fn extract_hashes_from_output_line(line: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("verun_user_message") {
        return Vec::new();
    }
    let Some(arr) = value.get("attachments").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| item.get("hash").and_then(|h| h.as_str()).map(String::from))
        .collect()
}

/// Bulk increment helper — batches into one round-trip per hash for now;
/// dedup-aware so a step that references the same blob twice bumps refcount
/// twice (matching the natural per-reference accounting).
pub async fn incr_refs(pool: &SqlitePool, hashes: &[String]) -> Result<(), String> {
    for h in hashes {
        incr_ref(pool, h).await?;
    }
    Ok(())
}

pub async fn decr_refs(pool: &SqlitePool, hashes: &[String]) -> Result<(), String> {
    for h in hashes {
        decr_ref(pool, h).await?;
    }
    Ok(())
}

/// Delete a single blob: file first, then the DB row. File-first ordering
/// makes a crash mid-delete leave a dangling row (recoverable on next sweep)
/// rather than a dangling file (which would leak forever).
pub async fn delete_blob(pool: &SqlitePool, app_data_dir: &Path, hash: &str) -> Result<(), String> {
    let path = blob_path(app_data_dir, hash);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        // Already gone is fine — row may have outlived the file (or vice versa).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to remove blob file {hash}: {e}")),
    }
    sqlx::query("DELETE FROM blobs WHERE hash = ?")
        .bind(hash)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// TTL sweep: delete blobs whose `ref_count = 0` and whose `last_used_at`
/// is older than `now - ttl_ms`. Returns the number of blobs reclaimed.
/// Skipped silently if `ttl_ms <= 0` (caller-disabled).
pub async fn gc_unreferenced(
    pool: &SqlitePool,
    app_data_dir: &Path,
    ttl_ms: i64,
) -> Result<u64, String> {
    if ttl_ms <= 0 {
        return Ok(0);
    }
    let cutoff = epoch_ms() - ttl_ms;
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT hash FROM blobs WHERE ref_count = 0 AND last_used_at < ?")
            .bind(cutoff)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

    let mut reclaimed = 0u64;
    for (hash,) in rows {
        if delete_blob(pool, app_data_dir, &hash).await.is_ok() {
            reclaimed += 1;
        }
    }
    Ok(reclaimed)
}

/// Hard-cap eviction: if total bytes exceed `max_bytes`, evict the oldest
/// `ref_count = 0` blobs (LRU by `last_used_at`) until we are under the cap
/// or no unreferenced blobs remain. Referenced blobs are never evicted —
/// they still belong to live steps / output lines.
///
/// `max_bytes <= 0` disables the cap.
pub async fn enforce_storage_cap(
    pool: &SqlitePool,
    app_data_dir: &Path,
    max_bytes: i64,
) -> Result<u64, String> {
    if max_bytes <= 0 {
        return Ok(0);
    }
    let stats = get_storage_stats(pool).await?;
    if stats.total_bytes <= max_bytes {
        return Ok(0);
    }

    let mut to_free = stats.total_bytes - max_bytes;
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT hash, size FROM blobs WHERE ref_count = 0 ORDER BY last_used_at ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut reclaimed = 0u64;
    for (hash, size) in rows {
        if to_free <= 0 {
            break;
        }
        if delete_blob(pool, app_data_dir, &hash).await.is_ok() {
            reclaimed += 1;
            to_free -= size;
        }
    }
    Ok(reclaimed)
}

pub async fn get_storage_stats(pool: &SqlitePool) -> Result<StorageStats, String> {
    let row: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT \
            COALESCE(SUM(size), 0), \
            COALESCE(SUM(CASE WHEN ref_count > 0 THEN size ELSE 0 END), 0), \
            COALESCE(SUM(CASE WHEN ref_count = 0 THEN size ELSE 0 END), 0), \
            COUNT(*), \
            COALESCE(SUM(CASE WHEN ref_count > 0 THEN 1 ELSE 0 END), 0), \
            COALESCE(SUM(CASE WHEN ref_count = 0 THEN 1 ELSE 0 END), 0) \
         FROM blobs",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(StorageStats {
        total_bytes: row.0,
        referenced_bytes: row.1,
        unreferenced_bytes: row.2,
        blob_count: row.3,
        referenced_count: row.4,
        unreferenced_count: row.5,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub steps_migrated: u64,
    pub output_lines_migrated: u64,
    pub blobs_created: u64,
    pub already_done: bool,
}

const LEGACY_ATTACHMENTS_SENTINEL: &str = "legacy_attachments_migrated";

/// One-shot migration: rewrites legacy `{name, mimeType, dataBase64}`
/// attachment entries in `steps.attachments_json` and `output_lines.line`
/// (verun_user_message) into the new `{hash, mimeType, name, size}` ref shape,
/// pushing the bytes into the blob store and bumping refcounts. Idempotent
/// via the `app_meta` sentinel — re-runs are no-ops once 'done' is set.
///
/// Crash safety: refcount is bumped BEFORE the row is rewritten. If the
/// process dies mid-row, retries will over-count (preserving the blob) rather
/// than under-count (which could let GC reclaim a still-referenced blob).
pub async fn migrate_legacy_attachments(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<MigrationReport, String> {
    if read_meta(pool, LEGACY_ATTACHMENTS_SENTINEL).await? == Some("done".to_string()) {
        return Ok(MigrationReport {
            steps_migrated: 0,
            output_lines_migrated: 0,
            blobs_created: 0,
            already_done: true,
        });
    }

    let mut report = MigrationReport {
        steps_migrated: 0,
        output_lines_migrated: 0,
        blobs_created: 0,
        already_done: false,
    };

    let step_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, attachments_json FROM steps \
         WHERE attachments_json IS NOT NULL AND attachments_json LIKE '%dataBase64%'",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (id, json) in step_rows {
        let Some((new_json, hashes, created)) =
            migrate_legacy_array(pool, app_data_dir, &json).await?
        else {
            continue;
        };
        incr_refs(pool, &hashes).await?;
        sqlx::query("UPDATE steps SET attachments_json = ? WHERE id = ?")
            .bind(&new_json)
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        report.steps_migrated += 1;
        report.blobs_created += created;
    }

    let line_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, line FROM output_lines \
         WHERE line LIKE '%dataBase64%' AND line LIKE '%verun_user_message%'",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (id, line) in line_rows {
        let Some((new_line, hashes, created)) =
            migrate_legacy_user_message_line(pool, app_data_dir, &line).await?
        else {
            continue;
        };
        incr_refs(pool, &hashes).await?;
        sqlx::query("UPDATE output_lines SET line = ? WHERE id = ?")
            .bind(&new_line)
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        report.output_lines_migrated += 1;
        report.blobs_created += created;
    }

    write_meta(pool, LEGACY_ATTACHMENTS_SENTINEL, "done").await?;
    Ok(report)
}

/// Decode every legacy `{name, mimeType, dataBase64}` entry into a blob and
/// return the rewritten JSON, the list of fresh hashes (for refcount), and a
/// count of blobs that didn't already exist. Returns `None` if the JSON has
/// no legacy entries — caller treats that as "skip this row".
async fn migrate_legacy_array(
    pool: &SqlitePool,
    app_data_dir: &Path,
    json: &str,
) -> Result<Option<(String, Vec<String>, u64)>, String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Ok(None);
    };
    let Some(arr) = value.as_array() else {
        return Ok(None);
    };

    let (rewritten, hashes, created) = rewrite_array(pool, app_data_dir, arr).await?;
    if hashes.is_empty() {
        return Ok(None);
    }
    let new_json = serde_json::to_string(&rewritten).map_err(|e| e.to_string())?;
    Ok(Some((new_json, hashes, created)))
}

/// Same idea for an NDJSON line; only verun_user_message lines get touched.
async fn migrate_legacy_user_message_line(
    pool: &SqlitePool,
    app_data_dir: &Path,
    line: &str,
) -> Result<Option<(String, Vec<String>, u64)>, String> {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Ok(None);
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("verun_user_message") {
        return Ok(None);
    }
    let Some(arr) = value.get("attachments").and_then(|a| a.as_array()) else {
        return Ok(None);
    };

    let (rewritten, hashes, created) = rewrite_array(pool, app_data_dir, arr).await?;
    if hashes.is_empty() {
        return Ok(None);
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "attachments".to_string(),
            serde_json::Value::Array(rewritten),
        );
    }
    let new_line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    Ok(Some((new_line, hashes, created)))
}

/// Walk a JSON array; replace any `{dataBase64, mimeType, name}` entry with a
/// fresh `{hash, mimeType, name, size}` ref by writing the bytes to the blob
/// store. Already-migrated entries are passed through unchanged (so a partial
/// retry stays correct). Returns the new array, hashes for refcount bumping,
/// and how many blobs were freshly created on disk.
async fn rewrite_array(
    pool: &SqlitePool,
    app_data_dir: &Path,
    arr: &[serde_json::Value],
) -> Result<(Vec<serde_json::Value>, Vec<String>, u64), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let mut out = Vec::with_capacity(arr.len());
    let mut new_hashes = Vec::new();
    let mut created = 0u64;

    for item in arr {
        let Some(obj) = item.as_object() else {
            out.push(item.clone());
            continue;
        };
        let data_b64 = obj.get("dataBase64").and_then(|v| v.as_str());
        let Some(b64) = data_b64 else {
            out.push(item.clone());
            continue;
        };
        let mime = obj
            .get("mimeType")
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream");
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("attachment");
        let bytes = STANDARD
            .decode(b64)
            .map_err(|e| format!("base64 decode failed: {e}"))?;

        let pre: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blobs")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        let r = write_blob(pool, app_data_dir, mime, &bytes).await?;
        let post: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blobs")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        if post.0 > pre.0 {
            created += 1;
        }

        new_hashes.push(r.hash.clone());
        out.push(serde_json::json!({
            "hash": r.hash,
            "mimeType": r.mime,
            "name": name,
            "size": r.size,
        }));
    }

    Ok((out, new_hashes, created))
}

async fn read_meta(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_meta WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.0))
}

async fn write_meta(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use tempfile::TempDir;

    async fn test_setup() -> (SqlitePool, TempDir) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for m in migrations() {
            sqlx::query(m.sql).execute(&pool).await.unwrap();
        }
        let tmp = TempDir::new().unwrap();
        (pool, tmp)
    }

    #[test]
    fn hash_bytes_is_stable_sha256() {
        // Empty SHA-256 — the canonical fixture.
        assert_eq!(
            hash_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // "hello" SHA-256 — second canonical fixture.
        assert_eq!(
            hash_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn blob_path_shards_by_first_two_hex_chars() {
        let dir = Path::new("/tmp/app");
        let path = blob_path(dir, "abcdef0123");
        assert_eq!(path, Path::new("/tmp/app/blobs/ab/abcdef0123.bin"));
    }

    #[tokio::test]
    async fn write_blob_creates_row_and_file() {
        let (pool, tmp) = test_setup().await;
        let bytes = b"hello world";

        let r = write_blob(&pool, tmp.path(), "text/plain", bytes)
            .await
            .unwrap();

        assert_eq!(r.hash, hash_bytes(bytes));
        assert_eq!(r.mime, "text/plain");
        assert_eq!(r.size, 11);

        let on_disk = tokio::fs::read(blob_path(tmp.path(), &r.hash))
            .await
            .unwrap();
        assert_eq!(on_disk, bytes);

        let info = get_blob_info(&pool, &r.hash).await.unwrap().unwrap();
        assert_eq!(info.ref_count, 0);
        assert_eq!(info.size, 11);
    }

    #[tokio::test]
    async fn write_blob_dedups_identical_bytes() {
        let (pool, tmp) = test_setup().await;
        let bytes = b"same bytes";

        let r1 = write_blob(&pool, tmp.path(), "image/png", bytes)
            .await
            .unwrap();
        let r2 = write_blob(&pool, tmp.path(), "image/png", bytes)
            .await
            .unwrap();

        assert_eq!(r1.hash, r2.hash);

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blobs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "duplicate write should not insert a second row");
    }

    #[tokio::test]
    async fn write_blob_recovers_from_partial_temp_file() {
        // If a previous run died mid-write and left a `.bin.tmp` next to the
        // shard, the next write_blob for the same content should still succeed
        // (the rename overwrites or the temp is harmless).
        let (pool, tmp) = test_setup().await;
        let bytes = b"recovery";
        // Write once successfully.
        let r = write_blob(&pool, tmp.path(), "application/octet-stream", bytes)
            .await
            .unwrap();
        // Plant a stale .tmp; second write must not fail.
        let stale = blob_path(tmp.path(), &r.hash).with_extension("bin.tmp");
        tokio::fs::write(&stale, b"junk").await.unwrap();
        let r2 = write_blob(&pool, tmp.path(), "application/octet-stream", bytes)
            .await
            .unwrap();
        assert_eq!(r.hash, r2.hash);
    }

    #[tokio::test]
    async fn read_blob_bytes_round_trips() {
        let (pool, tmp) = test_setup().await;
        let bytes: Vec<u8> = (0u8..=255).collect();
        let r = write_blob(&pool, tmp.path(), "image/png", &bytes)
            .await
            .unwrap();

        let read = read_blob_bytes(tmp.path(), &r.hash).await.unwrap();
        assert_eq!(read, bytes);
    }

    #[tokio::test]
    async fn incr_decr_ref_track_count() {
        let (pool, tmp) = test_setup().await;
        let r = write_blob(&pool, tmp.path(), "image/png", b"x")
            .await
            .unwrap();

        incr_ref(&pool, &r.hash).await.unwrap();
        incr_ref(&pool, &r.hash).await.unwrap();
        let info = get_blob_info(&pool, &r.hash).await.unwrap().unwrap();
        assert_eq!(info.ref_count, 2);

        decr_ref(&pool, &r.hash).await.unwrap();
        let info = get_blob_info(&pool, &r.hash).await.unwrap().unwrap();
        assert_eq!(info.ref_count, 1);
    }

    #[tokio::test]
    async fn decr_ref_floors_at_zero() {
        let (pool, tmp) = test_setup().await;
        let r = write_blob(&pool, tmp.path(), "image/png", b"x")
            .await
            .unwrap();

        // No incr — refcount is 0. Decrement must not go negative.
        decr_ref(&pool, &r.hash).await.unwrap();
        let info = get_blob_info(&pool, &r.hash).await.unwrap().unwrap();
        assert_eq!(info.ref_count, 0);
    }

    #[tokio::test]
    async fn get_storage_stats_partitions_referenced_vs_unreferenced() {
        let (pool, tmp) = test_setup().await;
        let a = write_blob(&pool, tmp.path(), "image/png", b"aaaa")
            .await
            .unwrap();
        let _b = write_blob(&pool, tmp.path(), "image/png", b"bbbbbb")
            .await
            .unwrap();
        incr_ref(&pool, &a.hash).await.unwrap();

        let stats = get_storage_stats(&pool).await.unwrap();
        assert_eq!(stats.blob_count, 2);
        assert_eq!(stats.total_bytes, 10);
        assert_eq!(stats.referenced_count, 1);
        assert_eq!(stats.referenced_bytes, 4);
        assert_eq!(stats.unreferenced_count, 1);
        assert_eq!(stats.unreferenced_bytes, 6);
    }

    #[tokio::test]
    async fn get_storage_stats_empty_db_returns_zeros() {
        let (pool, _tmp) = test_setup().await;
        let stats = get_storage_stats(&pool).await.unwrap();
        assert_eq!(
            stats,
            StorageStats {
                total_bytes: 0,
                referenced_bytes: 0,
                unreferenced_bytes: 0,
                blob_count: 0,
                referenced_count: 0,
                unreferenced_count: 0,
            }
        );
    }

    #[tokio::test]
    async fn read_blob_bytes_missing_hash_errors() {
        let (_pool, tmp) = test_setup().await;
        let err = read_blob_bytes(tmp.path(), "deadbeef").await.unwrap_err();
        assert!(err.contains("deadbeef"));
    }

    #[test]
    fn extract_hashes_from_attachments_json_handles_none_and_empty() {
        assert!(extract_hashes_from_attachments_json(None).is_empty());
        assert!(extract_hashes_from_attachments_json(Some("")).is_empty());
        assert!(extract_hashes_from_attachments_json(Some("   ")).is_empty());
    }

    #[test]
    fn extract_hashes_from_attachments_json_pulls_hashes() {
        let json = r#"[
            {"hash":"aaa","mimeType":"image/png","name":"a.png","size":4},
            {"hash":"bbb","mimeType":"image/png","name":"b.png","size":5}
        ]"#;
        let out = extract_hashes_from_attachments_json(Some(json));
        assert_eq!(out, vec!["aaa".to_string(), "bbb".to_string()]);
    }

    #[test]
    fn extract_hashes_from_attachments_json_skips_malformed_entries() {
        // Mix valid + missing hash + non-object — only the well-formed entry survives.
        let json = r#"[{"hash":"ok"},{"name":"orphan"},42]"#;
        let out = extract_hashes_from_attachments_json(Some(json));
        assert_eq!(out, vec!["ok".to_string()]);
    }

    #[test]
    fn extract_hashes_from_attachments_json_returns_empty_for_invalid_json() {
        assert!(extract_hashes_from_attachments_json(Some("not json")).is_empty());
        assert!(extract_hashes_from_attachments_json(Some("{\"x\":1}")).is_empty());
    }

    #[test]
    fn extract_hashes_from_output_line_finds_user_message_refs() {
        let line = r#"{"type":"verun_user_message","text":"hi","attachments":[{"hash":"h1","mimeType":"image/png","name":"a","size":1},{"hash":"h2","mimeType":"image/png","name":"b","size":2}]}"#;
        assert_eq!(
            extract_hashes_from_output_line(line),
            vec!["h1".to_string(), "h2".to_string()]
        );
    }

    #[test]
    fn extract_hashes_from_output_line_ignores_other_event_types() {
        let line = r#"{"type":"system","text":"unrelated"}"#;
        assert!(extract_hashes_from_output_line(line).is_empty());
    }

    #[test]
    fn extract_hashes_from_output_line_returns_empty_when_no_attachments() {
        let line = r#"{"type":"verun_user_message","text":"no images"}"#;
        assert!(extract_hashes_from_output_line(line).is_empty());
    }

    #[tokio::test]
    async fn delete_blob_removes_file_and_row() {
        let (pool, tmp) = test_setup().await;
        let r = write_blob(&pool, tmp.path(), "image/png", b"bye")
            .await
            .unwrap();
        let path = blob_path(tmp.path(), &r.hash);
        assert!(path.exists());

        delete_blob(&pool, tmp.path(), &r.hash).await.unwrap();

        assert!(!path.exists());
        assert!(get_blob_info(&pool, &r.hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_blob_tolerates_missing_file() {
        let (pool, tmp) = test_setup().await;
        let r = write_blob(&pool, tmp.path(), "image/png", b"x")
            .await
            .unwrap();
        // Pre-delete the file out from under the row — DB row should still go.
        tokio::fs::remove_file(blob_path(tmp.path(), &r.hash))
            .await
            .unwrap();

        delete_blob(&pool, tmp.path(), &r.hash).await.unwrap();
        assert!(get_blob_info(&pool, &r.hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn gc_unreferenced_reclaims_old_zero_ref_blobs() {
        let (pool, tmp) = test_setup().await;
        let stale = write_blob(&pool, tmp.path(), "image/png", b"stale")
            .await
            .unwrap();
        let live = write_blob(&pool, tmp.path(), "image/png", b"live")
            .await
            .unwrap();
        // Backdate the stale row so it falls outside the TTL window.
        sqlx::query("UPDATE blobs SET last_used_at = 0 WHERE hash = ?")
            .bind(&stale.hash)
            .execute(&pool)
            .await
            .unwrap();
        // Live blob is referenced — must survive even with the same age.
        incr_ref(&pool, &live.hash).await.unwrap();
        sqlx::query("UPDATE blobs SET last_used_at = 0 WHERE hash = ?")
            .bind(&live.hash)
            .execute(&pool)
            .await
            .unwrap();

        let reclaimed = gc_unreferenced(&pool, tmp.path(), 1_000).await.unwrap();
        assert_eq!(reclaimed, 1);
        assert!(get_blob_info(&pool, &stale.hash).await.unwrap().is_none());
        assert!(get_blob_info(&pool, &live.hash).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn gc_unreferenced_skips_recent_zero_ref_blobs() {
        let (pool, tmp) = test_setup().await;
        // Just-written → last_used_at ≈ now. With a TTL of 1 hour this row
        // must NOT be reclaimed yet.
        let r = write_blob(&pool, tmp.path(), "image/png", b"fresh")
            .await
            .unwrap();
        let reclaimed = gc_unreferenced(&pool, tmp.path(), 60 * 60 * 1000)
            .await
            .unwrap();
        assert_eq!(reclaimed, 0);
        assert!(get_blob_info(&pool, &r.hash).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn gc_unreferenced_disabled_when_ttl_non_positive() {
        let (pool, tmp) = test_setup().await;
        let r = write_blob(&pool, tmp.path(), "image/png", b"old")
            .await
            .unwrap();
        sqlx::query("UPDATE blobs SET last_used_at = 0 WHERE hash = ?")
            .bind(&r.hash)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(gc_unreferenced(&pool, tmp.path(), 0).await.unwrap(), 0);
        assert_eq!(gc_unreferenced(&pool, tmp.path(), -1).await.unwrap(), 0);
        assert!(get_blob_info(&pool, &r.hash).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn enforce_storage_cap_evicts_oldest_unreferenced_until_under_cap() {
        let (pool, tmp) = test_setup().await;
        let a = write_blob(&pool, tmp.path(), "image/png", b"aaaaa") // 5
            .await
            .unwrap();
        let b = write_blob(&pool, tmp.path(), "image/png", b"bbbbbb") // 6
            .await
            .unwrap();
        let c = write_blob(&pool, tmp.path(), "image/png", b"ccccccc") // 7
            .await
            .unwrap();
        // a is oldest, b mid, c newest — set last_used_at explicitly.
        sqlx::query("UPDATE blobs SET last_used_at = 100 WHERE hash = ?")
            .bind(&a.hash)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE blobs SET last_used_at = 200 WHERE hash = ?")
            .bind(&b.hash)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE blobs SET last_used_at = 300 WHERE hash = ?")
            .bind(&c.hash)
            .execute(&pool)
            .await
            .unwrap();

        // Cap at 10 bytes — total is 18, must reclaim ≥ 8 bytes by evicting
        // a (5) then b (6) for 11 bytes freed, leaving c (7) under the cap.
        let reclaimed = enforce_storage_cap(&pool, tmp.path(), 10).await.unwrap();
        assert_eq!(reclaimed, 2);
        assert!(get_blob_info(&pool, &a.hash).await.unwrap().is_none());
        assert!(get_blob_info(&pool, &b.hash).await.unwrap().is_none());
        assert!(get_blob_info(&pool, &c.hash).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn enforce_storage_cap_keeps_referenced_blobs() {
        let (pool, tmp) = test_setup().await;
        let pinned = write_blob(
            &pool,
            tmp.path(),
            "image/png",
            b"pinned-large-blob-xxxxxxxxxxxxxxxxxxxxxxxxxx",
        )
        .await
        .unwrap();
        incr_ref(&pool, &pinned.hash).await.unwrap();

        // Cap is well under the pinned blob — but it must NOT be evicted
        // because something still holds a ref.
        let reclaimed = enforce_storage_cap(&pool, tmp.path(), 1).await.unwrap();
        assert_eq!(reclaimed, 0);
        assert!(get_blob_info(&pool, &pinned.hash).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn enforce_storage_cap_disabled_when_max_non_positive() {
        let (pool, tmp) = test_setup().await;
        let r = write_blob(&pool, tmp.path(), "image/png", b"x")
            .await
            .unwrap();
        assert_eq!(enforce_storage_cap(&pool, tmp.path(), 0).await.unwrap(), 0);
        assert_eq!(enforce_storage_cap(&pool, tmp.path(), -1).await.unwrap(), 0);
        assert!(get_blob_info(&pool, &r.hash).await.unwrap().is_some());
    }

    // -- migration tests ----------------------------------------------------

    use base64::{engine::general_purpose::STANDARD, Engine as _};

    async fn ensure_session(pool: &SqlitePool) {
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, name, repo_path, created_at) \
             VALUES ('p', 'p', '/tmp', 0)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT OR IGNORE INTO tasks (id, project_id, name, branch, worktree_path, created_at) \
             VALUES ('t', 'p', 't', 'b', '/tmp/t', 0)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT OR IGNORE INTO sessions (id, task_id, status, started_at) \
             VALUES ('s', 't', 'running', 0)",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_step_with_legacy_attachments(pool: &SqlitePool, id: &str, json: &str) {
        ensure_session(pool).await;
        sqlx::query(
            "INSERT INTO steps (id, session_id, message, attachments_json, sort_order, created_at) \
             VALUES (?, 's', 'hello', ?, 0, 0)",
        )
        .bind(id)
        .bind(json)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_output_line(pool: &SqlitePool, line: &str) -> i64 {
        ensure_session(pool).await;
        sqlx::query("INSERT INTO output_lines (session_id, line, emitted_at) VALUES ('s', ?, 0)")
            .bind(line)
            .execute(pool)
            .await
            .unwrap();
        let row: (i64,) = sqlx::query_as("SELECT last_insert_rowid()")
            .fetch_one(pool)
            .await
            .unwrap();
        row.0
    }

    fn b64(b: &[u8]) -> String {
        STANDARD.encode(b)
    }

    #[tokio::test]
    async fn migrate_legacy_step_writes_blob_and_rewrites_json() {
        let (pool, tmp) = test_setup().await;
        let bytes = b"image-bytes";
        let legacy = format!(
            r#"[{{"name":"img.png","mimeType":"image/png","dataBase64":"{}"}}]"#,
            b64(bytes)
        );
        seed_step_with_legacy_attachments(&pool, "step-1", &legacy).await;

        let report = migrate_legacy_attachments(&pool, tmp.path()).await.unwrap();
        assert_eq!(report.steps_migrated, 1);
        assert_eq!(report.blobs_created, 1);
        assert!(!report.already_done);

        let (new_json,): (String,) =
            sqlx::query_as("SELECT attachments_json FROM steps WHERE id = 'step-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let v: serde_json::Value = serde_json::from_str(&new_json).unwrap();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let entry = &arr[0];
        assert_eq!(entry["hash"].as_str().unwrap(), hash_bytes(bytes));
        assert_eq!(entry["mimeType"], "image/png");
        assert_eq!(entry["name"], "img.png");
        assert_eq!(entry["size"], bytes.len());
        assert!(entry.get("dataBase64").is_none());

        let info = get_blob_info(&pool, &hash_bytes(bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(info.ref_count, 1);
        assert_eq!(info.size, bytes.len() as i64);
    }

    #[tokio::test]
    async fn migrate_legacy_output_line_rewrites_user_message_attachments() {
        let (pool, tmp) = test_setup().await;
        let bytes = b"png-bytes";
        let line = format!(
            r#"{{"type":"verun_user_message","text":"hi","attachments":[{{"name":"a.png","mimeType":"image/png","dataBase64":"{}"}}],"plan_mode":false,"thinking_mode":false,"fast_mode":false}}"#,
            b64(bytes)
        );
        let id = seed_output_line(&pool, &line).await;

        let report = migrate_legacy_attachments(&pool, tmp.path()).await.unwrap();
        assert_eq!(report.output_lines_migrated, 1);
        assert_eq!(report.blobs_created, 1);

        let (new_line,): (String,) = sqlx::query_as("SELECT line FROM output_lines WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&new_line).unwrap();
        let arr = v["attachments"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hash"].as_str().unwrap(), hash_bytes(bytes));
        assert_eq!(arr[0]["size"], bytes.len());
        // Other fields preserved.
        assert_eq!(v["text"], "hi");
        assert_eq!(v["type"], "verun_user_message");

        let info = get_blob_info(&pool, &hash_bytes(bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(info.ref_count, 1);
    }

    #[tokio::test]
    async fn migrate_is_idempotent_via_sentinel() {
        let (pool, tmp) = test_setup().await;
        let bytes = b"once";
        let legacy = format!(
            r#"[{{"name":"a","mimeType":"image/png","dataBase64":"{}"}}]"#,
            b64(bytes)
        );
        seed_step_with_legacy_attachments(&pool, "step-once", &legacy).await;

        let first = migrate_legacy_attachments(&pool, tmp.path()).await.unwrap();
        assert_eq!(first.steps_migrated, 1);
        assert_eq!(first.blobs_created, 1);
        assert!(!first.already_done);

        let info_after_first = get_blob_info(&pool, &hash_bytes(bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(info_after_first.ref_count, 1);

        // Second run: sentinel is set → no-op, no double-incr.
        let second = migrate_legacy_attachments(&pool, tmp.path()).await.unwrap();
        assert_eq!(second.steps_migrated, 0);
        assert_eq!(second.blobs_created, 0);
        assert!(second.already_done);

        let info_after_second = get_blob_info(&pool, &hash_bytes(bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            info_after_second.ref_count, 1,
            "sentinel must prevent re-incrementing"
        );
    }

    #[tokio::test]
    async fn migrate_skips_rows_without_legacy_base64() {
        let (pool, tmp) = test_setup().await;
        // Already-migrated row.
        seed_step_with_legacy_attachments(
            &pool,
            "step-modern",
            r#"[{"hash":"deadbeef","mimeType":"image/png","name":"a","size":3}]"#,
        )
        .await;
        let report = migrate_legacy_attachments(&pool, tmp.path()).await.unwrap();
        assert_eq!(report.steps_migrated, 0);
        assert_eq!(report.blobs_created, 0);
    }
}
