# SQL Workbench

A local SQL workbench for viewing and executing SQL against MySQL. The current milestone supports saved MySQL connections, database/table browsing, table schema inspection, sample data preview, and ad-hoc SQL execution.

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
- `POST /api/mysql/connections` - save a MySQL connection and open a pool
- `GET /api/mysql/connections` - list saved connections
- `DELETE /api/mysql/connections/:id` - delete a saved connection and close its pool
- `GET /api/mysql/connections/:id/databases` - list databases
- `GET /api/mysql/connections/:id/databases/:database/tables` - list tables in a database
- `GET /api/mysql/connections/:id/databases/:database/tables/:table` - show table structure and sample rows
- `POST /api/mysql/connections/:id/query` - execute one SQL statement

Saved connections are persisted to `~/.config/sql-workbench/connections.json` by default. Passwords are never returned to the frontend, but they are stored locally so the service can reconnect after restart. Override the path with `SQL_WORKBENCH_CONFIG` if needed.

## Systemd

A user-level unit is included at `systemd/sql-workbench.service`.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/sql-workbench.service ~/.config/systemd/user/sql-workbench.service
systemctl --user daemon-reload
systemctl --user enable --now sql-workbench.service
```
