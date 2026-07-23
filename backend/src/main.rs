use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};
use sqlx::{
    Column, MySqlPool, Row, TypeInfo,
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow},
};
use tokio::sync::RwLock;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    saved_connections: Arc<RwLock<HashMap<Uuid, SavedConnection>>>,
    pools: Arc<RwLock<HashMap<Uuid, ConnectionEntry>>>,
    config_path: Arc<PathBuf>,
}

#[derive(Clone)]
struct ConnectionEntry {
    server_version: String,
    pool: MySqlPool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedConnection {
    connection_id: Uuid,
    label: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: Option<String>,
    max_connections: u32,
    last_server_version: Option<String>,
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
    host: String,
    #[serde(default = "default_mysql_port")]
    port: u16,
    username: String,
    password: String,
    #[serde(default)]
    database: Option<String>,
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
    database: Option<String>,
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

#[derive(Debug, Serialize)]
struct TableInfo {
    name: String,
    table_type: String,
    engine: Option<String>,
    table_rows: Option<u64>,
    comment: Option<String>,
}

#[derive(Debug, Serialize)]
struct TableColumn {
    name: String,
    column_type: String,
    nullable: bool,
    key: String,
    default_value: Option<String>,
    extra: String,
    comment: String,
}

#[derive(Debug, Serialize)]
struct TableDetailResponse {
    database: String,
    table: String,
    columns: Vec<TableColumn>,
    data_columns: Vec<ColumnInfo>,
    rows: Vec<Map<String, Value>>,
    sample_limit: usize,
}

#[derive(Debug, Deserialize)]
struct QueryRequest {
    sql: String,
    #[serde(default = "default_max_rows")]
    max_rows: usize,
}

#[derive(Debug, Serialize)]
struct ColumnInfo {
    name: String,
    type_name: String,
}

#[derive(Debug, Serialize)]
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
    let (pool, server_version) = open_pool(&saved).await?;
    saved.last_server_version = Some(server_version.clone());
    let connection_id = saved.connection_id;

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

    if removed.is_none() {
        return Err(ApiError::not_found("connection not found"));
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
) -> Result<Json<TablesResponse>, ApiError> {
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
) -> Result<Json<TableDetailResponse>, ApiError> {
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

    let sample_limit = 100;
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

    Ok(Json(TableDetailResponse {
        database,
        table,
        columns,
        data_columns,
        rows: data,
        sample_limit,
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
        .connect_with(options)
        .await?;
    let server_version: (String,) = sqlx::query_as("SELECT VERSION()").fetch_one(&pool).await?;
    Ok((pool, server_version.0))
}

fn saved_connection_from_request(request: ConnectRequest) -> Result<SavedConnection, ApiError> {
    let host = request.host.trim();
    let username = request.username.trim();
    let database = request
        .database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

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
        .unwrap_or_else(|| format!("{username}@{host}:{}", request.port));

    Ok(SavedConnection {
        connection_id: Uuid::new_v4(),
        label,
        host: host.to_owned(),
        port: request.port,
        username: username.to_owned(),
        password: request.password,
        database,
        max_connections: request.max_connections.clamp(1, 20),
        last_server_version: None,
    })
}

fn summary_from_saved(saved: &SavedConnection, connected: bool) -> ConnectionSummary {
    ConnectionSummary {
        connection_id: saved.connection_id,
        label: saved.label.clone(),
        host: saved.host.clone(),
        port: saved.port,
        username: saved.username.clone(),
        database: saved.database.clone(),
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
