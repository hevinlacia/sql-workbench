# SQL Workbench

A local SQL workbench for viewing and executing SQL against MySQL and WMS Archery-backed MySQL environments. The current milestone supports saved direct MySQL connections, WMS Archery platform connections, database/table browsing for direct MySQL, table schema inspection, sample data preview, and ad-hoc SQL execution.

## Stack

- Frontend: TypeScript + React + Vite
- Backend: Rust + Axum + SQLx MySQL

## Layout

```text
backend/   Rust API service
frontend/  React UI
scripts/   Local dev helpers
```

## Run locally

```bash
cd /home/hevin/Developer/tools/sql-workbench/frontend
npm install

cd /home/hevin/Developer/tools/sql-workbench/backend
cargo run

# in another terminal
cd /home/hevin/Developer/tools/sql-workbench/frontend
npm run dev
```

Or start both:

```bash
/home/hevin/Developer/tools/sql-workbench/scripts/dev.sh
```

Default URLs:

- Frontend: <http://127.0.0.1:5178>
- Backend: <http://127.0.0.1:8788>

## API

- `GET /api/health` - service health
- `POST /api/mysql/connections` - save a MySQL or Archery connection and open a direct MySQL pool when needed
- `GET /api/mysql/connections` - list saved connections
- `DELETE /api/mysql/connections/:id` - delete a saved connection and close its pool
- `GET /api/mysql/connections/:id/databases` - list databases
- `GET /api/mysql/connections/:id/databases/:database/tables` - list tables in a database
- `GET /api/mysql/connections/:id/databases/:database/tables/:table` - show table structure and sample rows
- `POST /api/mysql/connections/:id/query` - execute one SQL statement

Saved connections are persisted to `~/.config/sql-workbench/connections.json` by default. Direct MySQL passwords are never returned to the frontend, but they are stored locally so the service can reconnect after restart. Archery platform connections store only platform metadata (`env`, default DB, label) and reuse backend Archery credentials from the local environment. Override the path with `SQL_WORKBENCH_CONFIG` if needed.

Connections can be created either by separate fields (`host`, `port`, `username`, `password`, optional database) or by a connection URL. Supported URL examples:

```text
mysql://root:password@127.0.0.1:3306/app_db
jdbc:mysql://127.0.0.1:3306/app_db?user=root&password=secret
```

When using URL mode, URL values take precedence over the separate host/user/password/database fields.

Archery platform mode currently supports read-only SQL execution for WMS environments: `uat-cn`, `uat-sea`, `pro-cn`, and `pro-sea`. It shells out to the existing Archery CLI by default:

```text
/home/hevin/.agents/skills/mysql-archery-query/bin/archery_sql_query
```

Override that path with `SQL_WORKBENCH_ARCHERY_CLI` if needed. Archery connections enforce read-only statements (`SELECT`, `SHOW`, `DESCRIBE` / `DESC`, `EXPLAIN`, `WITH`) and cache table names plus table structure for 1 hour by default. SQL query results are not cached. Use Refresh / Reload in the UI to force latest metadata/data. Table-tree browsing is supported for WMS Archery exploration.

## Systemd

A user-level unit is included at `systemd/sql-workbench.service`.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/sql-workbench.service ~/.config/systemd/user/sql-workbench.service
systemctl --user daemon-reload
systemctl --user enable --now sql-workbench.service
```
