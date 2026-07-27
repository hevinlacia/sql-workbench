import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Loader2,
  Play,
  PlugZap,
  RefreshCw,
  Save,
  Search,
  Server,
  X,
  Table2,
  TerminalSquare,
  Trash2,
} from 'lucide-react'

type ConnectionSummary = {
  connection_id: string
  label: string
  host: string
  port: number
  username: string
  database_type: string
  database?: string | null
  server_version?: string | null
  connected: boolean
}

type DatabasesResponse = {
  databases: string[]
}

type TableInfo = {
  name: string
  table_type: string
  engine?: string | null
  table_rows?: number | null
  comment?: string | null
}

type TablesResponse = {
  tables: TableInfo[]
}

type TableColumn = {
  name: string
  column_type: string
  nullable: boolean
  key: string
  default_value?: string | null
  extra: string
  comment: string
}

type ColumnInfo = {
  name: string
  type_name: string
}

type TableDetailResponse = {
  database: string
  table: string
  columns: TableColumn[]
  data_columns: ColumnInfo[]
  rows: Array<Record<string, unknown>>
  sample_limit: number
  ddl?: string | null
}

type RowsQueryResponse = {
  kind: 'rows'
  duration_ms: number
  columns: ColumnInfo[]
  rows: Array<Record<string, unknown>>
  row_count: number
  limited: boolean
}

type CommandQueryResponse = {
  kind: 'command'
  duration_ms: number
  rows_affected: number
}

type QueryResponse = RowsQueryResponse | CommandQueryResponse

type ConnectionMode = 'fields' | 'url'
type DetailTab = 'structure' | 'data' | 'sql'

type ConnectForm = {
  connectionMode: ConnectionMode
  label: string
  connectionUrl: string
  host: string
  port: string
  username: string
  password: string
  databaseType: string
  database: string
  max_connections: string
}

const initialForm: ConnectForm = {
  connectionMode: 'fields',
  label: 'Local MySQL',
  connectionUrl: '',
  host: '127.0.0.1',
  port: '3306',
  username: 'root',
  password: '',
  databaseType: 'mysql',
  database: '',
  max_connections: '5',
}

const starterSql = `SELECT
  DATABASE() AS current_database,
  VERSION() AS mysql_version,
  NOW() AS server_time;`

function App() {
  const [form, setForm] = useState<ConnectForm>(initialForm)
  const [connections, setConnections] = useState<ConnectionSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [selectedDatabase, setSelectedDatabase] = useState('')
  const [selectedTable, setSelectedTable] = useState('')
  const [databasesByConnection, setDatabasesByConnection] = useState<Record<string, string[]>>({})
  const [tablesByDatabase, setTablesByDatabase] = useState<Record<string, TableInfo[]>>({})
  const [tableDetail, setTableDetail] = useState<TableDetailResponse | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('data')
  const [sql, setSql] = useState(starterSql)
  const [maxRows, setMaxRows] = useState('500')
  const [queryResult, setQueryResult] = useState<QueryResponse | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectionModalOpen, setConnectionModalOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('sql-workbench-sidebar') !== 'expanded',
  )
  const [loadingConnections, setLoadingConnections] = useState(false)
  const [loadingDatabases, setLoadingDatabases] = useState(false)
  const [loadingTablesKey, setLoadingTablesKey] = useState('')
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [tableFilter, setTableFilter] = useState('')

  const activeConnection = useMemo(
    () => connections.find((connection) => connection.connection_id === activeId) ?? null,
    [activeId, connections],
  )

  const activeDatabases = activeId ? (databasesByConnection[activeId] ?? []) : []
  const activeTablesKey = activeId && selectedDatabase ? dbKey(activeId, selectedDatabase) : ''
  const activeTables = activeTablesKey ? (tablesByDatabase[activeTablesKey] ?? []) : []
  const filteredTables = useMemo(() => {
    const keyword = tableFilter.trim().toLowerCase()
    if (!keyword) return activeTables
    return activeTables.filter((table) => table.name.toLowerCase().includes(keyword))
  }, [activeTables, tableFilter])

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current
      localStorage.setItem('sql-workbench-sidebar', next ? 'collapsed' : 'expanded')
      return next
    })
  }

  useEffect(() => {
    void loadConnections()
  }, [])

  const updateForm = <Key extends keyof ConnectForm>(key: Key, value: ConnectForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function loadConnections() {
    setLoadingConnections(true)
    setError('')
    try {
      const values = await requestJson<ConnectionSummary[]>('/api/mysql/connections')
      setConnections(values)
      setActiveId((current) => current || values[0]?.connection_id || '')
      if (!activeId && values[0]?.connection_id) {
        void selectConnection(values[0].connection_id)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingConnections(false)
    }
  }

  async function createConnection() {
    setConnecting(true)
    setError('')
    setMessage('')
    try {
      const usingConnectionUrl = form.connectionMode === 'url'
      const response = await requestJson<ConnectionSummary>('/api/mysql/connections', {
        method: 'POST',
        body: JSON.stringify({
          label: form.label || undefined,
          connection_url: usingConnectionUrl ? form.connectionUrl : undefined,
          host: usingConnectionUrl ? undefined : form.host,
          port: usingConnectionUrl ? undefined : Number(form.port || 3306),
          username: usingConnectionUrl ? undefined : form.username,
          password: usingConnectionUrl ? undefined : form.password,
          database_type: form.databaseType,
          database: usingConnectionUrl ? undefined : form.database || undefined,
          max_connections: Number(form.max_connections || 5),
        }),
      })
      setConnections((current) => [response, ...current.filter((item) => item.connection_id !== response.connection_id)])
      setMessage(`Saved and connected: ${response.label}`)
      await selectConnection(response.connection_id)
      setConnectionModalOpen(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setConnecting(false)
    }
  }

  async function deleteConnection(connectionId: string) {
    setError('')
    setMessage('')
    try {
      await requestJson<void>(`/api/mysql/connections/${connectionId}`, { method: 'DELETE' })
      setConnections((current) => current.filter((connection) => connection.connection_id !== connectionId))
      setDatabasesByConnection((current) => removeKey(current, connectionId))
      if (activeId === connectionId) {
        setActiveId('')
        setSelectedDatabase('')
        setSelectedTable('')
        setTableDetail(null)
      }
      setMessage('Connection removed.')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function selectConnection(connectionId: string) {
    setActiveId(connectionId)
    setSelectedDatabase('')
    setSelectedTable('')
    setTableDetail(null)
    setQueryResult(null)
    setTableFilter('')
    await loadDatabases(connectionId)
  }

  async function loadDatabases(connectionId = activeId) {
    if (!connectionId) return
    setLoadingDatabases(true)
    setError('')
    try {
      const response = await requestJson<DatabasesResponse>(
        `/api/mysql/connections/${connectionId}/databases`,
      )
      setDatabasesByConnection((current) => ({ ...current, [connectionId]: response.databases }))
      setConnections((current) =>
        current.map((connection) =>
          connection.connection_id === connectionId ? { ...connection, connected: true } : connection,
        ),
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingDatabases(false)
    }
  }

  async function selectDatabase(database: string) {
    if (!activeId) return
    setSelectedDatabase(database)
    setSelectedTable('')
    setTableDetail(null)
    setQueryResult(null)
    setTableFilter('')
    setSql(`SELECT *\nFROM \`${database}\`.\`your_table\`\nLIMIT 100;`)
    await loadTables(activeId, database)
  }

  async function loadTables(connectionId: string, database: string) {
    const key = dbKey(connectionId, database)
    setLoadingTablesKey(key)
    setError('')
    try {
      const response = await requestJson<TablesResponse>(
        `/api/mysql/connections/${connectionId}/databases/${encodeURIComponent(database)}/tables`,
      )
      setTablesByDatabase((current) => ({ ...current, [key]: response.tables }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingTablesKey('')
    }
  }

  async function selectTable(table: string) {
    if (!activeId || !selectedDatabase) return
    setSelectedTable(table)
    setTableDetail(null)
    setQueryResult(null)
    setLoadingDetail(true)
    setError('')
    setDetailTab('data')
    setSql(`SELECT *\nFROM \`${selectedDatabase}\`.\`${table}\`\nLIMIT 100;`)
    try {
      const response = await requestJson<TableDetailResponse>(
        `/api/mysql/connections/${activeId}/databases/${encodeURIComponent(selectedDatabase)}/tables/${encodeURIComponent(table)}`,
      )
      setTableDetail(response)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingDetail(false)
    }
  }

  async function executeSql() {
    if (!activeId) {
      setError('Select a connection first.')
      return
    }
    setDetailTab('sql')
    setQuerying(true)
    setError('')
    setMessage('')
    setQueryResult(null)
    try {
      const response = await requestJson<QueryResponse>(
        `/api/mysql/connections/${activeId}/query`,
        {
          method: 'POST',
          body: JSON.stringify({ sql, max_rows: Number(maxRows || 500) }),
        },
      )
      setQueryResult(response)
      setMessage(response.kind === 'rows' ? `Fetched ${response.row_count} row(s).` : `Affected ${response.rows_affected} row(s).`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setQuerying(false)
    }
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        {sidebarCollapsed ? (
          <div className="sidebar-collapsed">
            <button className="icon-button sidebar-toggle" onClick={toggleSidebar} title="Expand sidebar" aria-label="Expand sidebar">
              <ChevronRight size={18} />
            </button>
            <button className="brand-icon" onClick={toggleSidebar} title="Expand sidebar" aria-label="Expand sidebar">
              <Database size={22} />
            </button>
            <button className="icon-button sidebar-toggle" onClick={() => setConnectionModalOpen(true)} title="Add saved connection" aria-label="Add saved connection">
              <Save size={18} />
            </button>
          </div>
        ) : (
          <>
            <div className="brand">
              <div className="brand-icon"><Database size={22} /></div>
              <div>
                <h1>SQL Workbench</h1>
                <span>Saved MySQL browser</span>
              </div>
              <button className="icon-button sidebar-collapse" onClick={toggleSidebar} title="Collapse sidebar" aria-label="Collapse sidebar">
                <ChevronLeft size={18} />
              </button>
            </div>

            <button className="primary-button add-connection-button" onClick={() => setConnectionModalOpen(true)}>
              <Save size={16} />
              Add saved connection
            </button>
          </>
        )}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Database explorer</p>
            <h2>{activeConnection ? activeConnection.label : 'No connection selected'}</h2>
            {activeConnection && (
              <span className="muted">
                {activeConnection.username}@{activeConnection.host}:{activeConnection.port}
                {activeConnection.database ? ` / ${activeConnection.database}` : ''}
                {activeConnection.server_version ? ` · MySQL ${activeConnection.server_version}` : ''}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <label className="max-row-input">
              Max rows
              <input value={maxRows} onChange={(event) => setMaxRows(event.target.value)} />
            </label>
            <button className="secondary-button" onClick={loadConnections}>
              {loadingConnections ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              Refresh
            </button>
          </div>
        </header>

        {(message || error) && (
          <div className={`notice ${error ? 'error' : 'success'}`}>
            {error ? <AlertTriangle size={16} /> : <Activity size={16} />}
            {error || message}
          </div>
        )}

        <div className="browser-grid">
          <section className="panel tree-panel">
            <div className="panel-title space-between">
              <span><Server size={16} /> Connections</span>
              {loadingConnections && <Loader2 className="spin" size={15} />}
            </div>
            <div className="tree-list">
              {connections.length === 0 && <div className="empty-state">No saved connections</div>}
              {connections.map((connection) => (
                <div className="tree-group" key={connection.connection_id}>
                  <div className={`tree-row connection-row ${connection.connection_id === activeId ? 'active' : ''}`}>
                    <button onClick={() => void selectConnection(connection.connection_id)}>
                      <ChevronRight size={14} className={connection.connection_id === activeId ? 'open' : ''} />
                      <span className={`status-dot ${connection.connected ? 'connected' : ''}`} />
                      <span className="tree-main">{connection.label}</span>
                      <span className="tree-sub">{connection.host}:{connection.port}</span>
                    </button>
                    <button className="delete-mini" title="Delete saved connection" onClick={() => void deleteConnection(connection.connection_id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>

                  {connection.connection_id === activeId && (
                    <div className="tree-children">
                      {loadingDatabases && <div className="loading-line"><Loader2 className="spin" size={14} /> Loading databases</div>}
                      {activeDatabases.map((database) => (
                        <div key={database}>
                          <button
                            className={`tree-row db-row ${database === selectedDatabase ? 'active' : ''}`}
                            onClick={() => void selectDatabase(database)}
                          >
                            <Database size={14} />
                            <span className="tree-main">{database}</span>
                          </button>
                          {database === selectedDatabase && (
                            <div className="table-children">
                              {loadingTablesKey === dbKey(activeId, database) && (
                                <div className="loading-line"><Loader2 className="spin" size={14} /> Loading tables</div>
                              )}
                              {activeTables.length > 0 && (
                                <div className="table-filter">
                                  <Search size={13} />
                                  <input
                                    type="search"
                                    value={tableFilter}
                                    onChange={(event) => setTableFilter(event.target.value)}
                                    placeholder="Filter tables"
                                    spellCheck={false}
                                  />
                                </div>
                              )}
                              {filteredTables.map((table) => (
                                <button
                                  key={table.name}
                                  className={`tree-row table-row ${table.name === selectedTable ? 'active' : ''}`}
                                  onClick={() => void selectTable(table.name)}
                                  title={table.comment || table.table_type}
                                >
                                  <Table2 size={14} />
                                  <span className="tree-main">{table.name}</span>
                                  <span className="tree-sub">{formatRows(table.table_rows)}</span>
                                </button>
                              ))}
                              {activeTables.length > 0 && filteredTables.length === 0 && (
                                <div className="empty-state table-filter-empty">No tables match &ldquo;{tableFilter}&rdquo;</div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="detail-column">
            <section className="panel detail-panel">
              <div className="panel-title space-between">
                <span><Table2 size={16} /> Table detail</span>
                {loadingDetail && <Loader2 className="spin" size={15} />}
              </div>
              {!tableDetail && (
                <div className="empty-results">Click a table to view structure and first 100 rows.</div>
              )}
              {tableDetail && (
                <div className="detail-stack">
                  <div className="detail-heading">
                    <div>
                      <h3>{tableDetail.database}.{tableDetail.table}</h3>
                      <span className="muted">{tableDetail.columns.length} columns · sample limit {tableDetail.sample_limit}</span>
                    </div>
                    <button className="secondary-button" onClick={() => void selectTable(tableDetail.table)}>
                      <RefreshCw size={16} /> Reload
                    </button>
                  </div>

                  <div className="detail-tabs" role="tablist" aria-label="Table detail views">
                    <button className={detailTab === 'structure' ? 'active' : ''} onClick={() => setDetailTab('structure')} role="tab" aria-selected={detailTab === 'structure'}>
                      <Table2 size={14} /> Structure
                    </button>
                    <button className={detailTab === 'data' ? 'active' : ''} onClick={() => setDetailTab('data')} role="tab" aria-selected={detailTab === 'data'}>
                      <Database size={14} /> Data
                    </button>
                    <button className={detailTab === 'sql' ? 'active' : ''} onClick={() => setDetailTab('sql')} role="tab" aria-selected={detailTab === 'sql'}>
                      <TerminalSquare size={14} /> SQL
                    </button>
                  </div>

                  <div className="detail-tab-body">
                    {detailTab === 'structure' && (
                      <div className="structure-tab">
                        <StructureTable columns={tableDetail.columns} />
                        <DdlBlock ddl={tableDetail.ddl} />
                      </div>
                    )}
                    {detailTab === 'data' && <RowsTable columns={tableDetail.data_columns} rows={tableDetail.rows} sortable fill />}
                    {detailTab === 'sql' && (
                      <div className="sql-tab">
                        <textarea value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} />
                        <div className="sql-tab-actions">
                          <button className="primary-button compact" onClick={executeSql} disabled={!activeId || querying}>
                            {querying ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                            Run
                          </button>
                        </div>
                        {queryResult?.kind === 'command' && (
                          <div className="command-result inline">
                            <strong>{queryResult.rows_affected}</strong>
                            <span>rows affected in {queryResult.duration_ms} ms</span>
                          </div>
                        )}
                        {queryResult?.kind === 'rows' && (
                          <RowsTable columns={queryResult.columns} rows={queryResult.rows} meta={`${queryResult.row_count} rows · ${queryResult.duration_ms} ms${queryResult.limited ? ' · limited' : ''}`} sortable />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          </section>
        </div>
      </section>

      {connectionModalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !connecting) {
              setConnectionModalOpen(false)
            }
          }}
        >
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title">
            <div className="modal-header">
              <div>
                <p className="eyebrow">New saved connection</p>
                <h3 id="connection-dialog-title">Add MySQL connection</h3>
                <span className="muted">Connection details are saved locally for this service.</span>
              </div>
              <button className="icon-button" onClick={() => setConnectionModalOpen(false)} disabled={connecting} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <form
              className="modal-form"
              onSubmit={(event) => {
                event.preventDefault()
                void createConnection()
              }}
            >
              <div className="connection-mode-toggle" role="tablist" aria-label="Connection input mode">
                <button
                  type="button"
                  className={form.connectionMode === 'fields' ? 'active' : ''}
                  onClick={() => updateForm('connectionMode', 'fields')}
                >
                  Fields
                </button>
                <button
                  type="button"
                  className={form.connectionMode === 'url' ? 'active' : ''}
                  onClick={() => updateForm('connectionMode', 'url')}
                >
                  URL
                </button>
              </div>

              <div className="field-grid">
                <label>
                  Label
                  <input value={form.label} onChange={(event) => updateForm('label', event.target.value)} />
                </label>
                <label>
                  Database type
                  <select value={form.databaseType} onChange={(event) => updateForm('databaseType', event.target.value)}>
                    <option value="mysql">MySQL</option>
                  </select>
                </label>

                {form.connectionMode === 'url' ? (
                  <>
                    <label className="full-span">
                      Connection URL
                      <textarea
                        className="connection-url-input"
                        value={form.connectionUrl}
                        onChange={(event) => updateForm('connectionUrl', event.target.value)}
                        placeholder="mysql://root:password@127.0.0.1:3306/app_db"
                        required
                        spellCheck={false}
                      />
                    </label>
                    <p className="form-hint full-span">
                      Supports mysql://user:password@host:port/db and jdbc:mysql://host:port/db?user=root&amp;password=secret.
                    </p>
                  </>
                ) : (
                  <>
                    <label>
                      Host
                      <input value={form.host} onChange={(event) => updateForm('host', event.target.value)} />
                    </label>
                    <label>
                      Port
                      <input value={form.port} onChange={(event) => updateForm('port', event.target.value)} />
                    </label>
                    <label>
                      User
                      <input value={form.username} onChange={(event) => updateForm('username', event.target.value)} />
                    </label>
                    <label>
                      Password
                      <input
                        value={form.password}
                        onChange={(event) => updateForm('password', event.target.value)}
                        type="password"
                        autoComplete="current-password"
                      />
                    </label>
                    <label>
                      Default DB
                      <input
                        value={form.database}
                        onChange={(event) => updateForm('database', event.target.value)}
                        placeholder="optional"
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setConnectionModalOpen(false)} disabled={connecting}>
                  Cancel
                </button>
                <button className="primary-button compact" type="submit" disabled={connecting}>
                  {connecting ? <Loader2 className="spin" size={16} /> : <PlugZap size={16} />}
                  Save & connect
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  )
}

function StructureTable({ columns, fill = false }: { columns: TableColumn[]; fill?: boolean }) {
  return (
    <div className={`table-wrap small ${fill ? 'fill' : ''}`}>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Null</th>
            <th>Key</th>
            <th>Default</th>
            <th>Extra</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.name}>
              <td>{column.name}</td>
              <td>{column.column_type}</td>
              <td>{column.nullable ? 'YES' : 'NO'}</td>
              <td>{column.key || '-'}</td>
              <td>{column.default_value ?? <span className="null-value">NULL</span>}</td>
              <td>{column.extra || '-'}</td>
              <td>{column.comment || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DdlBlock({ ddl }: { ddl?: string | null }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!ddl) return
    try {
      await navigator.clipboard.writeText(ddl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="ddl-block">
      <div className="ddl-header">
        <h4>Create Table</h4>
        {ddl && (
          <button className="secondary-button compact" type="button" onClick={copy}>
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {ddl ? (
        <pre className="ddl-pre"><code>{ddl}</code></pre>
      ) : (
        <div className="empty-results">DDL not available</div>
      )}
    </div>
  )
}

type SortDirection = 'asc' | 'desc'

type SortState = {
  column: string
  direction: SortDirection
} | null

function RowsTable({
  columns,
  rows,
  meta,
  sortable = false,
  fill = false,
}: {
  columns: ColumnInfo[]
  rows: Array<Record<string, unknown>>
  meta?: string
  sortable?: boolean
  fill?: boolean
}) {
  const [sortState, setSortState] = useState<SortState>(null)
  const displayColumns = useMemo(
    () => (columns.length ? columns : Object.keys(rows[0] ?? {}).map((name) => ({ name, type_name: 'unknown' }))),
    [columns, rows],
  )
  const sortedRows = useMemo(() => {
    if (!sortState || !displayColumns.some((column) => column.name === sortState.column)) {
      return rows
    }

    const directionMultiplier = sortState.direction === 'asc' ? 1 : -1
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const comparison = compareCellValues(left.row[sortState.column], right.row[sortState.column])
        return comparison === 0 ? left.index - right.index : comparison * directionMultiplier
      })
      .map(({ row }) => row)
  }, [displayColumns, rows, sortState])

  const toggleSort = (columnName: string) => {
    setSortState((current) => {
      if (!current || current.column !== columnName) return { column: columnName, direction: 'asc' }
      if (current.direction === 'asc') return { column: columnName, direction: 'desc' }
      return null
    })
  }

  return (
    <div className={`table-wrap ${fill ? 'fill' : ''}`}>
      {meta && <div className="result-meta"><span>{meta}</span></div>}
      {rows.length === 0 ? (
        <div className="empty-results">No rows</div>
      ) : (
        <table>
          <thead>
            <tr>
              {displayColumns.map((column) => {
                const activeDirection = sortState?.column === column.name ? sortState.direction : null
                return (
                  <th key={column.name} title={column.type_name}>
                    <div className="th-content">
                      <span>{column.name}</span>
                      {sortable && (
                        <button
                          className={`sort-button ${activeDirection ? 'active' : ''}`}
                          type="button"
                          onClick={() => toggleSort(column.name)}
                          title="Toggle sort: default → ascending → descending"
                          aria-label={`Toggle sort for ${column.name}`}
                        >
                          {activeDirection === 'asc' ? '↑' : activeDirection === 'desc' ? '↓' : '↕'}
                        </button>
                      )}
                    </div>
                    <small>{column.type_name}</small>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {displayColumns.map((column) => (
                  <td key={column.name}>{formatCell(row[column.name])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new Error(payload?.error || response.statusText)
  }

  return payload as T
}

function removeKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record }
  delete next[key]
  return next
}

function dbKey(connectionId: string, database: string) {
  return `${connectionId}:${database}`
}

function formatRows(value?: number | null) {
  if (value === null || value === undefined) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function compareCellValues(left: unknown, right: unknown) {
  if (left === right) return 0
  if (left === null || left === undefined) return 1
  if (right === null || right === undefined) return -1

  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right)

  const leftDate = typeof left === 'string' ? Date.parse(left) : Number.NaN
  const rightDate = typeof right === 'string' ? Date.parse(right) : Number.NaN
  if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) return leftDate - rightDate

  const leftNumber = typeof left === 'string' && left.trim() !== '' ? Number(left) : Number.NaN
  const rightNumber = typeof right === 'string' && right.trim() !== '' ? Number(right) : Number.NaN
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber - rightNumber

  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return <span className="null-value">NULL</span>
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export default App
