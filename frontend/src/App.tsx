import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  Search,
  Server,
  Settings,
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
  archery_env?: string | null
  archery_db_name?: string | null
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

type ConnectionMode = 'fields' | 'url' | 'archery'
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
  archeryEnv: string
  archeryDbName: string
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
  archeryEnv: 'uat-cn',
  archeryDbName: 'wms',
  max_connections: '5',
}

const starterSql = `SELECT
  DATABASE() AS current_database,
  VERSION() AS mysql_version,
  NOW() AS server_time;`

const archeryStarterSql = `SELECT
  NOW() AS server_time,
  DATABASE() AS current_database;

-- WMS Archery uses camelCase columns, e.g. warehouseCode / leadingSts.
-- Add LIMIT for safer UAT/PRO exploration.`

const archeryEnvironmentLabels: Record<string, string> = {
  'uat-cn': 'UAT CN · cwh-uat-wms-polarx',
  'uat-sea': 'UAT SEA · cwhsea-uat-wms-polarx',
  'pro-cn': 'PRO CN · pro-cwh-wms-mysql',
  'pro-sea': 'PRO SEA · cwhsea-pro-wms-mysql',
}

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
  const [view, setView] = useState<'workspace' | 'settings'>('workspace')
  const [connectionsCollapsed, setConnectionsCollapsed] = useState<boolean>(
    () => localStorage.getItem('sql-workbench-connections-collapsed') === '1',
  )
  const [cacheTtlMinutes, setCacheTtlMinutes] = useState(() => localStorage.getItem('sql-workbench-cache-ttl-minutes') || '60')
  const [sampleLimit, setSampleLimit] = useState(() => localStorage.getItem('sql-workbench-sample-limit') || '50')
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

  const cacheQuery = (refresh = false, sampleLimitOverride?: number) => {
    const ttl = Number(cacheTtlMinutes || 60)
    const params = new URLSearchParams()
    if (refresh) params.set('refresh', '1')
    if (Number.isFinite(ttl) && ttl > 0) params.set('cache_ttl_minutes', String(Math.round(ttl)))
    if (sampleLimitOverride !== undefined && Number.isFinite(sampleLimitOverride) && sampleLimitOverride > 0) {
      params.set('sample_limit', String(Math.round(sampleLimitOverride)))
    }
    const text = params.toString()
    return text ? `?${text}` : ''
  }

  const updateCacheTtlMinutes = (value: string) => {
    setCacheTtlMinutes(value)
    localStorage.setItem('sql-workbench-cache-ttl-minutes', value)
  }

  const updateSampleLimit = (value: string) => {
    setSampleLimit(value)
    localStorage.setItem('sql-workbench-sample-limit', value)
  }

  const toggleConnectionsCollapsed = () => {
    setConnectionsCollapsed((current) => {
      const next = !current
      localStorage.setItem('sql-workbench-connections-collapsed', next ? '1' : '0')
      return next
    })
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
      const usingArchery = form.connectionMode === 'archery'
      const response = await requestJson<ConnectionSummary>('/api/mysql/connections', {
        method: 'POST',
        body: JSON.stringify({
          label: form.label || undefined,
          connection_url: usingConnectionUrl ? form.connectionUrl : undefined,
          host: usingConnectionUrl || usingArchery ? undefined : form.host,
          port: usingConnectionUrl || usingArchery ? undefined : Number(form.port || 3306),
          username: usingConnectionUrl || usingArchery ? undefined : form.username,
          password: usingConnectionUrl || usingArchery ? undefined : form.password,
          database_type: usingArchery ? 'archery' : form.databaseType,
          database: usingConnectionUrl ? undefined : usingArchery ? form.archeryDbName || 'wms' : form.database || undefined,
          archery_env: usingArchery ? form.archeryEnv : undefined,
          archery_db_name: usingArchery ? form.archeryDbName || 'wms' : undefined,
          max_connections: usingArchery ? 1 : Number(form.max_connections || 5),
        }),
      })
      setConnections((current) => [response, ...current.filter((item) => item.connection_id !== response.connection_id)])
      setMessage(`Saved and connected: ${response.label}`)
      await selectConnection(response.connection_id, response)
      setView('workspace')
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

  async function selectConnection(connectionId: string, knownConnection?: ConnectionSummary) {
    const connection = knownConnection ?? connections.find((item) => item.connection_id === connectionId) ?? null
    setActiveId(connectionId)
    setSelectedDatabase('')
    setSelectedTable('')
    setTableDetail(null)
    setQueryResult(null)
    setTableFilter('')
    setDetailTab('data')
    if (connection?.database_type === 'archery') {
      setSql(archeryStarterSql)
    }
    const databases = await loadDatabases(connectionId)
    if (connection?.database_type === 'archery' && databases[0]) {
      setSelectedDatabase(databases[0])
      setSql(`SELECT *\nFROM \`${databases[0]}\`.\`your_table\`\nLIMIT 100;`)
      await loadTables(connectionId, databases[0])
    }
  }

  async function loadDatabases(connectionId = activeId): Promise<string[]> {
    if (!connectionId) return []
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
      return response.databases
    } catch (cause) {
      setError(errorMessage(cause))
      return []
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
    if (activeConnection?.database_type === 'archery') {
      setDetailTab('data')
      setSql(`SELECT *\nFROM \`${database}\`.\`your_table\`\nLIMIT 100;`)
      await loadTables(activeId, database)
      return
    }
    setSql(`SELECT *\nFROM \`${database}\`.\`your_table\`\nLIMIT 100;`)
    await loadTables(activeId, database)
  }

  async function loadTables(connectionId: string, database: string, refresh = false) {
    const key = dbKey(connectionId, database)
    setLoadingTablesKey(key)
    setError('')
    try {
      const path = `/api/mysql/connections/${connectionId}/databases/${encodeURIComponent(database)}/tables${cacheQuery(refresh)}`
      const response = await requestJson<TablesResponse>(path)
      setTablesByDatabase((current) => ({ ...current, [key]: response.tables }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingTablesKey('')
    }
  }

  async function selectTable(table: string, refresh = false) {
    if (!activeId || !selectedDatabase) return
    setSelectedTable(table)
    setTableDetail(null)
    setQueryResult(null)
    setLoadingDetail(true)
    setError('')
    setDetailTab('data')
    setSql(`SELECT *\nFROM \`${selectedDatabase}\`.\`${table}\`\nLIMIT ${sampleLimit || 50};`)
    try {
      const path = `/api/mysql/connections/${activeId}/databases/${encodeURIComponent(selectedDatabase)}/tables/${encodeURIComponent(table)}${cacheQuery(refresh, Number(sampleLimit || 50))}`
      const response = await requestJson<TableDetailResponse>(path)
      setTableDetail(response)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingDetail(false)
    }
  }

  async function refreshCurrentView() {
    setMessage('')
    await loadConnections()
    if (activeId && selectedDatabase) {
      await loadTables(activeId, selectedDatabase, true)
    }
    if (selectedTable) {
      await selectTable(selectedTable, true)
    }
    setMessage(selectedDatabase || selectedTable ? 'Refreshed latest data.' : 'Connections refreshed.')
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
            <button className="icon-button sidebar-toggle" onClick={() => setView('settings')} title="Open settings" aria-label="Open settings">
              <Settings size={18} />
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

            <section className="sidebar-connections" aria-label="Saved database connections">
              <button
                className="sidebar-section-title sidebar-section-toggle"
                type="button"
                onClick={toggleConnectionsCollapsed}
                aria-expanded={!connectionsCollapsed}
              >
                <span><Server size={14} /> Saved connections</span>
                {loadingConnections ? <Loader2 className="spin" size={14} /> : <ChevronRight size={14} className={connectionsCollapsed ? '' : 'open'} />}
              </button>
              {!connectionsCollapsed && (
                <div className="sidebar-connection-list">
                  {connections.length === 0 && <div className="empty-state sidebar-empty">No saved connections yet</div>}
                  {connections.map((connection) => (
                    <div className={`sidebar-connection-row ${connection.connection_id === activeId ? 'active' : ''}`} key={connection.connection_id}>
                      <button
                        className="sidebar-connection-card"
                        onClick={() => void selectConnection(connection.connection_id)}
                        title={connectionSubtitle(connection)}
                      >
                        <span className={`status-dot ${connection.connected ? 'connected' : ''}`} />
                        <span className="sidebar-connection-text">
                          <span className="sidebar-connection-name">{connection.label}</span>
                          <span className="sidebar-connection-subtitle">{connectionSubtitle(connection)}</span>
                        </span>
                      </button>
                      <button className="delete-mini sidebar-delete" title="Delete saved connection" onClick={() => void deleteConnection(connection.connection_id)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="sidebar-settings" aria-label="Settings">
              <button
                className={`sidebar-settings-toggle ${view === 'settings' ? 'active' : ''}`}
                type="button"
                onClick={() => setView('settings')}
              >
                <span><Settings size={14} /> Settings</span>
                <ChevronRight size={14} />
              </button>
            </section>
          </>
        )}
      </aside>

      <section className="workspace">
        {view === 'settings' ? (
          <SettingsPage
            onBack={() => setView('workspace')}
            cacheTtlMinutes={cacheTtlMinutes}
            updateCacheTtlMinutes={updateCacheTtlMinutes}
            sampleLimit={sampleLimit}
            updateSampleLimit={updateSampleLimit}
            form={form}
            updateForm={updateForm}
            connecting={connecting}
            createConnection={createConnection}
            error={error}
            message={message}
          />
        ) : (
          <>
        <header className="topbar">
          <div>
            <p className="eyebrow">Database explorer</p>
            <h2>{activeConnection ? activeConnection.label : 'No connection selected'}</h2>
            {activeConnection && (
              <span className="muted">
                {connectionSubtitle(activeConnection)}
                {activeConnection.server_version ? ` · ${activeConnection.server_version}` : ''}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <label className="max-row-input">
              Max rows
              <input value={maxRows} onChange={(event) => setMaxRows(event.target.value)} />
            </label>
            <button className="secondary-button" onClick={() => void refreshCurrentView()}>
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
              <span><Database size={16} /> Databases & tables</span>
              {loadingDatabases && <Loader2 className="spin" size={15} />}
            </div>
            <div className="tree-list">
              {!activeConnection && <div className="empty-state">Select a saved connection from the left sidebar.</div>}
              {activeConnection && activeDatabases.length === 0 && !loadingDatabases && <div className="empty-state">No databases loaded</div>}
              {activeConnection && activeDatabases.map((database) => (
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
                    <button className="secondary-button" onClick={() => void selectTable(tableDetail.table, true)}>
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
          </>
        )}
      </section>
    </main>
  )
}

function SettingsPage({
  onBack,
  cacheTtlMinutes,
  updateCacheTtlMinutes,
  sampleLimit,
  updateSampleLimit,
  form,
  updateForm,
  connecting,
  createConnection,
  error,
  message,
}: {
  onBack: () => void
  cacheTtlMinutes: string
  updateCacheTtlMinutes: (value: string) => void
  sampleLimit: string
  updateSampleLimit: (value: string) => void
  form: ConnectForm
  updateForm: <Key extends keyof ConnectForm>(key: Key, value: ConnectForm[Key]) => void
  connecting: boolean
  createConnection: () => Promise<void>
  error: string
  message: string
}) {
  return (
    <div className="settings-page">
      <header className="settings-header">
        <button className="secondary-button" type="button" onClick={onBack}>
          <ChevronLeft size={16} /> Back
        </button>
        <div>
          <p className="eyebrow">SQL Workbench</p>
          <h2>Settings</h2>
        </div>
      </header>

      {(error || message) && (
        <div className={`notice ${error ? 'error' : 'success'}`}>
          {error ? <AlertTriangle size={16} /> : <Activity size={16} />}
          {error || message}
        </div>
      )}

      <div className="settings-sections">
        <section className="settings-section">
          <h3>Preferences</h3>
          <label>
            Metadata cache (minutes)
            <input
              type="number"
              min="1"
              value={cacheTtlMinutes}
              onChange={(event) => updateCacheTtlMinutes(event.target.value)}
            />
          </label>
          <p className="form-hint">Caches table names and table structure only. SQL query results are not cached.</p>
          <label>
            Default sample rows
            <input
              type="number"
              min="1"
              value={sampleLimit}
              onChange={(event) => updateSampleLimit(event.target.value)}
            />
          </label>
          <p className="form-hint">Number of rows shown in the Data tab when clicking a table. Default: 50.</p>
        </section>

        <section className="settings-section">
          <h3>Add saved connection</h3>
          <p className="form-hint">MySQL credentials or Archery platform settings are saved locally for this service.</p>
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
              <button
                type="button"
                className={form.connectionMode === 'archery' ? 'active' : ''}
                onClick={() => {
                  updateForm('connectionMode', 'archery')
                  updateForm('label', form.label === 'Local MySQL' ? 'WMS Archery UAT CN' : form.label)
                }}
              >
                Archery Platform
              </button>
            </div>

            <div className="field-grid">
              <label>
                Label
                <input value={form.label} onChange={(event) => updateForm('label', event.target.value)} />
              </label>
              {form.connectionMode !== 'archery' && (
                <label>
                  Database type
                  <select value={form.databaseType} onChange={(event) => updateForm('databaseType', event.target.value)}>
                    <option value="mysql">MySQL</option>
                  </select>
                </label>
              )}

              {form.connectionMode === 'archery' ? (
                <>
                  <label>
                    Environment
                    <select value={form.archeryEnv} onChange={(event) => updateForm('archeryEnv', event.target.value)}>
                      {Object.entries(archeryEnvironmentLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default DB
                    <input value={form.archeryDbName} onChange={(event) => updateForm('archeryDbName', event.target.value)} placeholder="wms" />
                  </label>
                  <p className="form-hint full-span">
                    Uses backend Archery credentials from the local environment. SQL Workbench enforces read-only execution for Archery connections.
                  </p>
                </>
              ) : form.connectionMode === 'url' ? (
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
              <button className="primary-button compact" type="submit" disabled={connecting}>
                {connecting ? <Loader2 className="spin" size={16} /> : <PlugZap size={16} />}
                Save & connect
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
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

  // Split layout: a frozen header region, a horizontal scrollbar proxy placed right
  // below the header, and a vertically scrolling body region. The header and body are
  // separate tables, so column widths are measured from the body (auto layout) and
  // applied to both via a shared <colgroup> to keep them aligned. Horizontal scrolling
  // is driven by the proxy (between header and first row) so users no longer have to
  // reach the bottom of the table to drag the horizontal scrollbar.
  const headerTableRef = useRef<HTMLTableElement | null>(null)
  const bodyTableRef = useRef<HTMLTableElement | null>(null)
  const bodyRegionRef = useRef<HTMLDivElement | null>(null)
  const proxyRef = useRef<HTMLDivElement | null>(null)
  const contentWidthRef = useRef(0)
  const colWidthsRef = useRef<number[]>([])
  const [colWidths, setColWidths] = useState<number[]>([])
  const [contentWidth, setContentWidth] = useState(0)
  const [overflowing, setOverflowing] = useState(false)

  const applyScroll = useCallback((scrollLeft: number) => {
    const transform = `translateX(${-scrollLeft}px)`
    if (headerTableRef.current) headerTableRef.current.style.transform = transform
    if (bodyTableRef.current) bodyTableRef.current.style.transform = transform
  }, [])

  // Natural (content-driven) column widths, measured once per column/row set. Stored
  // in a ref so resize can re-derive display widths without re-reading the DOM (which
  // would require falling back to auto layout and cause a flash).
  const naturalWidthsRef = useRef<number[]>([])

  // Derive display column widths from the measured natural widths and the current
  // viewport. When content overflows, natural pixel widths are used so the proxy can
  // scroll the full content. When content fits, columns are scaled proportionally to
  // fill the viewport, matching the previous full-width table appearance.
  const applyWidths = useCallback(() => {
    const bodyRegion = bodyRegionRef.current
    if (!bodyRegion) return
    const natural = naturalWidthsRef.current
    const total = contentWidthRef.current
    const clientWidth = bodyRegion.clientWidth
    const overflow = total > clientWidth
    let widths: number[]
    let tableWidth: number
    if (overflow) {
      widths = natural
      tableWidth = total
    } else if (total > 0) {
      const scale = clientWidth / total
      widths = natural.map((width) => width * scale)
      tableWidth = clientWidth
    } else {
      widths = []
      tableWidth = 0
    }
    colWidthsRef.current = widths
    setColWidths(widths)
    setContentWidth(tableWidth)
    setOverflowing(overflow)
  }, [])

  const measure = useCallback(() => {
    const headerTable = headerTableRef.current
    const bodyTable = bodyTableRef.current
    if (!headerTable || !bodyTable) return
    const headerRow = headerTable.tHead?.rows[0]
    const bodyRow = bodyTable.tBodies[0]?.rows[0]
    if (!headerRow || !bodyRow) return
    const count = headerRow.cells.length
    const widths: number[] = []
    let total = 0
    for (let index = 0; index < count; index += 1) {
      const headerWidth = headerRow.cells[index].getBoundingClientRect().width
      const bodyWidth = bodyRow.cells[index]?.getBoundingClientRect().width ?? 0
      const width = Math.max(headerWidth, bodyWidth)
      widths.push(width)
      total += width
    }
    naturalWidthsRef.current = widths
    contentWidthRef.current = total
    applyWidths()
    // New data: reset any horizontal scroll so the table starts at the left edge.
    if (proxyRef.current) proxyRef.current.scrollLeft = 0
    applyScroll(0)
  }, [applyWidths, applyScroll])

  // Re-measure whenever the column set or row data changes. On the first pass the
  // tables are already in auto layout, so widths can be read synchronously before
  // paint. After data changes the previous locked widths must be cleared first so
  // natural widths can be re-read on the next frame.
  useLayoutEffect(() => {
    if (colWidthsRef.current.length === 0) {
      measure()
      return
    }
    colWidthsRef.current = []
    setColWidths([])
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [displayColumns, rows, measure])

  // Re-measure once webfonts are ready (natural widths can shift after font swap).
  useEffect(() => {
    if (!document.fonts?.ready) return
    let cancelled = false
    document.fonts.ready.then(() => {
      if (cancelled) return
      colWidthsRef.current = []
      setColWidths([])
      requestAnimationFrame(measure)
    })
    return () => {
      cancelled = true
    }
  }, [measure])

  // On resize, natural widths are unchanged; just re-derive display widths (toggling
  // between fill-mode scaling and overflow scrolling) without re-reading the DOM, so
  // the user's horizontal scroll position is preserved while overflow is active.
  useEffect(() => {
    const bodyRegion = bodyRegionRef.current
    if (!bodyRegion) return
    const observer = new ResizeObserver(() => applyWidths())
    observer.observe(bodyRegion)
    return () => observer.disconnect()
  }, [applyWidths])

  // When content no longer overflows (proxy is hidden), drop any leftover horizontal
  // shift so the table is not left translated after a resize.
  useEffect(() => {
    if (overflowing) return
    if (proxyRef.current) proxyRef.current.scrollLeft = 0
    applyScroll(0)
  }, [overflowing, applyScroll])

  const onProxyScroll = (event: React.UIEvent<HTMLDivElement>) => {
    applyScroll(event.currentTarget.scrollLeft)
  }

  const onBodyWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaX !== 0 && proxyRef.current) {
      proxyRef.current.scrollLeft += event.deltaX
    }
  }

  const locked = colWidths.length > 0
  const tableStyle = locked
    ? { tableLayout: 'fixed' as const, width: contentWidth }
    : { width: 'auto' as const }
  const colgroup = locked ? (
    <colgroup>
      {colWidths.map((width, index) => (
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  ) : null

  const renderHeader = () => (
    <table ref={headerTableRef} style={tableStyle}>
      {colgroup}
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
    </table>
  )

  return (
    <div className={`rows-split ${fill ? 'fill' : ''}`}>
      {meta && <div className="result-meta"><span>{meta}</span></div>}
      {rows.length === 0 ? (
        <div className="empty-results">No rows</div>
      ) : (
        <>
          <div className="rows-header-region">{renderHeader()}</div>
          {overflowing && (
            <div className="rows-hscroll" ref={proxyRef} onScroll={onProxyScroll}>
              <div className="rows-hscroll-spacer" style={{ width: contentWidth }} />
            </div>
          )}
          <div className="rows-body-region" ref={bodyRegionRef} onWheel={onBodyWheel}>
            <table ref={bodyTableRef} style={tableStyle}>
              {colgroup}
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
          </div>
        </>
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

function connectionSubtitle(connection: ConnectionSummary) {
  if (connection.database_type === 'archery') {
    const env = connection.archery_env || connection.username || 'archery'
    const db = connection.archery_db_name || connection.database || 'wms'
    return `Archery · ${env} / ${db}`
  }

  return `${connection.username}@${connection.host}:${connection.port}${connection.database ? ` / ${connection.database}` : ''}`
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
