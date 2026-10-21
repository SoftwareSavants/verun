//! Account decisions that need the database.

use sqlx::SqlitePool;

use super::{resolve_session_account, AccountError, AccountSelection};
use crate::db;

/// A failed query. `AccountError` has no database kind, and starting the
/// session on Default instead would be the silent fallback accounts forbid.
fn database_error(message: String) -> AccountError {
    AccountError::Invalid { message }
}

/// The account a new session of `agent_type` in `project_id` runs on: what the
/// user picked, else the project's account for the harness, else Default
/// (`None`). A picked account must exist, belong to the harness and not be
/// removed. The project's own binding needs no check: an account cannot be
/// removed while a project uses it.
pub async fn resolve_new_session_account(
    pool: &SqlitePool,
    project_id: &str,
    agent_type: &str,
    selection: Option<&AccountSelection>,
) -> Result<Option<String>, AccountError> {
    let project_accounts = db::project_account_ids(pool, project_id)
        .await
        .map_err(database_error)?;
    if let Some(AccountSelection::Account { id }) = selection {
        let account = db::get_account(pool, id)
            .await
            .map_err(database_error)?
            .ok_or_else(|| AccountError::Missing {
                account_id: id.clone(),
            })?;
        if account.agent_type != agent_type {
            return Err(AccountError::WrongHarness {
                account_id: id.clone(),
            });
        }
        if account.removed_at.is_some() {
            return Err(AccountError::Removed {
                account_id: id.clone(),
                label: account.label,
            });
        }
    }
    Ok(resolve_session_account(
        selection,
        agent_type,
        &project_accounts,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::{
        make_account, mark_account_removed_confirmed, set_project_account_confirmed, test_pool,
        upsert_account_confirmed,
    };

    fn pick(id: &str) -> AccountSelection {
        AccountSelection::Account { id: id.into() }
    }

    /// Claude accounts a1 and a2, Codex account c1, and a1-gone: a removed Claude account.
    async fn pool_with_accounts() -> SqlitePool {
        let pool = test_pool().await;
        for (id, agent_type) in [("a1", "claude"), ("a2", "claude"), ("c1", "codex")] {
            let mut account = make_account(id, 1000);
            account.agent_type = agent_type.into();
            upsert_account_confirmed(&pool, account).await.unwrap();
        }
        upsert_account_confirmed(&pool, make_account("a1-gone", 1000))
            .await
            .unwrap();
        mark_account_removed_confirmed(&pool, "a1-gone", 1700)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn resolve_new_session_account_validates_explicit_id() {
        let pool = pool_with_accounts().await;

        // A Codex account cannot back a Claude session.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("c1"))).await,
            Err(AccountError::WrongHarness {
                account_id: "c1".into()
            })
        );
        // A removed account may not start anything, and the error names it.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("a1-gone"))).await,
            Err(AccountError::Removed {
                account_id: "a1-gone".into(),
                label: "Account a1-gone".into()
            })
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("nope"))).await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn resolve_new_session_account_accepts_a_live_account_of_the_harness() {
        let pool = pool_with_accounts().await;

        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("a2"))).await,
            Ok(Some("a2".to_string()))
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "codex", Some(&pick("c1"))).await,
            Ok(Some("c1".to_string()))
        );
    }

    #[tokio::test]
    async fn resolve_new_session_account_falls_back_to_the_project_binding() {
        let pool = pool_with_accounts().await;
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        // No choice and ProjectDefault both mean the project's account.
        for selection in [None, Some(AccountSelection::ProjectDefault)] {
            assert_eq!(
                resolve_new_session_account(&pool, "p-001", "claude", selection.as_ref()).await,
                Ok(Some("a1".to_string())),
                "selection: {selection:?}"
            );
        }
        // Default skips the binding, and a pick beats it.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&AccountSelection::Default))
                .await,
            Ok(None)
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("a2"))).await,
            Ok(Some("a2".to_string()))
        );
        // The binding belongs to one project and one harness.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "codex", None).await,
            Ok(None)
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-002", "claude", None).await,
            Ok(None)
        );
    }

    #[tokio::test]
    async fn resolve_new_session_account_fails_instead_of_defaulting_when_the_database_fails() {
        // No migrations ran, so every query fails. A session must not quietly
        // start on Default because the project's binding could not be read.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        for selection in [None, Some(pick("a1"))] {
            let result =
                resolve_new_session_account(&pool, "p-001", "claude", selection.as_ref()).await;
            assert!(
                matches!(result, Err(AccountError::Invalid { .. })),
                "selection: {selection:?}, result: {result:?}"
            );
        }
    }
}
