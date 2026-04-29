use crate::db;
use crate::github::{self, CiCheck, GitHubRepo, PrInfo, WorkflowJob, WorkflowRun};
use crate::stream::GitHubRemoteDebugEvent;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinError;

const OVERVIEW_STALE_MS: i64 = 15_000;
const OVERVIEW_EXPIRE_MS: i64 = 10 * 60_000;
const ACTIONS_STALE_MS: i64 = 30_000;
const ACTIONS_EXPIRE_MS: i64 = 10 * 60_000;
const JOBS_STALE_MS: i64 = 30_000;
const JOBS_EXPIRE_MS: i64 = 24 * 60 * 60_000;
const LOGS_STALE_MS: i64 = 24 * 60 * 60_000;
const LOGS_EXPIRE_MS: i64 = 7 * 24 * 60 * 60_000;

pub type InvalidateFn = Arc<dyn Fn(String, Vec<String>) + Send + Sync + 'static>;
pub type DebugFn = Arc<dyn Fn(GitHubRemoteDebugEvent) + Send + Sync + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteFetchMode {
    CacheFirst,
    StaleWhileRevalidate,
    NetworkOnly,
}

impl RemoteFetchMode {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("cache-first") {
            "network-only" => Self::NetworkOnly,
            "stale-while-revalidate" => Self::StaleWhileRevalidate,
            _ => Self::CacheFirst,
        }
    }

    fn allows_cache(self) -> bool {
        !matches!(self, Self::NetworkOnly)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubOverviewSnapshot {
    pub github: Option<GitHubRepo>,
    pub branch_url: Option<String>,
    pub pr: Option<PrInfo>,
    pub checks: Vec<CiCheck>,
    pub fetched_at: i64,
    pub stale_at: i64,
    pub expires_at: i64,
    pub is_stale: bool,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubActionsSnapshot {
    pub runs: Vec<WorkflowRun>,
    pub fetched_at: i64,
    pub stale_at: i64,
    pub expires_at: i64,
    pub is_stale: bool,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJobsSnapshot {
    pub run_id: u64,
    pub jobs: Vec<WorkflowJob>,
    pub fetched_at: i64,
    pub stale_at: i64,
    pub expires_at: i64,
    pub is_stale: bool,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLogSnapshot {
    pub job_id: u64,
    pub text: String,
    pub fetched_at: i64,
    pub stale_at: i64,
    pub expires_at: i64,
    pub is_stale: bool,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewPayload {
    github: Option<GitHubRepo>,
    branch_url: Option<String>,
    pr: Option<PrInfo>,
    checks: Vec<CiCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionsPayload {
    cached_limit: u32,
    runs: Vec<WorkflowRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobsPayload {
    run_id: u64,
    jobs: Vec<WorkflowJob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogPayload {
    job_id: u64,
    text: String,
}

enum CacheState<T> {
    Miss,
    Fresh(T, db::GitHubCacheEntry),
    Stale(T, db::GitHubCacheEntry),
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn make_cache_key(task_id: &str, scope: &str, entity_id: Option<&str>) -> String {
    match entity_id {
        Some(id) => format!("{task_id}:{scope}:{id}"),
        None => format!("{task_id}:{scope}"),
    }
}

fn flatten_join<T>(result: Result<Result<T, String>, JoinError>) -> Result<T, String> {
    result.map_err(|e| format!("Task join error: {e}"))?
}

fn mode_label(mode: RemoteFetchMode) -> String {
    match mode {
        RemoteFetchMode::CacheFirst => "cache-first",
        RemoteFetchMode::StaleWhileRevalidate => "stale-while-revalidate",
        RemoteFetchMode::NetworkOnly => "network-only",
    }
    .to_string()
}

#[allow(clippy::too_many_arguments)]
fn emit_debug(
    debug: Option<&DebugFn>,
    task_id: &str,
    scope: &str,
    stage: &str,
    mode: Option<RemoteFetchMode>,
    cache_state: Option<&str>,
    from_cache: Option<bool>,
    duration_ms: Option<u64>,
    detail: Option<String>,
) {
    let Some(debug) = debug else { return };
    debug(GitHubRemoteDebugEvent {
        task_id: task_id.to_string(),
        scope: scope.to_string(),
        stage: stage.to_string(),
        mode: mode.map(mode_label),
        cache_state: cache_state.map(|value| value.to_string()),
        from_cache,
        duration_ms,
        detail,
        emitted_at: now_ms(),
    });
}

fn singleflight_gates() -> &'static TokioMutex<HashMap<String, Arc<TokioMutex<()>>>> {
    static GATES: OnceLock<TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| TokioMutex::new(HashMap::new()))
}

async fn singleflight_gate(cache_key: &str) -> Arc<TokioMutex<()>> {
    let mut gates = singleflight_gates().lock().await;
    gates.entry(cache_key.to_string())
        .or_insert_with(|| Arc::new(TokioMutex::new(())))
        .clone()
}

async fn cleanup_singleflight_gate(cache_key: &str, gate: &Arc<TokioMutex<()>>) {
    let mut gates = singleflight_gates().lock().await;
    let should_remove = gates
        .get(cache_key)
        .map(|existing| Arc::ptr_eq(existing, gate) && Arc::strong_count(existing) == 2)
        .unwrap_or(false);
    if should_remove {
        gates.remove(cache_key);
    }
}

async fn with_singleflight<T, F, Fut>(cache_key: &str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let gate = singleflight_gate(cache_key).await;
    let guard = gate.lock().await;
    let result = work().await;
    drop(guard);
    cleanup_singleflight_gate(cache_key, &gate).await;
    result
}

fn schedule_revalidate<F, Fut>(
    pool: SqlitePool,
    task_id: String,
    cache_key: String,
    scope: &'static str,
    notifier: Option<InvalidateFn>,
    debug: Option<DebugFn>,
    work: F,
) where
    F: FnOnce(SqlitePool) -> Fut + Send + 'static,
    Fut: Future<Output = Result<bool, String>> + Send + 'static,
{
    tokio::spawn(async move {
        emit_debug(
            debug.as_ref(),
            &task_id,
            scope,
            "revalidate-start",
            Some(RemoteFetchMode::StaleWhileRevalidate),
            Some("stale"),
            Some(true),
            None,
            Some(cache_key.clone()),
        );
        match with_singleflight(&cache_key, move || work(pool)).await {
            Ok(true) => {
                emit_debug(
                    debug.as_ref(),
                    &task_id,
                    scope,
                    "revalidate-success",
                    Some(RemoteFetchMode::StaleWhileRevalidate),
                    Some("stale"),
                    Some(false),
                    None,
                    Some(cache_key.clone()),
                );
                if let Some(notify) = notifier {
                    notify(task_id, vec![scope.to_string()]);
                }
            }
            Ok(false) => {
                emit_debug(
                    debug.as_ref(),
                    &task_id,
                    scope,
                    "revalidate-skip",
                    Some(RemoteFetchMode::StaleWhileRevalidate),
                    Some("fresh"),
                    Some(true),
                    None,
                    Some(cache_key.clone()),
                );
            }
            Err(err) => {
                eprintln!("[verun][github-remote] revalidate {cache_key} failed: {err}");
                emit_debug(
                    debug.as_ref(),
                    &task_id,
                    scope,
                    "revalidate-error",
                    Some(RemoteFetchMode::StaleWhileRevalidate),
                    Some("stale"),
                    Some(true),
                    None,
                    Some(err),
                );
            }
        }
    });
}

async fn cached_payload<T: for<'de> Deserialize<'de>>(
    pool: &SqlitePool,
    cache_key: &str,
    mode: RemoteFetchMode,
) -> Result<CacheState<T>, String> {
    if !mode.allows_cache() {
        return Ok(CacheState::Miss);
    }
    let Some(entry) = db::get_github_cache_entry(pool, cache_key).await? else {
        return Ok(CacheState::Miss);
    };
    let now = now_ms();
    if now >= entry.expires_at {
        return Ok(CacheState::Miss);
    }
    let payload = serde_json::from_str::<T>(&entry.payload_json)
        .map_err(|e| format!("parse cached github payload: {e}"))?;
    if now >= entry.stale_at {
        Ok(CacheState::Stale(payload, entry))
    } else {
        Ok(CacheState::Fresh(payload, entry))
    }
}

async fn write_payload<T: Serialize>(
    pool: &SqlitePool,
    task_id: &str,
    scope: &str,
    entity_id: Option<String>,
    stale_ms: i64,
    expire_ms: i64,
    payload: &T,
) -> Result<db::GitHubCacheEntry, String> {
    let fetched_at = now_ms();
    let entry = db::GitHubCacheEntry {
        cache_key: make_cache_key(task_id, scope, entity_id.as_deref()),
        task_id: task_id.to_string(),
        scope: scope.to_string(),
        entity_id,
        payload_json: serde_json::to_string(payload)
            .map_err(|e| format!("serialize github payload: {e}"))?,
        fetched_at,
        stale_at: fetched_at + stale_ms,
        expires_at: fetched_at + expire_ms,
    };
    db::upsert_github_cache_entry(pool, &entry).await?;
    Ok(entry)
}

fn overview_snapshot(
    payload: OverviewPayload,
    entry: &db::GitHubCacheEntry,
    from_cache: bool,
) -> GitHubOverviewSnapshot {
    GitHubOverviewSnapshot {
        github: payload.github,
        branch_url: payload.branch_url,
        pr: payload.pr,
        checks: payload.checks,
        fetched_at: entry.fetched_at,
        stale_at: entry.stale_at,
        expires_at: entry.expires_at,
        is_stale: now_ms() >= entry.stale_at,
        from_cache,
    }
}

fn actions_snapshot(
    payload: ActionsPayload,
    entry: &db::GitHubCacheEntry,
    limit: u32,
    from_cache: bool,
) -> GitHubActionsSnapshot {
    GitHubActionsSnapshot {
        runs: payload.runs.into_iter().take(limit as usize).collect(),
        fetched_at: entry.fetched_at,
        stale_at: entry.stale_at,
        expires_at: entry.expires_at,
        is_stale: now_ms() >= entry.stale_at,
        from_cache,
    }
}

fn jobs_snapshot(
    payload: JobsPayload,
    entry: &db::GitHubCacheEntry,
    from_cache: bool,
) -> WorkflowJobsSnapshot {
    WorkflowJobsSnapshot {
        run_id: payload.run_id,
        jobs: payload.jobs,
        fetched_at: entry.fetched_at,
        stale_at: entry.stale_at,
        expires_at: entry.expires_at,
        is_stale: now_ms() >= entry.stale_at,
        from_cache,
    }
}

fn log_snapshot(
    payload: LogPayload,
    entry: &db::GitHubCacheEntry,
    max_bytes: usize,
    from_cache: bool,
) -> WorkflowLogSnapshot {
    let text = if max_bytes == 0 {
        payload.text
    } else {
        github::tail_bytes(&payload.text, max_bytes)
    };
    WorkflowLogSnapshot {
        job_id: payload.job_id,
        text,
        fetched_at: entry.fetched_at,
        stale_at: entry.stale_at,
        expires_at: entry.expires_at,
        is_stale: now_ms() >= entry.stale_at,
        from_cache,
    }
}

fn fetch_overview_blocking(worktree_path: String) -> Result<OverviewPayload, String> {
    let github = github::detect_github_repo(&worktree_path)?;
    let (pr, checks, branch_url) = if github.is_some() {
        let pr = github::get_pr_for_branch(&worktree_path)?;
        let checks = if pr.is_some() {
            github::get_ci_checks(&worktree_path)?
        } else {
            Vec::new()
        };
        let branch_url = github::get_branch_url(&worktree_path)?;
        (pr, checks, branch_url)
    } else {
        (None, Vec::new(), None)
    };

    Ok(OverviewPayload {
        github,
        branch_url,
        pr,
        checks,
    })
}

async fn fetch_overview_and_store(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
) -> Result<GitHubOverviewSnapshot, String> {
    let worktree_path = worktree_path.to_string();
    let payload = flatten_join(
        tokio::task::spawn_blocking(move || fetch_overview_blocking(worktree_path)).await,
    )?;
    let entry = write_payload(
        pool,
        task_id,
        "overview",
        None,
        OVERVIEW_STALE_MS,
        OVERVIEW_EXPIRE_MS,
        &payload,
    )
    .await?;
    Ok(overview_snapshot(payload, &entry, false))
}

async fn fetch_actions_and_store(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    limit: u32,
    existing_limit: Option<u32>,
) -> Result<GitHubActionsSnapshot, String> {
    let requested_limit = limit.max(existing_limit.unwrap_or(0));
    let worktree_path = worktree_path.to_string();
    let runs = flatten_join(
        tokio::task::spawn_blocking(move || {
            github::list_workflow_runs_for_branch(&worktree_path, requested_limit)
        })
        .await,
    )?;
    let payload = ActionsPayload {
        cached_limit: requested_limit,
        runs,
    };
    let entry = write_payload(
        pool,
        task_id,
        "actions",
        None,
        ACTIONS_STALE_MS,
        ACTIONS_EXPIRE_MS,
        &payload,
    )
    .await?;
    Ok(actions_snapshot(payload, &entry, limit, false))
}

async fn fetch_jobs_and_store(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    run_id: u64,
) -> Result<WorkflowJobsSnapshot, String> {
    let worktree_path = worktree_path.to_string();
    let jobs = flatten_join(
        tokio::task::spawn_blocking(move || github::list_jobs_for_run(&worktree_path, run_id))
            .await,
    )?;
    let payload = JobsPayload { run_id, jobs };
    let entry = write_payload(
        pool,
        task_id,
        "jobs",
        Some(run_id.to_string()),
        JOBS_STALE_MS,
        JOBS_EXPIRE_MS,
        &payload,
    )
    .await?;
    Ok(jobs_snapshot(payload, &entry, false))
}

async fn fetch_log_and_store(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    job_id: u64,
    max_bytes: usize,
) -> Result<WorkflowLogSnapshot, String> {
    let worktree_path = worktree_path.to_string();
    let full_text = flatten_join(
        tokio::task::spawn_blocking(move || github::get_failed_step_logs(&worktree_path, job_id, 0))
            .await,
    )?;
    let payload = LogPayload {
        job_id,
        text: full_text,
    };
    let entry = write_payload(
        pool,
        task_id,
        "logs",
        Some(job_id.to_string()),
        LOGS_STALE_MS,
        LOGS_EXPIRE_MS,
        &payload,
    )
    .await?;
    Ok(log_snapshot(payload, &entry, max_bytes, false))
}

pub async fn get_overview(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    mode: RemoteFetchMode,
    on_invalidate: Option<InvalidateFn>,
    on_debug: Option<DebugFn>,
) -> Result<GitHubOverviewSnapshot, String> {
    let cache_key = make_cache_key(task_id, "overview", None);
    match cached_payload::<OverviewPayload>(pool, &cache_key, mode).await? {
        CacheState::Fresh(payload, entry) => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "overview",
                "cache-hit",
                Some(mode),
                Some("fresh"),
                Some(true),
                None,
                Some(cache_key.clone()),
            );
            return Ok(overview_snapshot(payload, &entry, true));
        }
        CacheState::Stale(payload, entry) if mode == RemoteFetchMode::CacheFirst => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "overview",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(cache_key.clone()),
            );
            return Ok(overview_snapshot(payload, &entry, true));
        }
        CacheState::Stale(payload, entry) if mode == RemoteFetchMode::StaleWhileRevalidate => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "overview",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(cache_key.clone()),
            );
            let pool = pool.clone();
            let fetch_task_id = task_id.to_string();
            let notify_task_id = task_id.to_string();
            let worktree_path = worktree_path.to_string();
            let refresh_key = cache_key.clone();
            let notifier = on_invalidate.clone();
            let debug = on_debug.clone();
            schedule_revalidate(
                pool,
                notify_task_id,
                refresh_key.clone(),
                "overview",
                notifier,
                debug,
                move |pool| async move {
                    match cached_payload::<OverviewPayload>(
                        &pool,
                        &refresh_key,
                        RemoteFetchMode::CacheFirst,
                    )
                    .await?
                    {
                        CacheState::Fresh(_, _) => Ok(false),
                        CacheState::Miss | CacheState::Stale(_, _) => {
                            fetch_overview_and_store(&pool, &fetch_task_id, &worktree_path).await?;
                            Ok(true)
                        }
                    }
                },
            );
            return Ok(overview_snapshot(payload, &entry, true));
        }
        CacheState::Miss => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "overview",
                "cache-miss",
                Some(mode),
                Some("miss"),
                Some(false),
                None,
                Some(cache_key.clone()),
            );
        }
        _ => {}
    }

    with_singleflight(&cache_key, || async {
        if mode != RemoteFetchMode::NetworkOnly {
            if let CacheState::Fresh(payload, entry) =
                cached_payload::<OverviewPayload>(pool, &cache_key, RemoteFetchMode::CacheFirst)
                    .await?
            {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "overview",
                    "cache-hit",
                    Some(mode),
                    Some("fresh"),
                    Some(true),
                    None,
                    Some(cache_key.clone()),
                );
                return Ok(overview_snapshot(payload, &entry, true));
            }
        }
        emit_debug(
            on_debug.as_ref(),
            task_id,
            "overview",
            "fetch-start",
            Some(mode),
            None,
            Some(false),
            None,
            Some(cache_key.clone()),
        );
        let started = Instant::now();
        match fetch_overview_and_store(pool, task_id, worktree_path).await {
            Ok(snapshot) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "overview",
                    "fetch-success",
                    Some(mode),
                    Some("miss"),
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(cache_key.clone()),
                );
                Ok(snapshot)
            }
            Err(err) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "overview",
                    "fetch-error",
                    Some(mode),
                    None,
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(err.clone()),
                );
                Err(err)
            }
        }
    })
    .await
}

pub async fn get_actions(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    limit: u32,
    mode: RemoteFetchMode,
    on_invalidate: Option<InvalidateFn>,
    on_debug: Option<DebugFn>,
) -> Result<GitHubActionsSnapshot, String> {
    let cache_key = make_cache_key(task_id, "actions", None);
    match cached_payload::<ActionsPayload>(pool, &cache_key, mode).await? {
        CacheState::Fresh(payload, entry) if payload.cached_limit >= limit => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "actions",
                "cache-hit",
                Some(mode),
                Some("fresh"),
                Some(true),
                None,
                Some(format!("{cache_key} limit={limit}")),
            );
            return Ok(actions_snapshot(payload, &entry, limit, true));
        }
        CacheState::Stale(payload, entry)
            if payload.cached_limit >= limit && mode == RemoteFetchMode::CacheFirst =>
        {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "actions",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(format!("{cache_key} limit={limit}")),
            );
            return Ok(actions_snapshot(payload, &entry, limit, true));
        }
        CacheState::Stale(payload, entry)
            if payload.cached_limit >= limit
                && mode == RemoteFetchMode::StaleWhileRevalidate =>
        {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "actions",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(format!("{cache_key} limit={limit}")),
            );
            let pool = pool.clone();
            let fetch_task_id = task_id.to_string();
            let notify_task_id = task_id.to_string();
            let worktree_path = worktree_path.to_string();
            let refresh_key = cache_key.clone();
            let notifier = on_invalidate.clone();
            let debug = on_debug.clone();
            let keep_limit = payload.cached_limit.max(limit);
            schedule_revalidate(
                pool,
                notify_task_id,
                refresh_key.clone(),
                "actions",
                notifier,
                debug,
                move |pool| async move {
                    match cached_payload::<ActionsPayload>(
                        &pool,
                        &refresh_key,
                        RemoteFetchMode::CacheFirst,
                    )
                    .await?
                    {
                        CacheState::Fresh(existing, _) if existing.cached_limit >= keep_limit => {
                            Ok(false)
                        }
                        CacheState::Miss | CacheState::Fresh(_, _) | CacheState::Stale(_, _) => {
                            // Re-fetch enough rows to preserve the largest cached window we have seen.
                            fetch_actions_and_store(
                                &pool,
                                &fetch_task_id,
                                &worktree_path,
                                keep_limit,
                                None,
                            )
                            .await?;
                            Ok(true)
                        }
                    }
                },
            );
            return Ok(actions_snapshot(payload, &entry, limit, true));
        }
        CacheState::Miss => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "actions",
                "cache-miss",
                Some(mode),
                Some("miss"),
                Some(false),
                None,
                Some(format!("{cache_key} limit={limit}")),
            );
        }
        _ => {}
    }

    with_singleflight(&cache_key, || async {
        let existing_limit = if mode != RemoteFetchMode::NetworkOnly {
            match cached_payload::<ActionsPayload>(pool, &cache_key, RemoteFetchMode::CacheFirst)
                .await?
            {
                CacheState::Fresh(payload, entry) if payload.cached_limit >= limit => {
                    emit_debug(
                        on_debug.as_ref(),
                        task_id,
                        "actions",
                        "cache-hit",
                        Some(mode),
                        Some("fresh"),
                        Some(true),
                        None,
                        Some(format!("{cache_key} limit={limit}")),
                    );
                    return Ok(actions_snapshot(payload, &entry, limit, true));
                }
                CacheState::Fresh(payload, _) | CacheState::Stale(payload, _) => {
                    Some(payload.cached_limit)
                }
                CacheState::Miss => None,
            }
        } else {
            None
        };
        emit_debug(
            on_debug.as_ref(),
            task_id,
            "actions",
            "fetch-start",
            Some(mode),
            None,
            Some(false),
            None,
            Some(format!("{cache_key} limit={limit}")),
        );
        let started = Instant::now();
        match fetch_actions_and_store(pool, task_id, worktree_path, limit, existing_limit).await {
            Ok(snapshot) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "actions",
                    "fetch-success",
                    Some(mode),
                    Some("miss"),
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(format!("{cache_key} limit={limit}")),
                );
                Ok(snapshot)
            }
            Err(err) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "actions",
                    "fetch-error",
                    Some(mode),
                    None,
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(err.clone()),
                );
                Err(err)
            }
        }
    })
    .await
}

pub async fn get_workflow_jobs(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    run_id: u64,
    mode: RemoteFetchMode,
    on_invalidate: Option<InvalidateFn>,
    on_debug: Option<DebugFn>,
) -> Result<WorkflowJobsSnapshot, String> {
    let run_key = run_id.to_string();
    let cache_key = make_cache_key(task_id, "jobs", Some(&run_key));
    match cached_payload::<JobsPayload>(pool, &cache_key, mode).await? {
        CacheState::Fresh(payload, entry) => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "jobs",
                "cache-hit",
                Some(mode),
                Some("fresh"),
                Some(true),
                None,
                Some(format!("{cache_key} runId={run_id}")),
            );
            return Ok(jobs_snapshot(payload, &entry, true));
        }
        CacheState::Stale(payload, entry) if mode == RemoteFetchMode::CacheFirst => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "jobs",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(format!("{cache_key} runId={run_id}")),
            );
            return Ok(jobs_snapshot(payload, &entry, true));
        }
        CacheState::Stale(payload, entry) if mode == RemoteFetchMode::StaleWhileRevalidate => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "jobs",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(format!("{cache_key} runId={run_id}")),
            );
            let pool = pool.clone();
            let fetch_task_id = task_id.to_string();
            let notify_task_id = task_id.to_string();
            let worktree_path = worktree_path.to_string();
            let refresh_key = cache_key.clone();
            let notifier = on_invalidate.clone();
            let debug = on_debug.clone();
            schedule_revalidate(
                pool,
                notify_task_id,
                refresh_key.clone(),
                "jobs",
                notifier,
                debug,
                move |pool| async move {
                    match cached_payload::<JobsPayload>(
                        &pool,
                        &refresh_key,
                        RemoteFetchMode::CacheFirst,
                    )
                    .await?
                    {
                        CacheState::Fresh(_, _) => Ok(false),
                        CacheState::Miss | CacheState::Stale(_, _) => {
                            fetch_jobs_and_store(&pool, &fetch_task_id, &worktree_path, run_id)
                                .await?;
                            Ok(true)
                        }
                    }
                },
            );
            return Ok(jobs_snapshot(payload, &entry, true));
        }
        CacheState::Miss => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "jobs",
                "cache-miss",
                Some(mode),
                Some("miss"),
                Some(false),
                None,
                Some(format!("{cache_key} runId={run_id}")),
            );
        }
        _ => {}
    }

    with_singleflight(&cache_key, || async {
        if mode != RemoteFetchMode::NetworkOnly {
            if let CacheState::Fresh(payload, entry) =
                cached_payload::<JobsPayload>(pool, &cache_key, RemoteFetchMode::CacheFirst).await?
            {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "jobs",
                    "cache-hit",
                    Some(mode),
                    Some("fresh"),
                    Some(true),
                    None,
                    Some(format!("{cache_key} runId={run_id}")),
                );
                return Ok(jobs_snapshot(payload, &entry, true));
            }
        }
        emit_debug(
            on_debug.as_ref(),
            task_id,
            "jobs",
            "fetch-start",
            Some(mode),
            None,
            Some(false),
            None,
            Some(format!("{cache_key} runId={run_id}")),
        );
        let started = Instant::now();
        match fetch_jobs_and_store(pool, task_id, worktree_path, run_id).await {
            Ok(snapshot) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "jobs",
                    "fetch-success",
                    Some(mode),
                    Some("miss"),
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(format!("{cache_key} runId={run_id}")),
                );
                Ok(snapshot)
            }
            Err(err) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "jobs",
                    "fetch-error",
                    Some(mode),
                    None,
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(err.clone()),
                );
                Err(err)
            }
        }
    })
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn get_workflow_log(
    pool: &SqlitePool,
    task_id: &str,
    worktree_path: &str,
    job_id: u64,
    max_bytes: usize,
    mode: RemoteFetchMode,
    on_invalidate: Option<InvalidateFn>,
    on_debug: Option<DebugFn>,
) -> Result<WorkflowLogSnapshot, String> {
    let job_key = job_id.to_string();
    let cache_key = make_cache_key(task_id, "logs", Some(&job_key));
    match cached_payload::<LogPayload>(pool, &cache_key, mode).await? {
        CacheState::Fresh(payload, entry) => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "logs",
                "cache-hit",
                Some(mode),
                Some("fresh"),
                Some(true),
                None,
                Some(format!("{cache_key} jobId={job_id}")),
            );
            return Ok(log_snapshot(payload, &entry, max_bytes, true));
        }
        CacheState::Stale(payload, entry) if mode == RemoteFetchMode::CacheFirst => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "logs",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(format!("{cache_key} jobId={job_id}")),
            );
            return Ok(log_snapshot(payload, &entry, max_bytes, true));
        }
        CacheState::Stale(payload, entry) if mode == RemoteFetchMode::StaleWhileRevalidate => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "logs",
                "cache-hit",
                Some(mode),
                Some("stale"),
                Some(true),
                None,
                Some(format!("{cache_key} jobId={job_id}")),
            );
            let pool = pool.clone();
            let fetch_task_id = task_id.to_string();
            let notify_task_id = task_id.to_string();
            let worktree_path = worktree_path.to_string();
            let refresh_key = cache_key.clone();
            let notifier = on_invalidate.clone();
            let debug = on_debug.clone();
            schedule_revalidate(
                pool,
                notify_task_id,
                refresh_key.clone(),
                "logs",
                notifier,
                debug,
                move |pool| async move {
                    match cached_payload::<LogPayload>(
                        &pool,
                        &refresh_key,
                        RemoteFetchMode::CacheFirst,
                    )
                    .await?
                    {
                        CacheState::Fresh(_, _) => Ok(false),
                        CacheState::Miss | CacheState::Stale(_, _) => {
                            fetch_log_and_store(&pool, &fetch_task_id, &worktree_path, job_id, 0)
                                .await?;
                            Ok(true)
                        }
                    }
                },
            );
            return Ok(log_snapshot(payload, &entry, max_bytes, true));
        }
        CacheState::Miss => {
            emit_debug(
                on_debug.as_ref(),
                task_id,
                "logs",
                "cache-miss",
                Some(mode),
                Some("miss"),
                Some(false),
                None,
                Some(format!("{cache_key} jobId={job_id}")),
            );
        }
        _ => {}
    }

    with_singleflight(&cache_key, || async {
        if mode != RemoteFetchMode::NetworkOnly {
            if let CacheState::Fresh(payload, entry) =
                cached_payload::<LogPayload>(pool, &cache_key, RemoteFetchMode::CacheFirst).await?
            {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "logs",
                    "cache-hit",
                    Some(mode),
                    Some("fresh"),
                    Some(true),
                    None,
                    Some(format!("{cache_key} jobId={job_id}")),
                );
                return Ok(log_snapshot(payload, &entry, max_bytes, true));
            }
        }
        emit_debug(
            on_debug.as_ref(),
            task_id,
            "logs",
            "fetch-start",
            Some(mode),
            None,
            Some(false),
            None,
            Some(format!("{cache_key} jobId={job_id}")),
        );
        let started = Instant::now();
        match fetch_log_and_store(pool, task_id, worktree_path, job_id, max_bytes).await {
            Ok(snapshot) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "logs",
                    "fetch-success",
                    Some(mode),
                    Some("miss"),
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(format!("{cache_key} jobId={job_id}")),
                );
                Ok(snapshot)
            }
            Err(err) => {
                emit_debug(
                    on_debug.as_ref(),
                    task_id,
                    "logs",
                    "fetch-error",
                    Some(mode),
                    None,
                    Some(false),
                    Some(started.elapsed().as_millis() as u64),
                    Some(err.clone()),
                );
                Err(err)
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use sqlx::sqlite::SqlitePool;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tokio::time::{sleep, timeout, Duration};

    fn test_env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    struct PathGuard {
        original: Option<String>,
    }

    impl PathGuard {
        fn install(bin_dir: &Path) -> Self {
            let original = std::env::var("PATH").ok();
            let mut parts = vec![bin_dir.display().to_string()];
            if let Some(path) = &original {
                parts.push(path.clone());
            }
            let joined = parts.join(":");
            unsafe { std::env::set_var("PATH", joined) };
            Self { original }
        }
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(path) => unsafe { std::env::set_var("PATH", path) },
                None => unsafe { std::env::remove_var("PATH") },
            }
        }
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for m in db::migrations() {
            sqlx::query(m.sql).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn seed_task(pool: &SqlitePool, task_id: &str, repo: &Path) {
        sqlx::query(
            "INSERT INTO projects (id, name, repo_path, base_branch, setup_hook, destroy_hook, start_command, auto_start, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("p-test")
        .bind("Test Project")
        .bind(repo.display().to_string())
        .bind("main")
        .bind("")
        .bind("")
        .bind("")
        .bind(false)
        .bind(1_i64)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO tasks (id, project_id, name, worktree_path, branch, created_at, port_offset, parent_task_id, agent_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(task_id)
        .bind("p-test")
        .bind(Option::<String>::None)
        .bind(repo.display().to_string())
        .bind("feat/test")
        .bind(2_i64)
        .bind(0_i64)
        .bind(Option::<String>::None)
        .bind("claude")
        .execute(pool)
        .await
        .unwrap();
    }

    fn setup_git_repo() -> (TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let status = Command::new("git")
            .args(["init", "-b", "feat/test"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(status.success());
        let status = Command::new("git")
            .args(["config", "user.email", "tests@example.com"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(status.success());
        let status = Command::new("git")
            .args(["config", "user.name", "Verun Tests"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::write(repo.join("README.md"), "test\n").unwrap();
        let status = Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(status.success());
        let status = Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(status.success());
        (temp, repo)
    }

    fn write_fake_gh(bin_dir: &Path, output_file: &Path, count_file: &Path, sleep_ms: u64) {
        let script = format!(
            "#!/bin/sh\ncount=$(cat \"{count}\" 2>/dev/null || echo 0)\necho $((count + 1)) > \"{count}\"\nif [ \"{sleep_ms}\" -gt 0 ]; then\n  sleep \"0.$(printf '%03d' {sleep_ms})\"\nfi\ncat \"{output}\"\n",
            count = count_file.display(),
            output = output_file.display(),
            sleep_ms = sleep_ms,
        );
        let path = bin_dir.join("gh");
        std::fs::write(&path, script).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
    }

    fn actions_json(ids: &[u64]) -> String {
        let runs = ids
            .iter()
            .map(|id| {
                format!(
                    "{{\"databaseId\":{id},\"number\":{id},\"workflowName\":\"CI\",\"status\":\"completed\",\"conclusion\":\"success\",\"url\":\"https://example.com/{id}\",\"createdAt\":\"2026-04-20T10:00:00Z\",\"headSha\":\"abc{id}\",\"headBranch\":\"feat/test\",\"event\":\"push\"}}"
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!("[{runs}]")
    }

    fn read_count(path: &Path) -> usize {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    }

    async fn gate_count() -> usize {
        singleflight_gates().lock().await.len()
    }

    #[tokio::test]
    async fn smaller_actions_limit_reuses_larger_cached_result() {
        let _lock = test_env_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        let pool = test_pool().await;
        let (_temp, repo) = setup_git_repo();
        let bin_dir = repo.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        seed_task(&pool, "task-1", &repo).await;
        let output_file = repo.join("runs.json");
        let count_file = repo.join("gh-count.txt");
        std::fs::write(&output_file, actions_json(&[1, 2, 3])).unwrap();
        write_fake_gh(&bin_dir, &output_file, &count_file, 0);
        let _path_guard = PathGuard::install(&bin_dir);

        let first = get_actions(
            &pool,
            "task-1",
            repo.to_str().unwrap(),
            3,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(first.runs.len(), 3);
        assert_eq!(read_count(&count_file), 1);

        let second = get_actions(
            &pool,
            "task-1",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(second.runs.len(), 1);
        assert!(second.from_cache);
        assert_eq!(read_count(&count_file), 1);
        assert_eq!(gate_count().await, 0);
    }

    #[tokio::test]
    async fn stale_while_revalidate_refreshes_actions_and_notifies() {
        let _lock = test_env_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        let pool = test_pool().await;
        let (_temp, repo) = setup_git_repo();
        let bin_dir = repo.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        seed_task(&pool, "task-2", &repo).await;
        let output_file = repo.join("runs.json");
        let count_file = repo.join("gh-count.txt");
        std::fs::write(&output_file, actions_json(&[1])).unwrap();
        write_fake_gh(&bin_dir, &output_file, &count_file, 0);
        let _path_guard = PathGuard::install(&bin_dir);

        let first = get_actions(
            &pool,
            "task-2",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(first.runs[0].database_id, 1);

        let mut entry = db::get_github_cache_entry(&pool, "task-2:actions")
            .await
            .unwrap()
            .unwrap();
        entry.stale_at = now_ms() - 1;
        entry.expires_at = now_ms() + 60_000;
        db::upsert_github_cache_entry(&pool, &entry).await.unwrap();
        std::fs::write(&output_file, actions_json(&[2])).unwrap();

        let notifications = Arc::new(AtomicUsize::new(0));
        let notify_count = notifications.clone();
        let notify: InvalidateFn = Arc::new(move |_task_id, scopes| {
            if scopes.iter().any(|scope| scope == "actions") {
                notify_count.fetch_add(1, Ordering::SeqCst);
            }
        });

        let stale = get_actions(
            &pool,
            "task-2",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::StaleWhileRevalidate,
            Some(notify),
            None,
        )
        .await
        .unwrap();
        assert!(stale.from_cache);
        assert!(stale.is_stale);
        assert_eq!(stale.runs[0].database_id, 1);

        timeout(Duration::from_secs(2), async {
            loop {
                if notifications.load(Ordering::SeqCst) > 0 {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();

        let refreshed = get_actions(
            &pool,
            "task-2",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(refreshed.runs[0].database_id, 2);
        assert!(!refreshed.is_stale);
        assert_eq!(read_count(&count_file), 2);
        assert_eq!(gate_count().await, 0);
    }

    #[tokio::test]
    async fn concurrent_actions_fetches_singleflight_on_cold_cache() {
        let _lock = test_env_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        let pool = test_pool().await;
        let (_temp, repo) = setup_git_repo();
        let bin_dir = repo.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        seed_task(&pool, "task-3", &repo).await;
        let output_file = repo.join("runs.json");
        let count_file = repo.join("gh-count.txt");
        std::fs::write(&output_file, actions_json(&[7, 8])).unwrap();
        write_fake_gh(&bin_dir, &output_file, &count_file, 200);
        let _path_guard = PathGuard::install(&bin_dir);

        let first = get_actions(
            &pool,
            "task-3",
            repo.to_str().unwrap(),
            2,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        );
        let second = get_actions(
            &pool,
            "task-3",
            repo.to_str().unwrap(),
            2,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap().runs.len(), 2);
        assert_eq!(second.unwrap().runs.len(), 2);
        assert_eq!(read_count(&count_file), 1);
        assert_eq!(gate_count().await, 0);
    }

    #[tokio::test]
    async fn network_only_bypasses_fresh_actions_cache() {
        let _lock = test_env_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        let pool = test_pool().await;
        let (_temp, repo) = setup_git_repo();
        let bin_dir = repo.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        seed_task(&pool, "task-4", &repo).await;
        let output_file = repo.join("runs.json");
        let count_file = repo.join("gh-count.txt");
        std::fs::write(&output_file, actions_json(&[11])).unwrap();
        write_fake_gh(&bin_dir, &output_file, &count_file, 0);
        let _path_guard = PathGuard::install(&bin_dir);

        get_actions(
            &pool,
            "task-4",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();
        std::fs::write(&output_file, actions_json(&[12])).unwrap();

        let refreshed = get_actions(
            &pool,
            "task-4",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::NetworkOnly,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(refreshed.runs[0].database_id, 12);
        assert_eq!(read_count(&count_file), 2);
        assert_eq!(gate_count().await, 0);
    }

    #[tokio::test]
    async fn expired_actions_cache_falls_back_to_miss() {
        let _lock = test_env_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        let pool = test_pool().await;
        let (_temp, repo) = setup_git_repo();
        let bin_dir = repo.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        seed_task(&pool, "task-5", &repo).await;
        let output_file = repo.join("runs.json");
        let count_file = repo.join("gh-count.txt");
        std::fs::write(&output_file, actions_json(&[21])).unwrap();
        write_fake_gh(&bin_dir, &output_file, &count_file, 0);
        let _path_guard = PathGuard::install(&bin_dir);

        get_actions(
            &pool,
            "task-5",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();

        let mut entry = db::get_github_cache_entry(&pool, "task-5:actions")
            .await
            .unwrap()
            .unwrap();
        entry.stale_at = now_ms() - 10_000;
        entry.expires_at = now_ms() - 1;
        db::upsert_github_cache_entry(&pool, &entry).await.unwrap();
        std::fs::write(&output_file, actions_json(&[22])).unwrap();

        let refreshed = get_actions(
            &pool,
            "task-5",
            repo.to_str().unwrap(),
            1,
            RemoteFetchMode::CacheFirst,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(refreshed.runs[0].database_id, 22);
        assert_eq!(read_count(&count_file), 2);
        assert_eq!(gate_count().await, 0);
    }
}
