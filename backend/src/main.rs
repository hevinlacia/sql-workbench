use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};
use sqlx::{
    Column, MySqlPool, Row, TypeInfo,
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow},
};
use tokio::{process::Command, sync::RwLock};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    saved_connections: Arc<RwLock<HashMap<Uuid, SavedConnection>>>,
    pools: Arc<RwLock<HashMap<Uuid, ConnectionEntry>>>,
    archery_tables_cache: Arc<RwLock<HashMap<String, CachedEntry<Vec<TableInfo>>>>>,
    archery_table_structure_cache: Arc<RwLock<HashMap<String, CachedEntry<Vec<TableColumn>>>>>,
    config_path: Arc<PathBuf>,
}

#[derive(Clone)]
struct ConnectionEntry {
    server_version: String,
    pool: MySqlPool,
}

#[derive(Clone)]
struct CachedEntry<T> {
    cached_at: Instant,
    value: T,
}

impl<T: Clone> CachedEntry<T> {
    fn fresh_value(&self, ttl: Duration) -> Option<T> {
        (self.cached_at.elapsed() < ttl).then(|| self.value.clone())
    }
}

const DEFAULT_ARCHERY_CACHE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedConnection {
    connection_id: Uuid,
    label: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    #[serde(default = "default_database_type")]
    database_type: String,
    database: Option<String>,
    #[serde(default)]
    archery_env: Option<String>,
    #[serde(default)]
    archery_db_name: Option<String>,
    max_connections: u32,
    last_server_version: Option<String>,
}

impl SavedConnection {
    fn is_archery(&self) -> bool {
        self.database_type.eq_ignore_ascii_case("archery")
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(value: sqlx::Error) -> Self {
        ApiError::bad_request(value.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(value: std::io::Error) -> Self {
        ApiError::internal(value.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(value: serde_json::Error) -> Self {
        ApiError::internal(value.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct ConnectRequest {
    #[serde(default)]
    connection_url: Option<String>,
    #[serde(default)]
    host: String,
    #[serde(default = "default_mysql_port")]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default = "default_database_type")]
    database_type: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    archery_env: Option<String>,
    #[serde(default)]
    archery_db_name: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default = "default_max_connections")]
    max_connections: u32,
}

#[derive(Debug, Serialize)]
struct ConnectionSummary {
    connection_id: Uuid,
    label: String,
    host: String,
    port: u16,
    username: String,
    database_type: String,
    database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archery_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archery_db_name: Option<String>,
    server_version: Option<String>,
    connected: bool,
}

#[derive(Debug, Serialize)]
struct DatabasesResponse {
    databases: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TablesResponse {
    tables: Vec<TableInfo>,
}

#[derive(Debug, Clone, Serialize)]
struct TableInfo {
    name: String,
    table_type: String,
    engine: Option<String>,
    table_rows: Option<u64>,
    comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct TableColumn {
    name: String,
    column_type: String,
    nullable: bool,
    key: String,
    default_value: Option<String>,
    extra: String,
    comment: String,
}

#[derive(Debug, Clone, Serialize)]
struct TableDetailResponse {
    database: String,
    table: String,
    columns: Vec<TableColumn>,
    data_columns: Vec<ColumnInfo>,
    rows: Vec<Map<String, Value>>,
    sample_limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    ddl: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QueryRequest {
    sql: String,
    #[serde(default = "default_max_rows")]
    max_rows: usize,
}

#[derive(Debug, Deserialize)]
struct CacheQuery {
    #[serde(default, deserialize_with = "deserialize_refresh_flag")]
    refresh: bool,
    #[serde(default)]
    cache_ttl_minutes: Option<u64>,
    #[serde(default)]
    sample_limit: Option<usize>,
}

fn deserialize_refresh_flag<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(value
        .as_deref()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "y" | "on"
            )
        })
        .unwrap_or(false))
}

#[derive(Debug, Clone, Serialize)]
struct ColumnInfo {
    name: String,
    type_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum QueryResponse {
    Rows {
        duration_ms: u128,
        columns: Vec<ColumnInfo>,
        rows: Vec<Map<String, Value>>,
        row_count: usize,
        limited: bool,
    },
    Command {
        duration_ms: u128,
        rows_affected: u64,
    },
}

fn default_mysql_port() -> u16 {
    3306
}

fn default_max_connections() -> u32 {
    5
}

fn default_database_type() -> String {
    "mysql".to_string()
}

fn default_max_rows() -> usize {
    500
}

#[tokio::main]
async fn main() {
    let config_path = connection_config_path();
    let saved_connections = match load_saved_connections(&config_path).await {
        Ok(connections) => connections,
        Err(error) => {
            eprintln!(
                "Failed to load SQL Workbench connections from {}: {:?}",
                config_path.display(),
                error
            );
            HashMap::new()
        }
    };

    let state = AppState {
        saved_connections: Arc::new(RwLock::new(saved_connections)),
        pools: Arc::new(RwLock::new(HashMap::new())),
        archery_tables_cache: Arc::new(RwLock::new(HashMap::new())),
        archery_table_structure_cache: Arc::new(RwLock::new(HashMap::new())),
        config_path: Arc::new(config_path),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let bind_addr =
        std::env::var("SQL_WORKBENCH_BIND").unwrap_or_else(|_| "127.0.0.1:8788".to_string());
    let frontend_dir = std::env::var("SQL_WORKBENCH_FRONTEND_DIR")
        .unwrap_or_else(|_| "../frontend/dist".to_string());
    let static_files = ServeDir::new(&frontend_dir)
        .not_found_service(ServeFile::new(format!("{frontend_dir}/index.html")));

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/mysql/connect", post(create_connection))
        .route(
            "/api/mysql/connections",
            get(list_connections).post(create_connection),
        )
        .route(
            "/api/mysql/connections/{connection_id}",
            delete(delete_connection),
        )
        .route(
            "/api/mysql/connections/{connection_id}/databases",
            get(list_databases),
        )
        .route(
            "/api/mysql/connections/{connection_id}/databases/{database}/tables",
            get(list_tables),
        )
        .route(
            "/api/mysql/connections/{connection_id}/databases/{database}/tables/{table}",
            get(get_table_detail),
        )
        .route(
            "/api/mysql/connections/{connection_id}/query",
            post(execute_query),
        )
        .fallback_service(static_files)
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("bind backend port");

    println!("SQL Workbench listening on http://{bind_addr}");
    axum::serve(listener, app).await.expect("run backend");
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "sql-workbench-backend" }))
}

async fn create_connection(
    State(state): State<AppState>,
    Json(request): Json<ConnectRequest>,
) -> Result<Json<ConnectionSummary>, ApiError> {
    let mut saved = saved_connection_from_request(request)?;
    let connection_id = saved.connection_id;

    if saved.is_archery() {
        saved.last_server_version = Some("Archery SQL platform".to_string());
        {
            let mut connections = state.saved_connections.write().await;
            connections.insert(connection_id, saved.clone());
        }
        persist_saved_connections(&state).await?;
        return Ok(Json(summary_from_saved(&saved, true)));
    }

    let (pool, server_version) = open_pool(&saved).await?;
    saved.last_server_version = Some(server_version.clone());

    {
        let mut connections = state.saved_connections.write().await;
        connections.insert(connection_id, saved.clone());
    }
    persist_saved_connections(&state).await?;

    {
        let mut pools = state.pools.write().await;
        pools.insert(
            connection_id,
            ConnectionEntry {
                server_version,
                pool,
            },
        );
    }

    Ok(Json(summary_from_saved(&saved, true)))
}

async fn list_connections(State(state): State<AppState>) -> Json<Vec<ConnectionSummary>> {
    let connections = state.saved_connections.read().await;
    let pools = state.pools.read().await;
    let mut values = connections
        .values()
        .map(|connection| {
            let pool = pools.get(&connection.connection_id);
            let mut summary = summary_from_saved(connection, pool.is_some());
            if let Some(pool) = pool {
                summary.server_version = Some(pool.server_version.clone());
            }
            summary
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.label.cmp(&right.label));
    Json(values)
}

async fn delete_connection(
    State(state): State<AppState>,
    Path(connection_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let removed = {
        let mut connections = state.saved_connections.write().await;
        connections.remove(&connection_id)
    };

    let removed = removed.ok_or_else(|| ApiError::not_found("connection not found"))?;
    if removed.is_archery() {
        clear_archery_cache_for_connection(&state, &removed).await;
    }

    persist_saved_connections(&state).await?;

    let pool = {
        let mut pools = state.pools.write().await;
        pools.remove(&connection_id).map(|entry| entry.pool)
    };
    if let Some(pool) = pool {
        pool.close().await;
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn list_databases(
    State(state): State<AppState>,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<DatabasesResponse>, ApiError> {
    let saved = saved_connection(&state, connection_id).await?;
    if saved.is_archery() {
        let database = saved
            .archery_db_name
            .as_deref()
            .or(saved.database.as_deref())
            .unwrap_or("wms")
            .to_string();
        return Ok(Json(DatabasesResponse {
            databases: vec![database],
        }));
    }

    let pool = get_pool(&state, connection_id).await?;
    let rows = sqlx::query("SHOW DATABASES").fetch_all(&pool).await?;
    let databases = rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .collect::<Vec<_>>();
    Ok(Json(DatabasesResponse { databases }))
}

async fn list_tables(
    State(state): State<AppState>,
    Path((connection_id, database)): Path<(Uuid, String)>,
    Query(cache_query): Query<CacheQuery>,
) -> Result<Json<TablesResponse>, ApiError> {
    let saved = saved_connection(&state, connection_id).await?;
    if saved.is_archery() {
        let cache_key = archery_tables_cache_key(&saved, &database);
        if !cache_query.refresh {
            if let Some(tables) = cached_value(
                &state.archery_tables_cache,
                &cache_key,
                cache_ttl(cache_query.cache_ttl_minutes),
            )
            .await
            {
                return Ok(Json(TablesResponse { tables }));
            }
        }

        let response = execute_archery_query(
            &saved,
            &format!(
                r#"
                SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = '{}'
                ORDER BY TABLE_NAME
                "#,
                sql_string_literal(&database)
            ),
            5000,
        )
        .await?;
        let tables = table_infos_from_query_response(response);
        set_cached_value(&state.archery_tables_cache, cache_key, tables.clone()).await;
        return Ok(Json(TablesResponse { tables }));
    }

    let pool = get_pool(&state, connection_id).await?;
    let rows = sqlx::query(
        r#"
        SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME
        "#,
    )
    .bind(&database)
    .fetch_all(&pool)
    .await?;

    let tables = rows
        .iter()
        .map(|row| TableInfo {
            name: row.try_get("TABLE_NAME").unwrap_or_default(),
            table_type: row.try_get("TABLE_TYPE").unwrap_or_default(),
            engine: row.try_get("ENGINE").ok(),
            table_rows: row.try_get::<Option<u64>, _>("TABLE_ROWS").ok().flatten(),
            comment: row.try_get("TABLE_COMMENT").ok(),
        })
        .collect::<Vec<_>>();

    Ok(Json(TablesResponse { tables }))
}

async fn get_table_detail(
    State(state): State<AppState>,
    Path((connection_id, database, table)): Path<(Uuid, String, String)>,
    Query(cache_query): Query<CacheQuery>,
) -> Result<Json<TableDetailResponse>, ApiError> {
    let saved = saved_connection(&state, connection_id).await?;
    if saved.is_archery() {
        let cache_key = archery_table_detail_cache_key(&saved, &database, &table);
        let columns = if !cache_query.refresh {
            cached_value(
                &state.archery_table_structure_cache,
                &cache_key,
                cache_ttl(cache_query.cache_ttl_minutes),
            )
            .await
        } else {
            None
        };

        let columns = match columns {
            Some(columns) => columns,
            None => {
                let column_response = execute_archery_query(
                    &saved,
                    &format!(
                        r#"
                SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}'
                ORDER BY ORDINAL_POSITION
                "#,
                        sql_string_literal(&database),
                        sql_string_literal(&table)
                    ),
                    1000,
                )
                .await?;
                let columns = table_columns_from_query_response(column_response);
                if columns.is_empty() {
                    return Err(ApiError::not_found("table not found"));
                }
                set_cached_value(
                    &state.archery_table_structure_cache,
                    cache_key,
                    columns.clone(),
                )
                .await;
                columns
            }
        };

        let sample_limit = cache_query.sample_limit.unwrap_or(100);
        let data_response = execute_archery_query(
            &saved,
            &format!(
                "SELECT * FROM {}.{} LIMIT {sample_limit}",
                quote_identifier(&database),
                quote_identifier(&table)
            ),
            sample_limit,
        )
        .await?;
        let (data_columns, rows) = rows_from_query_response(data_response);

        return Ok(Json(TableDetailResponse {
            database,
            table,
            columns,
            data_columns,
            rows,
            sample_limit,
            ddl: None,
        }));
    }

    let pool = get_pool(&state, connection_id).await?;
    let column_rows = sqlx::query(
        r#"
        SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
        "#,
    )
    .bind(&database)
    .bind(&table)
    .fetch_all(&pool)
    .await?;

    if column_rows.is_empty() {
        return Err(ApiError::not_found("table not found"));
    }

    let columns = column_rows
        .iter()
        .map(|row| TableColumn {
            name: row.try_get("COLUMN_NAME").unwrap_or_default(),
            column_type: row.try_get("COLUMN_TYPE").unwrap_or_default(),
            nullable: row
                .try_get::<String, _>("IS_NULLABLE")
                .map(|value| value == "YES")
                .unwrap_or(false),
            key: row.try_get("COLUMN_KEY").unwrap_or_default(),
            default_value: row.try_get("COLUMN_DEFAULT").ok(),
            extra: row.try_get("EXTRA").unwrap_or_default(),
            comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
        })
        .collect::<Vec<_>>();

    let sample_limit = cache_query.sample_limit.unwrap_or(100);
    let data_sql = format!(
        "SELECT * FROM {}.{} LIMIT {sample_limit}",
        quote_identifier(&database),
        quote_identifier(&table)
    );
    let rows = sqlx::query(&data_sql).fetch_all(&pool).await?;
    let data_columns = columns
        .iter()
        .map(|column| ColumnInfo {
            name: column.name.clone(),
            type_name: column.column_type.clone(),
        })
        .collect::<Vec<_>>();
    let data = rows.iter().map(row_to_json_map).collect::<Vec<_>>();

    let ddl = show_create_table(&pool, &database, &table).await.ok();

    Ok(Json(TableDetailResponse {
        database,
        table,
        columns,
        data_columns,
        rows: data,
        sample_limit,
        ddl,
    }))
}

async fn execute_query(
    State(state): State<AppState>,
    Path(connection_id): Path<Uuid>,
    Json(request): Json<QueryRequest>,
) -> Result<Json<QueryResponse>, ApiError> {
    let sql = request.sql.trim();
    if sql.is_empty() {
        return Err(ApiError::bad_request("sql is required"));
    }

    let saved = saved_connection(&state, connection_id).await?;
    if saved.is_archery() {
        return Ok(Json(
            execute_archery_query(&saved, sql, request.max_rows).await?,
        ));
    }

    let pool = get_pool(&state, connection_id).await?;
    let max_rows = request.max_rows.clamp(1, 5000);
    let started = Instant::now();

    if returns_rows(sql) {
        let rows = sqlx::query(sql).fetch_all(&pool).await?;
        let duration_ms = started.elapsed().as_millis();
        let columns = rows
            .first()
            .map(|row| {
                row.columns()
                    .iter()
                    .map(|column| ColumnInfo {
                        name: column.name().to_owned(),
                        type_name: column.type_info().name().to_owned(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let limited = rows.len() > max_rows;
        let data = rows
            .iter()
            .take(max_rows)
            .map(row_to_json_map)
            .collect::<Vec<_>>();

        Ok(Json(QueryResponse::Rows {
            duration_ms,
            columns,
            row_count: rows.len(),
            rows: data,
            limited,
        }))
    } else {
        let result = sqlx::query(sql).execute(&pool).await?;
        Ok(Json(QueryResponse::Command {
            duration_ms: started.elapsed().as_millis(),
            rows_affected: result.rows_affected(),
        }))
    }
}

async fn execute_archery_query(
    saved: &SavedConnection,
    sql: &str,
    max_rows: usize,
) -> Result<QueryResponse, ApiError> {
    if !returns_rows(sql) {
        return Err(ApiError::bad_request(
            "Archery connections are read-only in SQL Workbench; use SELECT, SHOW, DESC, EXPLAIN, or WITH",
        ));
    }

    let archery_env = saved
        .archery_env
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("archery_env is missing on saved connection"))?;
    let db_name = saved
        .archery_db_name
        .as_deref()
        .or(saved.database.as_deref())
        .unwrap_or("wms");
    let max_rows = max_rows.clamp(1, 5000);
    let started = Instant::now();
    let output = Command::new(archery_cli_path())
        .arg("--env")
        .arg(archery_env)
        .arg("--db-name")
        .arg(db_name)
        .arg("--limit-num")
        .arg(max_rows.to_string())
        .arg("--sql")
        .arg(sql)
        .output()
        .await?;
    let duration_ms = started.elapsed().as_millis();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Err(ApiError::bad_request(format!(
            "Archery query failed: {}",
            if message.is_empty() {
                "unknown error"
            } else {
                &message
            }
        )));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| ApiError::internal(format!("Archery output is not UTF-8: {error}")))?;
    let payload = serde_json::from_str::<Value>(&stdout).map_err(|error| {
        ApiError::bad_request(format!(
            "Archery returned non-JSON output: {error}; output: {}",
            stdout.trim()
        ))
    })?;
    archery_payload_to_query_response(payload, duration_ms, max_rows)
}

fn archery_cli_path() -> String {
    std::env::var("SQL_WORKBENCH_ARCHERY_CLI").unwrap_or_else(|_| {
        "/home/hevin/.agents/skills/mysql-archery-query/bin/archery_sql_query_direct".to_string()
    })
}

async fn cached_value<T: Clone>(
    cache: &Arc<RwLock<HashMap<String, CachedEntry<T>>>>,
    key: &str,
    ttl: Duration,
) -> Option<T> {
    cache
        .read()
        .await
        .get(key)
        .and_then(|entry| entry.fresh_value(ttl))
}

async fn set_cached_value<T>(
    cache: &Arc<RwLock<HashMap<String, CachedEntry<T>>>>,
    key: String,
    value: T,
) {
    cache.write().await.insert(
        key,
        CachedEntry {
            cached_at: Instant::now(),
            value,
        },
    );
}

fn archery_tables_cache_key(saved: &SavedConnection, database: &str) -> String {
    format!(
        "{}:{}:{}",
        saved.archery_env.as_deref().unwrap_or(""),
        saved
            .archery_db_name
            .as_deref()
            .or(saved.database.as_deref())
            .unwrap_or(""),
        database
    )
}

fn archery_table_detail_cache_key(saved: &SavedConnection, database: &str, table: &str) -> String {
    format!("{}:{}", archery_tables_cache_key(saved, database), table)
}

fn cache_ttl(minutes: Option<u64>) -> Duration {
    minutes
        .filter(|value| *value > 0)
        .map(|value| Duration::from_secs(value.saturating_mul(60)))
        .unwrap_or(DEFAULT_ARCHERY_CACHE_TTL)
}

async fn clear_archery_cache_for_connection(state: &AppState, saved: &SavedConnection) {
    let prefix = format!(
        "{}:{}:",
        saved.archery_env.as_deref().unwrap_or(""),
        saved
            .archery_db_name
            .as_deref()
            .or(saved.database.as_deref())
            .unwrap_or("")
    );
    state
        .archery_tables_cache
        .write()
        .await
        .retain(|key, _| !key.starts_with(&prefix));
    state
        .archery_table_structure_cache
        .write()
        .await
        .retain(|key, _| !key.starts_with(&prefix));
}

fn archery_payload_to_query_response(
    payload: Value,
    duration_ms: u128,
    max_rows: usize,
) -> Result<QueryResponse, ApiError> {
    if archery_payload_failed(&payload) {
        return Err(ApiError::bad_request(format!(
            "Archery query failed: {}",
            archery_message(&payload).unwrap_or_else(|| payload.to_string())
        )));
    }

    let data = payload
        .get("data")
        .or_else(|| payload.get("result"))
        .unwrap_or(&payload);
    let rows_value = data
        .get("rows")
        .or_else(|| data.get("result"))
        .or_else(|| data.get("data"));
    let columns = archery_columns(data, &[]);
    let rows = rows_value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| archery_row_to_map(value, &columns))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let columns = if columns.is_empty() {
        archery_columns(data, &rows)
    } else {
        columns
    };
    let limited = rows.len() > max_rows;
    let row_count = archery_row_count(data).unwrap_or(rows.len());
    let rows = rows.into_iter().take(max_rows).collect::<Vec<_>>();

    Ok(QueryResponse::Rows {
        duration_ms,
        columns,
        row_count,
        rows,
        limited,
    })
}

fn archery_payload_failed(payload: &Value) -> bool {
    payload
        .get("status")
        .or_else(|| payload.get("code"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
        })
        .map(|status| status != 0 && status != 1)
        .unwrap_or(false)
}

fn archery_message(payload: &Value) -> Option<String> {
    payload
        .get("msg")
        .or_else(|| payload.get("message"))
        .or_else(|| payload.get("error"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn archery_row_count(data: &Value) -> Option<usize> {
    data.get("row_count")
        .or_else(|| data.get("count"))
        .or_else(|| data.get("total"))
        .and_then(|value| {
            value
                .as_u64()
                .map(|value| value as usize)
                .or_else(|| value.as_str().and_then(|text| text.parse::<usize>().ok()))
        })
}

fn archery_columns(data: &Value, rows: &[Map<String, Value>]) -> Vec<ColumnInfo> {
    if let Some(columns) = data
        .get("column_list")
        .or_else(|| data.get("columns"))
        .and_then(Value::as_array)
    {
        let parsed = columns
            .iter()
            .filter_map(archery_column_info)
            .collect::<Vec<_>>();
        if !parsed.is_empty() {
            return parsed;
        }
    }

    rows.first()
        .map(|row| {
            row.keys()
                .map(|name| ColumnInfo {
                    name: name.clone(),
                    type_name: "unknown".to_string(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn archery_column_info(value: &Value) -> Option<ColumnInfo> {
    match value {
        Value::String(name) => Some(ColumnInfo {
            name: name.clone(),
            type_name: "unknown".to_string(),
        }),
        Value::Object(object) => {
            let name = object
                .get("name")
                .or_else(|| object.get("column"))
                .or_else(|| object.get("title"))
                .or_else(|| object.get("field"))
                .and_then(Value::as_str)?;
            let type_name = object
                .get("type")
                .or_else(|| object.get("type_name"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(ColumnInfo {
                name: name.to_string(),
                type_name: type_name.to_string(),
            })
        }
        _ => None,
    }
}

fn archery_row_to_map(value: &Value, columns: &[ColumnInfo]) -> Map<String, Value> {
    match value {
        Value::Object(object) => object.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let column_name = columns
                    .get(index)
                    .map(|column| column.name.clone())
                    .unwrap_or_else(|| format!("col_{}", index + 1));
                (column_name, value.clone())
            })
            .collect(),
        other => {
            let mut row = Map::new();
            row.insert("value".to_string(), other.clone());
            row
        }
    }
}

fn table_infos_from_query_response(response: QueryResponse) -> Vec<TableInfo> {
    match response {
        QueryResponse::Rows { rows, .. } => rows
            .into_iter()
            .filter_map(|row| {
                let name = string_cell(row.get("TABLE_NAME"))?;
                Some(TableInfo {
                    name,
                    table_type: string_cell(row.get("TABLE_TYPE")).unwrap_or_default(),
                    engine: string_cell(row.get("ENGINE")),
                    table_rows: u64_cell(row.get("TABLE_ROWS")),
                    comment: string_cell(row.get("TABLE_COMMENT")),
                })
            })
            .collect(),
        QueryResponse::Command { .. } => Vec::new(),
    }
}

fn table_columns_from_query_response(response: QueryResponse) -> Vec<TableColumn> {
    match response {
        QueryResponse::Rows { rows, .. } => rows
            .into_iter()
            .filter_map(|row| {
                let name = string_cell(row.get("COLUMN_NAME"))?;
                Some(TableColumn {
                    name,
                    column_type: string_cell(row.get("COLUMN_TYPE")).unwrap_or_default(),
                    nullable: string_cell(row.get("IS_NULLABLE"))
                        .map(|value| value.eq_ignore_ascii_case("YES"))
                        .unwrap_or(false),
                    key: string_cell(row.get("COLUMN_KEY")).unwrap_or_default(),
                    default_value: string_cell(row.get("COLUMN_DEFAULT")),
                    extra: string_cell(row.get("EXTRA")).unwrap_or_default(),
                    comment: string_cell(row.get("COLUMN_COMMENT")).unwrap_or_default(),
                })
            })
            .collect(),
        QueryResponse::Command { .. } => Vec::new(),
    }
}

fn rows_from_query_response(response: QueryResponse) -> (Vec<ColumnInfo>, Vec<Map<String, Value>>) {
    match response {
        QueryResponse::Rows { columns, rows, .. } => (columns, rows),
        QueryResponse::Command { .. } => (Vec::new(), Vec::new()),
    }
}

fn string_cell(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()).filter(|value| !value.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        other => Some(other.to_string()),
    }
}

fn u64_cell(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_i64().map(|value| value as u64)),
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    }
}

fn sql_string_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''")
}

async fn saved_connection(
    state: &AppState,
    connection_id: Uuid,
) -> Result<SavedConnection, ApiError> {
    state
        .saved_connections
        .read()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("connection not found"))
}

async fn get_pool(state: &AppState, connection_id: Uuid) -> Result<MySqlPool, ApiError> {
    if let Some(entry) = state.pools.read().await.get(&connection_id) {
        return Ok(entry.pool.clone());
    }

    let saved = state
        .saved_connections
        .read()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("connection not found"))?;

    let (pool, server_version) = open_pool(&saved).await?;
    {
        let mut connections = state.saved_connections.write().await;
        if let Some(connection) = connections.get_mut(&connection_id) {
            connection.last_server_version = Some(server_version.clone());
        }
    }
    persist_saved_connections(state).await?;

    state.pools.write().await.insert(
        connection_id,
        ConnectionEntry {
            server_version,
            pool: pool.clone(),
        },
    );

    Ok(pool)
}

async fn open_pool(saved: &SavedConnection) -> Result<(MySqlPool, String), ApiError> {
    let mut options = MySqlConnectOptions::new()
        .host(&saved.host)
        .port(saved.port)
        .username(&saved.username)
        .password(&saved.password);

    if let Some(database) = saved
        .database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        options = options.database(database);
    }

    let pool = MySqlPoolOptions::new()
        .max_connections(saved.max_connections.clamp(1, 20))
        .min_connections(1)
        .test_before_acquire(false)
        .connect_with(options)
        .await?;
    let server_version: (String,) = sqlx::query_as("SELECT VERSION()").fetch_one(&pool).await?;
    Ok((pool, server_version.0))
}

fn saved_connection_from_request(request: ConnectRequest) -> Result<SavedConnection, ApiError> {
    let database_type = request.database_type.trim().to_ascii_lowercase();
    if database_type == "archery" {
        return archery_connection_from_request(request);
    }
    if database_type != "mysql" {
        return Err(ApiError::bad_request(
            "only mysql and archery database types are supported",
        ));
    }

    let parsed_url = request
        .connection_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_mysql_connection_url)
        .transpose()?;

    let host = parsed_url
        .as_ref()
        .map(|connection| connection.host.as_str())
        .unwrap_or_else(|| request.host.trim());
    let username = parsed_url
        .as_ref()
        .map(|connection| connection.username.as_str())
        .unwrap_or_else(|| request.username.trim());
    let password = parsed_url
        .as_ref()
        .map(|connection| connection.password.clone())
        .unwrap_or_else(|| request.password.clone());
    let port = parsed_url
        .as_ref()
        .map(|connection| connection.port)
        .unwrap_or(request.port);
    let database = parsed_url
        .as_ref()
        .and_then(|connection| connection.database.clone())
        .or_else(|| {
            request
                .database
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        });

    if host.is_empty() {
        return Err(ApiError::bad_request("host is required"));
    }
    if username.is_empty() {
        return Err(ApiError::bad_request("username is required"));
    }

    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{username}@{host}:{port}"));

    Ok(SavedConnection {
        connection_id: Uuid::new_v4(),
        label,
        host: host.to_owned(),
        port,
        username: username.to_owned(),
        password,
        database_type,
        database,
        archery_env: None,
        archery_db_name: None,
        max_connections: request.max_connections.clamp(1, 20),
        last_server_version: None,
    })
}

fn archery_connection_from_request(request: ConnectRequest) -> Result<SavedConnection, ApiError> {
    let archery_env = request
        .archery_env
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("archery_env is required"))?;
    if !matches!(archery_env, "uat-cn" | "uat-sea" | "pro-cn" | "pro-sea") {
        return Err(ApiError::bad_request(
            "archery_env must be one of: uat-cn, uat-sea, pro-cn, pro-sea",
        ));
    }

    let archery_db_name = request
        .archery_db_name
        .as_deref()
        .or(request.database.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("wms")
        .to_owned();
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("WMS Archery {archery_env}"));

    Ok(SavedConnection {
        connection_id: Uuid::new_v4(),
        label,
        host: "archery.yunlu-tech.cn".to_string(),
        port: 443,
        username: archery_env.to_owned(),
        password: String::new(),
        database_type: "archery".to_string(),
        database: Some(archery_db_name.clone()),
        archery_env: Some(archery_env.to_owned()),
        archery_db_name: Some(archery_db_name),
        max_connections: 1,
        last_server_version: None,
    })
}

struct ParsedConnectionUrl {
    host: String,
    port: u16,
    username: String,
    password: String,
    database: Option<String>,
}

fn parse_mysql_connection_url(raw_url: &str) -> Result<ParsedConnectionUrl, ApiError> {
    let url = if raw_url.starts_with("jdbc:mysql://") {
        &raw_url[5..]
    } else {
        raw_url
    };

    let url = url::Url::parse(url)
        .map_err(|error| ApiError::bad_request(format!("invalid MySQL connection URL: {error}")))?;

    if url.scheme() != "mysql" {
        return Err(ApiError::bad_request(
            "connection URL must start with mysql:// or jdbc:mysql://",
        ));
    }

    let host = url
        .host_str()
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("connection URL host is required"))?;
    let port = url.port().unwrap_or_else(default_mysql_port);
    let username = if url.username().is_empty() {
        query_value(&url, "user")
            .or_else(|| query_value(&url, "username"))
            .unwrap_or_default()
    } else {
        decode_url_component(url.username(), "username")?
    };
    if username.is_empty() {
        return Err(ApiError::bad_request("connection URL username is required"));
    }

    let password = url
        .password()
        .map(|value| decode_url_component(value, "password"))
        .transpose()?
        .or_else(|| query_value(&url, "password"))
        .or_else(|| query_value(&url, "passwd"))
        .unwrap_or_default();

    let database = url
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| decode_url_component(value, "database"))
        .transpose()?;

    Ok(ParsedConnectionUrl {
        host,
        port,
        username,
        password,
        database,
    })
}

fn decode_url_component(value: &str, label: &str) -> Result<String, ApiError> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|error| ApiError::bad_request(format!("invalid URL-encoded {label}: {error}")))
}

fn query_value(url: &url::Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mysql_connection_url_with_credentials_in_authority() {
        let parsed = parse_mysql_connection_url("mysql://root:secret@127.0.0.1:3307/app_db")
            .expect("connection URL should parse");

        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, 3307);
        assert_eq!(parsed.username, "root");
        assert_eq!(parsed.password, "secret");
        assert_eq!(parsed.database.as_deref(), Some("app_db"));
    }

    #[test]
    fn parses_jdbc_connection_url_with_credentials_in_query() {
        let parsed = parse_mysql_connection_url(
            "jdbc:mysql://127.0.0.1:3306/app_db?user=root&password=secret",
        )
        .expect("JDBC connection URL should parse");

        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, 3306);
        assert_eq!(parsed.username, "root");
        assert_eq!(parsed.password, "secret");
        assert_eq!(parsed.database.as_deref(), Some("app_db"));
    }
}

fn summary_from_saved(saved: &SavedConnection, connected: bool) -> ConnectionSummary {
    ConnectionSummary {
        connection_id: saved.connection_id,
        label: saved.label.clone(),
        host: saved.host.clone(),
        port: saved.port,
        username: saved.username.clone(),
        database_type: saved.database_type.clone(),
        database: saved.database.clone(),
        archery_env: saved.archery_env.clone(),
        archery_db_name: saved.archery_db_name.clone(),
        server_version: saved.last_server_version.clone(),
        connected,
    }
}

fn connection_config_path() -> PathBuf {
    if let Ok(path) = std::env::var("SQL_WORKBENCH_CONFIG") {
        return PathBuf::from(path);
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".config")
        .join("sql-workbench")
        .join("connections.json")
}

async fn load_saved_connections(
    path: &PathBuf,
) -> Result<HashMap<Uuid, SavedConnection>, ApiError> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(HashMap::new());
    }

    let content = tokio::fs::read_to_string(path).await?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let values = serde_json::from_str::<Vec<SavedConnection>>(&content)?;
    Ok(values
        .into_iter()
        .map(|connection| (connection.connection_id, connection))
        .collect())
}

async fn persist_saved_connections(state: &AppState) -> Result<(), ApiError> {
    let mut values = state
        .saved_connections
        .read()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.label.cmp(&right.label));

    if let Some(parent) = state.config_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let json = serde_json::to_string_pretty(&values)?;
    let file_name = state
        .config_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("connections.json");
    let tmp_path = state.config_path.with_file_name(format!("{file_name}.tmp"));

    tokio::fs::write(&tmp_path, json).await?;
    #[cfg(unix)]
    tokio::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600)).await?;
    tokio::fs::rename(tmp_path, state.config_path.as_ref()).await?;
    Ok(())
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn returns_rows(sql: &str) -> bool {
    let keyword = sql
        .trim_start_matches(|char: char| char.is_whitespace() || char == '(')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        keyword.as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH"
    )
}

async fn show_create_table(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<String, ApiError> {
    let sql = format!(
        "SHOW CREATE TABLE {}.{}",
        quote_identifier(database),
        quote_identifier(table)
    );
    let row = sqlx::query(&sql).fetch_one(pool).await?;
    let ddl: String = row.try_get::<String, _>(1).map_err(|error| {
        ApiError::internal(format!("failed to read CREATE TABLE statement: {error}"))
    })?;
    Ok(ddl)
}

fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn row_to_json_map(row: &MySqlRow) -> Map<String, Value> {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        object.insert(column.name().to_owned(), cell_value(row, index));
    }
    object
}

fn cell_value(row: &MySqlRow, index: usize) -> Value {
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return value.map(Value::String).unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value
            .map(|value| Value::Number(Number::from(value)))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<u64>, _>(index) {
        return value
            .map(|value| Value::Number(Number::from(value)))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
        return value
            .and_then(Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
        return value.map(Value::Bool).unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<NaiveDateTime>, _>(index) {
        return value
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<NaiveDate>, _>(index) {
        return value
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<NaiveTime>, _>(index) {
        return value
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return value
            .map(|bytes| {
                String::from_utf8(bytes.clone())
                    .map(Value::String)
                    .unwrap_or_else(|_| Value::String(format!("base64:{}", BASE64.encode(bytes))))
            })
            .unwrap_or(Value::Null);
    }
    Value::String("<unsupported>".to_owned())
}
