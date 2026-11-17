'use strict'

// The sidebar, Worlds, one world's mods, Settings and notifications. library.js holds the Mod Library page.
// Every decision about mods is made by the engine. This file shows the answers and sends back what was clicked.

const PAGES = {
  library: ['Mod Library', 'Every mod you have, in one folder, and where it is used'],
  worlds: ['Worlds', 'Load, clone, rename and delete worlds, load backups, and choose what the server hosts'],
  mods: ['World mods', 'The packs one world uses, their load order and compatibility'],
  server: ['Server', 'The Minecraft server and who is online'],
  xbox: ['Bedrock Console Bridge', 'Lets friends on Xbox, PlayStation and Switch join from their Friends list'],
  console: ['Console', 'Live logs, server commands and the Content Log'],
  settings: ['Settings', '']
}
const THEMES = [['Blue', '#3d8bfd'], ['Cyan', '#22b8cf'], ['Emerald', '#2fbf71'], ['Gold', '#e0a030'], ['Orange', '#f0883e'], ['Rose', '#e9547e'], ['Violet', '#8b6cf0'], ['Slate', '#7d8ba3']]

const ui = {
  page: 'server',
  engineReady: false,
  config: null,
  worlds: [],
  world: '',
  mods: [],
  ticked: new Set(),
  scanIssues: [],
  icons: new Map(),
  analysis: null,
  manualOrder: null,
  orderPick: null,
  updateCount: 0,
  updatePick: new Set(),
  updateFocus: null,
  editor: null,
  editorFolder: null,
  editorPick: null,
  notes: [],
  scanning: false,
  loaded: false
}

/* Small helpers */

function h (tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn)
    else if (key === 'data') Object.assign(node.dataset, value)
    else if (key in node) node[key] = value
    else node.setAttribute(key, value)
  }
  node.append(...kids.flat().filter((kid) => kid !== null && kid !== undefined && kid !== false))
  return node
}

function say (text) { setText($('#status-text'), text) }
const uniq = (list) => [...new Set(list)]
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const hexShade = (hex, k = 0.78) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')

// One engine call. Failures land in the status bar and the notification list, and the caller gets null.
async function ask (method, params, { quiet = false } = {}) {
  const answer = await api.mods(method, params)
  if (answer.ok) return answer.result
  if (!quiet) { say(answer.error); notify('Something went wrong', answer.error, 'err') }
  return null
}

function setAccent (color) {
  const root = document.documentElement.style
  root.setProperty('--accent', color)
  root.setProperty('--accent-d', hexShade(color))
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  root.setProperty('--on-accent', (r * 299 + g * 587 + b * 114) / 1000 > 165 ? '#14171c' : '#ffffff')
}

/* Pages and sidebar */

function show (page) {
  ui.page = page
  for (const [key, [title, sub]] of Object.entries(PAGES)) {
    $(`#page-${key}`).hidden = key !== page
    $(`.nav-item[data-page="${key}"]`)?.classList.toggle('on', key === page || (key === 'worlds' && page === 'mods'))
    if (key === page) { setText($('#page-title'), title); setText($('#page-sub'), sub) }
  }
  $('#content').scrollTop = 0
  try { localStorage.setItem('hub-page', page === 'mods' ? 'worlds' : page) } catch {}
  if (page === 'console') els.log.scrollTop = els.log.scrollHeight
  if (page === 'worlds' && ui.engineReady) { refreshWorlds(); refreshBackups() }
}
window.hubShow = show

for (const item of document.querySelectorAll('.nav-item')) item.addEventListener('click', () => show(item.dataset.page))

function setCollapsed (collapsed, save = true) {
  $('#side').classList.toggle('collapsed', collapsed)
  $('#side-toggle').innerHTML = collapsed ? '&raquo;' : '&laquo;'
  $('#side-toggle').title = `${collapsed ? 'Expand' : 'Collapse'} the sidebar (Ctrl+B)`
  if (save && ui.engineReady) setConfig('sidebar_collapsed', collapsed)
}
$('#side-toggle').addEventListener('click', () => setCollapsed(!$('#side').classList.contains('collapsed')))

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'b') { event.preventDefault(); setCollapsed(!$('#side').classList.contains('collapsed')) }
  if (event.key === 'Escape') toggleNc(false)
})

$('#manage-worlds').addEventListener('click', () => show('worlds'))
$('#manage-mods').addEventListener('click', () => {
  const hosted = latest?.settings.world.name
  if (hosted) openWorldMods(hosted)
})
$('#mods-back').addEventListener('click', () => show('worlds'))
$('#link-xbox').addEventListener('click', () => show('xbox'))
$('#link-library').addEventListener('click', () => show('library'))
$('#link-world').addEventListener('click', () => {
  const hosted = latest?.settings.world.name
  if (hosted) openWorldMods(hosted)
  else show('worlds')
})

// One world's packs, load order and compatibility
async function openWorldMods (folder, view = 'packs') {
  await selectWorld(folder)
  await openEditor(folder)
  setModsView(view)
  show('mods')
}
window.hubOpenWorldMods = openWorldMods

/* Called with every state update from the main process */

window.hubRender = (state) => {
  const ready = state.engine.ready
  if (ready !== ui.engineReady) {
    ui.engineReady = ready
    if (ready) startMods()
  }
  for (const id of ['#worlds-engine', '#mods-engine', '#settings-engine', '#library-engine']) {
    const node = $(id)
    node.hidden = ready
    if (!ready) setText(node, state.engine.error ? `Worlds and mods aren't available. ${state.engine.error} Install it from python.org, tick "Add python.exe to PATH", then open Bedrock Hub again. The server and console still work.` : 'Starting the mod tools.')
  }
  $('#restart-banner').hidden = !state.restartNeeded
  $('#restart-apply').disabled = state.busy !== null || state.modsBusy
  $('#busy-meter').hidden = !(state.modsBusy || ui.scanning)
  const blocked = state.busy !== null || state.modsBusy
  for (const id of ['#act-add', '#act-remove', '#act-install', '#act-uninstall', '#update-selected', '#update-all', '#order-save', '#world-import-file', '#world-import-folder', '#editor-save', '#editor-restore']) $(id).disabled = blocked
  renderAbout(state)
  renderLinks(state)
  // The hosted world can change from a restart or the server's own files
  const hosted = state.settings.world.name
  if (hosted !== ui.lastHosted) {
    ui.lastHosted = hosted
    if (ui.worlds.length) { renderWorlds(); renderWorldChoice() }
  }
  watchServer(state)
}

$('#restart-apply').addEventListener('click', async () => {
  const result = await api.restartServer()
  if (!result.ok) showMessage(result.error)
})

// How the parts relate, on the Server page and the Xbox page
function renderLinks (state) {
  const bridge = state.services.bridge.state === 'running'
  const tag = state.bridge.account?.gamertag || state.account.gamertag
  setText($('#link-xbox-text'), bridge ? (state.bridge.lamp === 'lit' ? `Online as ${tag || 'your account'}` : state.bridge.headline) : (tag ? `Off. Last signed in as ${tag}` : 'Off, not signed in'))
  const world = state.settings.world.hosting ? (state.worldInfo?.levelName || state.settings.world.name) : ''
  const active = ui.worlds.find((w) => w.folder === state.settings.world.name)
  setText($('#link-world-text'), world ? `${world}${active ? `, ${plural(active.behavior + active.resource, 'pack')}` : ''}` : 'None chosen')
  const mods = lib.view?.mods || []
  const waiting = mods.filter((m) => m.fresh || m.behind.length).length
  setText($('#link-library-text'), !state.engine.ready ? 'Not available' : waiting ? `${plural(mods.length, 'mod')}, ${waiting} need a look` : plural(mods.length, 'mod'))
  setText($('#badge-xbox'), state.friends?.requests.length ? String(state.friends.requests.length) : '')
  $('#badge-xbox').classList.toggle('alert', Boolean(state.friends?.requests.length))
}

function watchServer (state) {
  const now = state.services.server.state
  if (ui.lastServer && now !== ui.lastServer && now === 'crashed') {
    notify('The Minecraft server stopped', state.services.lastError || 'See the Console.', 'err', 'console')
  }
  ui.lastServer = now
}

/* Starting up */

async function startMods () {
  const config = await ask('config')
  if (!config) return
  applyConfig(config)
  ui.ticked = new Set()
  await refreshWorlds()
  if (config.scan_on_startup) await rescan()
  else { await refreshMods(); await refreshLib(); say('Library scan on startup is off. Press Rescan on the Library page.') }
}

function applyConfig (config) {
  ui.config = config
  if (/^#[0-9a-fA-F]{6}$/.test(config.accent)) setAccent(config.accent)
  if (!ui.loaded) {
    ui.loaded = true
    setCollapsed(Boolean(config.sidebar_collapsed), false)
    ui.notes = Array.isArray(config.notifications) ? config.notifications.filter((n) => n && typeof n === 'object').slice(0, 60) : []
    renderNc()
  }
  renderSettings()
  renderProfiles()
  $('#mods-sort').value = config.sort || 'Name'
}

async function setConfig (key, value) {
  const config = await ask('config.set', { key, value })
  if (config) ui.config = config
  return config
}

/* Worlds */

async function refreshWorlds () {
  const result = await ask('worlds')
  if (!result) return
  ui.worlds = result.worlds
  ui.world = result.selected
  renderWorlds()
  renderWorldChoice()
}

function worldFacts (world) {
  const bits = [world.mode, world.difficulty, world.version && `Version ${world.version}`].filter(Boolean)
  return bits.join(' / ')
}

function renderWorlds () {
  const hosted = latest?.settings.world.name
  const running = latest && latest.services.server.state !== 'off' && latest.services.server.state !== 'crashed'
  setText($('#badge-worlds'), ui.worlds.length ? String(ui.worlds.length) : '')
  $('#worlds-empty').hidden = ui.worlds.length > 0 || !ui.engineReady
  $('#world-grid').replaceChildren(...ui.worlds.map((world) => {
    const isHosted = world.folder === hosted
    const locked = isHosted && running
    const lockedNote = locked ? 'Stop the server first. It keeps this world\'s files locked.' : ''
    const thumb = h('div', { class: 'thumb' }, world.icon ? h('img', { src: world.icon, alt: '' }) : h('span', { class: 'thumb-empty' }))
    const buttons = [
      isHosted
        ? null
        : h('button', { type: 'button', class: 'primary', textContent: running ? 'Switch and restart' : 'Host this world', on: { click: () => hostWorld(world) } }),
      h('button', { type: 'button', textContent: 'Manage mods', on: { click: () => openWorldMods(world.folder) } }),
      h('button', { type: 'button', textContent: 'Clone', disabled: locked, title: lockedNote, on: { click: () => cloneWorld(world) } }),
      h('button', { type: 'button', textContent: 'Rename', disabled: locked, title: lockedNote, on: { click: () => renameWorld(world) } }),
      h('button', { type: 'button', textContent: 'Back up', disabled: locked, title: lockedNote, on: { click: () => backupWorld(world) } }),
      h('button', { type: 'button', textContent: 'Open folder', on: { click: () => api.openWorld(world.folder) } }),
      h('button', { type: 'button', class: 'danger-ghost', textContent: 'Delete', disabled: locked, title: lockedNote, on: { click: () => deleteWorld(world) } })
    ]
    return h('article', { class: `card world-card${isHosted ? ' hosted' : ''}` }, thumb,
      h('div', { class: 'card-main' },
        h('div', { class: 'title-line' },
          h('h3', { textContent: world.name }),
          isHosted ? h('span', { class: 'chip accent', textContent: 'Hosted' }) : null),
        h('p', { class: 'facts', textContent: worldFacts(world) || world.folder }),
        h('p', { class: 'facts', textContent: `${plural(world.behavior, 'behavior pack')}, ${plural(world.resource, 'resource pack')}${world.lastPlayed ? `. Saved ${ago(world.lastPlayed)}` : ''}` }),
        world.experiments.length ? h('p', { class: 'facts', textContent: `Experiments: ${world.experiments.join(', ')}` }) : null,
        h('div', { class: 'row' }, buttons)))
  }))
}

async function deleteWorld (world) {
  const hosted = latest?.settings.world.name === world.folder
  const check = await ask('world.deleteCheck', { folder: world.folder })
  if (!check) return
  const lines = [`It uses ${check.size}. It goes to the Recycle Bin, so it can be restored from there until the bin is emptied.`]
  if (hosted) lines.push('This is the world the server hosts. You\'ll need to choose another before the server can start.')
  if (check.onlyHere.length) lines.push(`These mods aren't in your library or anywhere else, and go with it:\n${check.onlyHere.slice(0, 10).map((n) => `- ${n}`).join('\n')}${check.onlyHere.length > 10 ? `\nand ${check.onlyHere.length - 10} more` : ''}`)
  const sure = await api.confirm({ danger: true, message: `Delete the world "${world.name}"?`, detail: lines.join('\n\n'), yes: 'Delete world' })
  if (!sure.yes) return
  const result = await api.mods('world.delete', { folder: world.folder })
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  say(`Deleted ${world.name}.`)
  notify(`Deleted the world ${world.name}`, 'It is in the Recycle Bin.', 'ok')
  if (ui.editorFolder === world.folder) { ui.editorFolder = null; ui.editor = null }
  ui.manualOrder = null
  await refreshWorlds()
  await refreshMods()
  await refreshLib()
}

/* Backups */

function setWorldsView (view) {
  for (const button of document.querySelectorAll('#worlds-seg button')) button.classList.toggle('on', button.dataset.view === view)
  $('#worlds-list').hidden = view !== 'list'
  $('#worlds-backups').hidden = view !== 'backups'
  setText($('#worlds-note'), view === 'list' ? 'Host a world on the server, or manage which mods it uses.' : 'A backup always loads as a new world, so nothing is overwritten.')
  if (view === 'backups') refreshBackups()
}
$('#worlds-seg').addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]')?.dataset.view
  if (view) setWorldsView(view)
})

async function refreshBackups () {
  const result = await ask('backups')
  if (!result) return
  setText($('#tab-backups'), result.backups.length ? `Backups (${result.backups.length})` : 'Backups')
  setText($('#backups-note'), `In ${result.folder}`)
  $('#backups-empty').hidden = result.backups.length > 0
  $('#backup-list').replaceChildren(...result.backups.map((backup) => h('div', { class: 'issue backup-row' },
    h('div', { class: 'grow' },
      h('h4', { textContent: backup.label ? `${backup.name} · ${backup.label}` : backup.name }),
      h('p', { textContent: `${new Date(backup.date).toLocaleString()} · ${backup.size} · ${backup.file}` })),
    h('button', { type: 'button', class: 'primary', textContent: 'Load as new world', on: { click: () => loadBackup(backup) } }),
    h('button', { type: 'button', class: 'danger-ghost', textContent: 'Delete', on: { click: () => deleteBackup(backup) } }))))
}

async function loadBackup (backup) {
  const day = new Date(backup.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const name = await promptFor(`Load ${backup.name}`, 'Name for the new world', `${backup.name} (${day})`.slice(0, 60), 'Load')
  if (!name) return
  say(`Loading ${backup.file}...`)
  const result = await api.mods('world.loadBackup', { id: backup.id, name })
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  say(`Loaded as ${result.result.name}. Host it to run it.`)
  notify(`Loaded a backup as ${result.result.name}`, 'The backup and your other worlds weren\'t changed.', 'ok', 'worlds')
  await refreshWorlds()
  await rescan()
  setWorldsView('list')
}

async function deleteBackup (backup) {
  const sure = await api.confirm({ danger: true, message: `Delete this backup of ${backup.name}?`, detail: `${backup.file}, ${backup.size}, from ${new Date(backup.date).toLocaleString()}. It goes to the Recycle Bin.`, yes: 'Delete backup' })
  if (!sure.yes) return
  const result = await api.mods('backups.delete', { id: backup.id })
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  say('Deleted the backup.')
  await refreshBackups()
}

async function hostWorld (world) {
  const result = await api.useWorld(world.folder)
  if (result.canceled) return
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  await refreshWorlds()
  say(`Now hosting ${world.name}.`)
  notify(`Now hosting ${world.name}`, '', 'ok')
  await refreshWorlds()
}

async function backupWorld (world) {
  say(`Backing up ${world.name}...`)
  const result = await api.mods('world.backup', { folder: world.folder })
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  say(`Backup written: ${result.result.file}`)
  notify(`Backed up ${world.name}`, result.result.file, 'ok')
  refreshBackups()
}

async function cloneWorld (world) {
  const name = await promptFor(`Clone ${world.name}`, 'Name for the copy', `${world.name} copy`, 'Clone')
  if (!name) return
  say(`Cloning ${world.name}...`)
  const result = await api.mods('world.clone', { folder: world.folder, name })
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  say(`Cloned as ${result.result.name}.`)
  notify(`Cloned ${world.name} as ${result.result.name}`, 'The original wasn\'t changed.', 'ok', 'worlds')
  await refreshWorlds()
  await rescan()
}

async function renameWorld (world) {
  const name = await promptFor(`Rename ${world.name}`, 'New name', world.name, 'Rename')
  if (!name || name === world.name) return
  const result = await api.mods('world.rename', { folder: world.folder, name })
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  if (ui.editorFolder === world.folder) ui.editorFolder = result.result.folder
  say(`Renamed to ${result.result.name}.`)
  notify(`Renamed ${world.name} to ${result.result.name}`, '', 'ok')
  ui.manualOrder = null
  await refreshWorlds()
  await rescan()
  if (ui.editorFolder === result.result.folder) await openEditor(ui.editorFolder)
}

async function importWorld (kind) {
  const result = await api.importWorld(kind)
  if (result.canceled) return
  if (!result.ok) { say(result.error); showMessage(result.error); return }
  say(`Loaded ${result.result.name}. Host it to run it.`)
  notify(`Loaded ${result.result.name}`, 'It is in the server\'s worlds folder. The original wasn\'t changed.', 'ok', 'worlds')
  await refreshWorlds()
  await rescan()
}
$('#world-import-file').addEventListener('click', () => importWorld('file'))
$('#world-import-folder').addEventListener('click', () => importWorld('folder'))

async function selectWorld (folder) {
  if (folder === ui.world) return
  const view = await ask('world.select', { folder })
  if (!view) return
  ui.world = folder
  ui.manualOrder = null
  applyMods(view)
  renderWorldChoice()
  renderWorlds()
  loadUpdates()
  scheduleAnalysis(0)
  if (ui.page === 'mods') openEditor(folder)
}

function renderWorldChoice () {
  const select = $('#mods-world')
  const hosted = latest?.settings.world.name
  const signature = JSON.stringify(ui.worlds.map((w) => [w.folder, w.name, hosted]))
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature
    select.replaceChildren(...ui.worlds.map((world) => h('option', { value: world.folder, textContent: world.folder === hosted ? `${world.name} (hosted)` : world.name })))
  }
  select.value = ui.world
  select.disabled = !ui.worlds.length
  const world = ui.worlds.find((w) => w.folder === ui.world)
  setText($('#act-add'), world ? `Add to "${world.name}"` : 'Add to world')
  const chip = $('#mods-world-chip')
  chip.hidden = !world
  if (world) setText(chip, `${plural(world.behavior, 'BP', 'BPs')}, ${plural(world.resource, 'RP', 'RPs')}`)
}
$('#mods-world').addEventListener('change', (event) => selectWorld(event.target.value))

/* Packs of one world */

async function openEditor (folder) {
  ui.editorFolder = folder
  ui.editorPick = null
  const data = await ask('world.packs', { folder })
  if (!data) return
  ui.editor = { behavior: data.behavior, resource: data.resource, dirty: false, hasOriginal: data.hasOriginal, lastWins: data.lastWins }
  renderEditor()
}

function renderEditor () {
  const box = $('#world-editor')
  box.hidden = !ui.editor
  if (!ui.editor) return
  const world = ui.worlds.find((w) => w.folder === ui.editorFolder)
  setText($('#editor-title'), `Packs in ${world?.name || ui.editorFolder}`)
  setText($('#editor-hint'), ui.editor.lastWins ? 'The last pack overrides the ones above it.' : 'The first pack overrides the ones below it.')
  $('#editor-dirty').hidden = !ui.editor.dirty
  $('#editor-revert').disabled = !ui.editor.dirty
  $('#editor-save').disabled = !ui.editor.dirty || latest?.modsBusy
  $('#editor-restore').disabled = !ui.editor.hasOriginal
  for (const kind of ['behavior', 'resource']) {
    const list = ui.editor[kind]
    $(`#editor-${kind}`).replaceChildren(...(list.length
      ? list.map((pack, i) => h('li', { class: `${pack.missing ? 'missing ' : ''}${ui.editorPick === pack.uuid ? 'on' : ''}`, on: { click: () => { ui.editorPick = pack.uuid; renderEditor() }, dblclick: () => openPack(pack.uuid) } },
          h('span', { class: 'pack-name', textContent: pack.name }),
          h('span', { class: 'tiny', textContent: `${pack.version} / ${pack.where}` }),
          h('button', { type: 'button', textContent: 'Up', disabled: i === 0, on: { click: (e) => { e.stopPropagation(); moveInEditor(kind, i, -1) } } }),
          h('button', { type: 'button', textContent: 'Down', disabled: i === list.length - 1, on: { click: (e) => { e.stopPropagation(); moveInEditor(kind, i, 1) } } }),
          h('button', { type: 'button', textContent: 'Remove', disabled: ui.editor.dirty, title: ui.editor.dirty ? 'Save or revert the new order first.' : '', on: { click: (e) => { e.stopPropagation(); removeFromEditor(pack) } } })))
      : [h('li', { class: 'list-empty', textContent: 'None' })]))
  }
}

async function removeFromEditor (pack) {
  const world = ui.worlds.find((w) => w.folder === ui.editorFolder)
  const sure = await api.confirm({ danger: !pack.inLibrary, message: `Remove ${pack.name} from "${world?.name || ui.editorFolder}"?`, detail: pack.inLibrary ? 'The world stops using it and its copy in the world is deleted. Your library still has it.' : 'The world stops using it and its copy in the world is deleted. This mod isn\'t in your library, so if this is the only copy, it is gone for good. Add it to the library first to keep it.', yes: 'Remove' })
  if (!sure.yes) return
  const result = await ask('world.removePacks', { folder: ui.editorFolder, uuids: [pack.uuid] })
  if (!result) return
  say(`Removed ${pack.name}.`)
  await afterChange()
  await refreshMods()
  await openEditor(ui.editorFolder)
}

function moveInEditor (kind, i, delta) {
  const list = ui.editor[kind]
  ;[list[i], list[i + delta]] = [list[i + delta], list[i]]
  ui.editor.dirty = true
  renderEditor()
}

$('#editor-revert').addEventListener('click', () => openEditor(ui.editorFolder))
$('#editor-save').addEventListener('click', async () => {
  const done = await ask('world.savePacks', { folder: ui.editorFolder, behavior: ui.editor.behavior.map((p) => p.uuid), resource: ui.editor.resource.map((p) => p.uuid) })
  if (!done) return
  say('Saved the world\'s pack list.')
  await afterChange()
  await openEditor(ui.editorFolder)
})
$('#editor-restore').addEventListener('click', async () => {
  const sure = await api.confirm({ message: 'Put this world\'s pack lists back the way they were?', detail: 'This restores the lists from before they were first edited here.', yes: 'Restore' })
  if (!sure.yes) return
  if (await ask('world.restore', { folder: ui.editorFolder })) { await afterChange(); await openEditor(ui.editorFolder) }
})

/* Mods: library */

function applyMods (view) {
  ui.mods = view.mods
  ui.ticked = new Set(view.ticked)
  ui.scanIssues = view.issues
  ui.updateCount = view.updates
  renderLibrary()
  renderBadges()
  renderIssueChip()
  loadIcons()
}

async function refreshMods () {
  const view = await ask('mods')
  if (view) applyMods(view)
}

async function rescan () {
  if (ui.scanning) return
  ui.scanning = true
  $('#mods-rescan').disabled = true
  $('#lib-rescan').disabled = true
  $('#busy-meter').hidden = false
  say('Scanning your mod library...')
  const view = await ask('scan')
  ui.scanning = false
  $('#mods-rescan').disabled = false
  $('#lib-rescan').disabled = false
  if (!latest?.modsBusy) $('#busy-meter').hidden = true
  if (!view) return
  applyMods(view)
  say(`Library: ${plural(ui.mods.length, 'mod')}.`)
  if (view.issues.length) notify(plural(view.issues.length, 'file') + ' could not be read', 'They were skipped during the scan.', 'warn', 'library', 'scan')
  else clearNote('scan')
  const unnamed = ui.mods.filter((m) => m.unnamed).length
  if (unnamed && ui.config?.notify_info) notify(plural(unnamed, 'pack') + ' have no real name', 'Open a mod\'s details to identify it or give it a label.', 'info', 'library', 'unnamed')
  scheduleAnalysis(0)
  const withChanges = await ask('changes', {}, { quiet: true })
  if (withChanges) applyMods(withChanges)
  loadUpdates()
  await checkLibrary()
  if (lib.detail) await reloadLibDetail()
}

function renderIssueChip () {
  const chip = $('#scan-problems')
  chip.hidden = !ui.scanIssues.length
  if (ui.scanIssues.length) setText(chip, `${plural(ui.scanIssues.length, 'file')} could not be read`)
}
$('#scan-problems').addEventListener('click', () => {
  report('Files that could not be read', 'They were skipped. Nothing else was affected.', ui.scanIssues.map((i) => ({ status: 'warn', label: i.text, word: '', detail: [i.hint, i.path].filter(Boolean).join(' ') })))
})

function issueCount (mod, sev) {
  if (!ui.analysis) return 0
  return ui.analysis.issues.filter((i) => i.sev === sev && i.uuids.some((u) => mod.uuids.includes(u))).length
}

function passes (mod, show, search) {
  if (search) {
    const text = [mod.name, mod.namespace, mod.note, ...mod.tags].join(' ').toLowerCase()
    if (!text.includes(search)) return false
  }
  switch (show) {
    case 'world': return mod.inWorld > 0
    case 'server': return mod.onServer
    case 'not': return !mod.onServer && !mod.inWorldFiles
    case 'updates': return mod.statusTag === 'update'
    case 'ticked': return mod.ticked > 0
    case 'problems': return issueCount(mod, 'error') + issueCount(mod, 'warn') > 0
    case 'unnamed': return mod.unnamed
    case 'fav': return mod.fav
    default: return true
  }
}

function sorted (mods) {
  const how = $('#mods-sort').value
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  const list = mods.slice()
  if (how === 'Favorites first') list.sort((a, b) => (b.fav - a.fav) || byName(a, b))
  else if (how === 'Recently changed') list.sort((a, b) => b.mtime - a.mtime)
  else if (how === 'Status') {
    const rank = { update: 0, new: 1, newer: 2, installed: 3, active: 4, muted: 5 }
    list.sort((a, b) => ((rank[a.statusTag] ?? 6) - (rank[b.statusTag] ?? 6)) || byName(a, b))
  } else list.sort(byName)
  return list
}

function modIcon (mod) {
  const src = ui.icons.get(mod.id)
  return h('div', { class: 'mod-icon', data: { icon: mod.id } }, src ? h('img', { src, alt: '' }) : mod.name.trim().charAt(0).toUpperCase() || '?')
}

function renderLibrary () {
  const search = $('#mods-search').value.trim().toLowerCase()
  const show = $('#mods-show').value
  const shown = sorted(ui.mods).filter((mod) => passes(mod, show, search))
  $('#mod-grid').replaceChildren(...shown.map((mod) => {
    const errors = issueCount(mod, 'error')
    const warns = issueCount(mod, 'warn')
    const box = h('input', { type: 'checkbox', checked: mod.supported.length > 0 && mod.ticked === mod.supported.length, disabled: !mod.supported.length, 'aria-label': `Tick ${mod.name}`, on: { click: (e) => e.stopPropagation(), change: (e) => toggleMod(mod, e.target.checked) } })
    box.indeterminate = mod.ticked > 0 && mod.ticked < mod.supported.length
    return h('article', { class: `mod-card${mod.ticked ? ' ticked' : ''}`, title: mod.description || mod.source, on: { click: () => openPack(mod.uuids[0], mod) } },
      box,
      modIcon(mod),
      h('div', { class: 'mod-text' },
        h('div', { class: 'mod-name' }, mod.unnamed ? '? ' : '', mod.name, mod.namespace ? h('span', { class: 'ns', textContent: ` [${mod.namespace}]` }) : null),
        h('div', { class: 'mod-meta', textContent: `${mod.contents} / ${mod.version}${mod.older ? ` / ${mod.older} older hidden` : ''}` }),
        h('div', { class: 'mod-status', data: { tag: mod.statusTag } }, mod.statusText,
          errors ? h('span', { class: 'bad', textContent: ` / ${plural(errors, 'error')}` }) : null,
          !errors && warns ? ` / ${plural(warns, 'warning')}` : null)),
      h('button', { type: 'button', class: `star${mod.fav ? ' on' : ''}`, 'aria-label': mod.fav ? 'Remove from favorites' : 'Add to favorites', title: 'Favorite', textContent: mod.fav ? '★' : '☆', on: { click: (e) => { e.stopPropagation(); toggleFav(mod) } } }))
  }))

  const empty = $('#mods-empty')
  empty.hidden = shown.length > 0 || !ui.engineReady
  if (!shown.length) {
    setText(empty, ui.mods.length ? 'No mods match. Clear the search or change what\'s shown.'
      : ui.scanning ? 'Scanning...' : 'Your library is empty. Add mods on the Library page.')
  }
  renderCount()
}

function renderCount () {
  const n = ui.ticked.size
  setText($('#mods-count'), `${plural(n, 'pack')} ticked`)
}

function renderBadges () {
  setText($('#mods-seg [data-view="updates"]'), ui.updateCount ? `Updates (${ui.updateCount})` : 'Updates')
}

async function loadIcons () {
  const need = uniq(ui.mods.map((m) => m.id)).filter((id) => !ui.icons.has(id))
  for (let i = 0; i < need.length; i += 12) {
    const icons = await ask('icons', { ids: need.slice(i, i + 12) }, { quiet: true })
    if (!icons) return
    for (const [id, src] of Object.entries(icons)) {
      ui.icons.set(id, src)
      if (!src) continue
      for (const node of document.querySelectorAll(`[data-icon="${id}"]`)) node.replaceChildren(h('img', { src, alt: '' }))
    }
  }
}

async function saveTicks () {
  await ask('ticks.set', { uuids: [...ui.ticked] })
}

function setModTicks (mod, on) {
  for (const uuid of mod.supported) { if (on) ui.ticked.add(uuid); else ui.ticked.delete(uuid) }
  mod.ticked = mod.supported.filter((u) => ui.ticked.has(u)).length
}

async function toggleMod (mod, on) {
  setModTicks(mod, on)
  renderLibrary()
  await saveTicks()
  scheduleAnalysis()
}

async function toggleFav (mod) {
  const view = await ask('meta.set', { id: mod.id, fav: !mod.fav })
  if (view) applyMods(view)
}

$('#mods-search').addEventListener('input', renderLibrary)
$('#mods-show').addEventListener('change', renderLibrary)
$('#mods-sort').addEventListener('change', (event) => { renderLibrary(); setConfig('sort', event.target.value) })
$('#mods-rescan').addEventListener('click', rescan)

$('#mods-select').addEventListener('change', async (event) => {
  const how = event.target.value
  event.target.value = ''
  if (!how) return
  const search = $('#mods-search').value.trim().toLowerCase()
  const show = $('#mods-show').value
  for (const mod of ui.mods) {
    if (how === 'none') setModTicks(mod, false)
    else if (how === 'all' && passes(mod, show, search)) setModTicks(mod, true)
    else if (how === 'updates' && (mod.statusTag === 'update' || mod.statusTag === 'new')) setModTicks(mod, true)
    else if (how === 'fav' && mod.fav) setModTicks(mod, true)
    else if (how === 'world' && mod.inWorld) setModTicks(mod, true)
  }
  renderLibrary()
  await saveTicks()
  scheduleAnalysis()
})

/* Profiles: named sets of ticked mods */

function renderProfiles () {
  const names = Object.keys(ui.config?.profiles || {}).sort()
  $('#mods-profile').replaceChildren(
    h('option', { value: '', textContent: 'Profiles...' }),
    h('option', { value: '+', textContent: 'Save ticked as a profile' }),
    ...names.map((name) => h('option', { value: `=${name}`, textContent: `Use: ${name}` })),
    ...names.map((name) => h('option', { value: `-${name}`, textContent: `Delete: ${name}` })))
}

$('#mods-profile').addEventListener('change', async (event) => {
  const value = event.target.value
  event.target.value = ''
  if (value === '+') {
    if (!ui.ticked.size) { say('Tick some mods first.'); return }
    const name = await promptFor('Save profile', 'Name for this set of mods', '', 'Save')
    if (!name) return
    const config = await ask('profiles.save', { name, uuids: [...ui.ticked] })
    if (config) { ui.config = config; renderProfiles(); say(`Saved profile ${name}.`) }
  } else if (value.startsWith('=')) {
    const profile = ui.config.profiles[value.slice(1)]
    const wanted = new Set((profile?.uuids || []).map(String))
    const known = new Set(ui.mods.flatMap((m) => m.supported))
    ui.ticked = new Set([...wanted].filter((u) => known.has(u)))
    for (const mod of ui.mods) mod.ticked = mod.supported.filter((u) => ui.ticked.has(u)).length
    renderLibrary()
    await saveTicks()
    scheduleAnalysis()
    const missing = wanted.size - ui.ticked.size
    say(missing ? `${value.slice(1)}: ${plural(missing, 'pack')} from this profile aren't in the library.` : `Using profile ${value.slice(1)}.`)
  } else if (value.startsWith('-')) {
    const config = await ask('profiles.delete', { name: value.slice(1) })
    if (config) { ui.config = config; renderProfiles() }
  }
})

/* Pack info */

let packShown = null

async function openPack (uuid, mod = null) {
  const info = await ask('pack.info', { uuid })
  if (!info) return
  packShown = { uuid, mod: mod || ui.mods.find((m) => m.uuids.includes(uuid)) || null }
  setText($('#pack-title'), info.name)
  setText($('#pack-sub'), `${info.kind} pack, version ${info.version}${info.named ? '' : '. This pack has no real name.'}`)
  $('#pack-icon').replaceChildren(info.icon ? h('img', { src: info.icon, alt: '' }) : info.name.trim().charAt(0).toUpperCase())
  setText($('#pack-guess'), info.description || (info.guess ? `This pack ${info.guess}.` : ''))
  const rows = [['UUID', info.uuid], ['From', info.source], ['Files', `${info.files}, ${info.size}`], ['Authors', info.authors.join(', ')], ['Minimum game version', info.minEngine], ['Installed at', info.installedAt], ['Worlds using it', info.usedBy.join(', ')], ['Needed by', info.neededBy.join(', ')], ['Problem', info.error]]
  $('#pack-details').replaceChildren(...rows.filter(([, v]) => v).map(([k, v]) => h('div', {}, h('dt', { textContent: k }), h('dd', { textContent: v }))))
  const sections = []
  const section = (title, text) => { if (text) sections.push(h('div', {}, h('h4', { textContent: title }), h('p', { textContent: text }))) }
  section('Namespaces', info.namespaces.join(', '))
  for (const [cat, idents] of Object.entries(info.idents)) section(cat[0].toUpperCase() + cat.slice(1) + 's', idents.join(', '))
  section('Names shown in game', info.displayNames.join(', '))
  section('Dependencies', info.deps.map((d) => `${d.name || d.id} ${d.version}`).join(', '))
  section('Scripts', info.scripts.join(', '))
  $('#pack-sections').replaceChildren(...sections)
  $('#pack-note-field').hidden = !packShown.mod
  if (packShown.mod) {
    $('#pack-tags').value = packShown.mod.tags.join(', ')
    $('#pack-note').value = packShown.mod.note
  }
  openDialog($('#dlg-pack'))
}

$('#pack-open').addEventListener('click', async () => {
  const result = await api.openPack(packShown.uuid)
  if (!result.ok) say(result.error)
})
$('#pack-label').addEventListener('click', async () => {
  $('#dlg-pack').close()
  const current = ui.config?.aliases?.[packShown.uuid] || ''
  const name = await promptFor('Set my own label', 'This name is used everywhere for this pack. Leave it empty to remove the label.', current, 'Save', true)
  if (name === null) return
  const view = await ask('label.set', { uuid: packShown.uuid, name })
  if (view) { applyMods(view); ui.config = await ask('config') }
})
$('#dlg-pack').addEventListener('close', async () => {
  const mod = packShown?.mod
  if (!mod) return
  const tags = uniq($('#pack-tags').value.split(',').map((t) => t.trim()).filter(Boolean))
  const note = $('#pack-note').value.trim()
  if (note === mod.note && JSON.stringify(tags) === JSON.stringify(mod.tags)) return
  const view = await ask('meta.set', { id: mod.id, tags, note })
  if (view) applyMods(view)
})

function promptFor (title, label, value = '', okText = 'Save', allowEmpty = false) {
  const dialog = $('#dlg-prompt')
  setText($('#prompt-title'), title)
  setText($('#prompt-label'), label)
  setText($('#prompt-ok'), okText)
  $('#prompt-input').value = value
  dialog.returnValue = ''
  return new Promise((resolve) => {
    const form = $('#prompt-form')
    let answer = null
    const onSubmit = () => { answer = $('#prompt-input').value.trim() }
    form.addEventListener('submit', onSubmit, { once: true })
    dialog.addEventListener('close', () => {
      form.removeEventListener('submit', onSubmit)
      resolve(answer === '' && !allowEmpty ? null : answer)
    }, { once: true })
    openDialog(dialog)
    $('#prompt-input').focus()
  })
}

/* Mods page tabs */

function setModsView (view) {
  for (const button of document.querySelectorAll('#mods-seg button')) button.classList.toggle('on', button.dataset.view === view)
  for (const name of ['packs', 'library', 'compat', 'updates', 'order']) $(`#view-${name}`).hidden = name !== view
  // The ticked mods only matter while adding from the library
  $('#mods-actions').hidden = view !== 'library' && view !== 'compat'
  if (view === 'updates') loadUpdates()
  if (view === 'compat' || view === 'order') scheduleAnalysis(0)
}

$('#mods-seg').addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]')?.dataset.view
  if (view) setModsView(view)
})

/* Compatibility and load order */

let analysisTimer = null
let analysisRun = 0

function scheduleAnalysis (delay = 500) {
  clearTimeout(analysisTimer)
  analysisTimer = setTimeout(runAnalysis, delay)
}

async function runAnalysis (mode = null) {
  if (!ui.engineReady) return null
  const run = ++analysisRun
  setText($('#compat-summary'), 'Checking...')
  const params = { gameVersion: latest?.services.server.version || '' }
  if (mode) params.mode = mode
  else if (ui.manualOrder) { params.order = ui.manualOrder; params.mode = 'slot' }
  const result = await ask('analyze', params)
  if (run !== analysisRun || !result) return result
  ui.analysis = result
  renderAnalysis()
  renderOrder()
  renderLibrary()
  return result
}

function renderAnalysis () {
  const { issues } = ui.analysis
  const errors = issues.filter((i) => i.sev === 'error').length
  const warns = issues.filter((i) => i.sev === 'warn').length
  const notes = issues.length - errors - warns
  const summary = $('#compat-summary')
  summary.className = `summary ${errors ? 'bad' : warns ? 'warn' : 'ok'}`
  setText(summary, issues.length
    ? `${plural(errors, 'error')}, ${plural(warns, 'warning')}, ${plural(notes, 'note')} for the ticked mods and "${ui.worlds.find((w) => w.folder === ui.world)?.name || 'no world'}"`
    : 'No problems found with the ticked mods and the selected world.')
  setText($('#mods-seg [data-view="compat"]'), errors + warns ? `Compatibility (${errors + warns})` : 'Compatibility')
  $('#mods-seg [data-view="compat"]').classList.toggle('has-errors', errors > 0)
  const rank = { error: 0, warn: 1, info: 2 }
  $('#issue-list').replaceChildren(...issues.slice().sort((a, b) => rank[a.sev] - rank[b.sev]).map((issue) => h('div', { class: 'issue', data: { sev: issue.sev } },
    h('h4', { textContent: issue.title }),
    h('p', { textContent: issue.detail }))))
  if (errors) notify(`${plural(errors, 'compatibility error')}`, 'Open the world\'s mods from Worlds, then Compatibility.', 'err', 'worlds', 'compat')
  else clearNote('compat')
}

function renderOrder () {
  const a = ui.analysis
  if (!a) return
  for (const kind of ['behavior', 'resource']) {
    const rows = a.order[kind]
    $(`#order-${kind}`).replaceChildren(...(rows.length
      ? rows.map((row) => h('li', { class: ui.orderPick === row.uuid ? 'on' : '', title: row.reason || '', on: { click: () => { ui.orderPick = row.uuid; renderOrder() }, dblclick: () => openPack(row.uuid) } },
          h('span', { class: 'pack-name', textContent: row.name }),
          row.moved ? h('span', { class: 'tiny moved', textContent: 'Moved' }) : null,
          row.inWorld ? null : h('span', { class: 'tiny new', textContent: 'Ticked, not added' }),
          h('span', { class: 'tiny', textContent: row.version })))
      : [h('li', { class: 'list-empty', textContent: 'Nothing here yet.' })]))
  }
  const moved = [...a.order.behavior, ...a.order.resource].filter((r) => r.moved)
  const reasons = [...a.order.behavior, ...a.order.resource].filter((r) => r.reason && !r.moved)
  const parts = []
  parts.push(h('p', { textContent: a.lastWins ? 'Packs lower in the list win conflicts.' : 'Packs higher in the list win conflicts.' }))
  if (moved.length) parts.push(h('div', {}, h('b', { textContent: `Moved to fix problems (${moved.length})` }), h('ul', {}, moved.map((r) => h('li', { textContent: `${r.name}: ${r.moved}` })))))
  else if (a.violations) parts.push(h('p', { textContent: `${plural(a.violations, 'ordering rule')} broken. Press Fix problems only to repair them.` }))
  else parts.push(h('p', { textContent: 'No ordering problems.' }))
  if (reasons.length) parts.push(h('div', {}, h('b', { textContent: 'Why packs sit where they do' }), h('ul', {}, reasons.slice(0, 12).map((r) => h('li', { textContent: `${r.name}: ${r.reason}` })))))
  if (a.unresolved.length) parts.push(h('div', {}, h('b', { textContent: 'Not fixable by ordering' }), h('ul', {}, a.unresolved.map((t) => h('li', { textContent: t })))))
  $('#order-why').replaceChildren(...parts)
  const summary = $('#order-summary')
  summary.className = `summary ${a.changed ? 'warn' : 'ok'}`
  setText(summary, a.changed ? 'This order isn\'t saved in the world yet.' : 'The world uses this order.')
  $('#order-save').disabled = !a.changed || latest?.modsBusy || latest?.busy !== null
}

function moveInOrder (delta) {
  const a = ui.analysis
  if (!a || !ui.orderPick) { say('Click a pack in the list first.'); return }
  const kind = a.order.behavior.some((r) => r.uuid === ui.orderPick) ? 'behavior' : 'resource'
  const ids = { behavior: a.order.behavior.map((r) => r.uuid), resource: a.order.resource.map((r) => r.uuid) }
  const i = ids[kind].indexOf(ui.orderPick)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids[kind].length) return
  ;[ids[kind][i], ids[kind][j]] = [ids[kind][j], ids[kind][i]]
  ui.manualOrder = ids
  runAnalysis()
}

$('#order-up').addEventListener('click', () => moveInOrder(-1))
$('#order-down').addEventListener('click', () => moveInOrder(1))
$('#order-fix').addEventListener('click', () => { ui.manualOrder = null; runAnalysis('repair') })
$('#order-sort').addEventListener('click', () => { ui.manualOrder = null; runAnalysis('scratch') })
$('#order-reset').addEventListener('click', () => { ui.manualOrder = null; runAnalysis('slot') })
$('#order-save').addEventListener('click', async () => {
  const a = ui.analysis
  if (!a) return
  const order = { behavior: a.order.behavior.map((r) => r.uuid), resource: a.order.resource.map((r) => r.uuid) }
  if (!(await ask('order.save', { order }))) return
  ui.manualOrder = null
  say('Saved the load order.')
  await afterChange()
})

/* Installing and removing */

const tickedIds = () => [...ui.ticked]

async function checkAndPlan (title, target, extra = '', force = false) {
  const ids = tickedIds()
  if (!ids.length) { say('Nothing is ticked. Tick mods in the library first.'); return false }
  const analysis = await runAnalysis()
  const errors = (analysis?.issues || []).filter((i) => i.sev === 'error')
  const plan = await ask('plan', { uuids: ids, target, force })
  if (!plan) return false
  const blocking = plan.problems.filter((p) => p.sev === 'error')
  if (blocking.length) {
    report(title, 'This can\'t go ahead yet.', blocking.map((p) => ({ status: 'fail', label: p.text, word: '', detail: '' })))
    return false
  }
  if (errors.length && plan.confirmErrors) {
    const sure = await api.confirm({ danger: true, message: `The compatibility check found ${plural(errors.length, 'error')}. Continue anyway?`, detail: errors.slice(0, 6).map((e) => `- ${e.title}`).join('\n'), yes: 'Continue' })
    if (!sure.yes) return false
  }
  if (!plan.confirm && !plan.problems.length) return true
  return showPlan(title, extra, plan)
}

function showPlan (title, extra, plan) {
  setText($('#plan-title'), title)
  setText($('#plan-note'), extra)
  $('#plan-problems').replaceChildren(...plan.problems.map((p) => statusRow({ status: 'warn', label: p.text, detail: '' }, '')))
  $('#plan-rows').replaceChildren(...plan.rows.map((row) => h('tr', {}, h('td', { textContent: row.name }), h('td', { textContent: row.kind }), h('td', { textContent: row.action }), h('td', { textContent: row.detail }))))
  const dialog = $('#dlg-plan')
  return new Promise((resolve) => {
    let go = false
    const button = $('#plan-go')
    const onGo = () => { go = true; dialog.close() }
    button.addEventListener('click', onGo, { once: true })
    dialog.addEventListener('close', () => { button.removeEventListener('click', onGo); resolve(go) }, { once: true })
    openDialog(dialog)
  })
}

function report (title, noteText, rows, retry = null) {
  setText($('#report-title'), title)
  setText($('#report-note'), noteText)
  $('#report-rows').replaceChildren(...rows.map((row) => statusRow(row, row.word || '')))
  const button = $('#report-retry')
  button.hidden = !retry
  button.onclick = retry ? () => { $('#dlg-report').close(); retry() } : null
  openDialog($('#dlg-report'))
}

function finished (counts, again) {
  const text = `Done: ${counts.installed} installed, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed.`
  say(text)
  const bad = counts.problems?.length
  notify(text, '', bad ? 'err' : 'ok', bad ? 'console' : null)
  if (bad) {
    const failed = counts.problems.map((p) => p.uuid).filter(Boolean)
    report('Some of it didn\'t work', 'The other packs weren\'t affected.', counts.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })), failed.length && again ? () => again(failed) : null)
  }
}

// What's on screen may be out of date after anything that changes files
async function afterChange () {
  await refreshWorlds()
  const view = await ask('changes', {}, { quiet: true })
  if (view) applyMods(view)
  loadUpdates()
  scheduleAnalysis(0)
  refreshLib()
  if (ui.editor && ui.editorFolder && !ui.editor.dirty) {
    const data = await ask('world.packs', { folder: ui.editorFolder }, { quiet: true })
    if (data) { ui.editor = { behavior: data.behavior, resource: data.resource, dirty: false, hasOriginal: data.hasOriginal, lastWins: data.lastWins }; renderEditor() }
  }
}

function needWorld () {
  if (ui.world) return true
  say('Pick a world first.')
  show('worlds')
  return false
}

async function addToWorld (only = null) {
  if (!needWorld()) return
  if (only) ui.ticked = new Set(only)
  const world = ui.worlds.find((w) => w.folder === ui.world)
  const go = await checkAndPlan(`Add to "${world?.name || ui.world}"`, 'world', 'They are then switched on in the world\'s pack lists, in load order.')
  if (!go) return
  say(`Adding mods to ${world?.name || ui.world}...`)
  const order = ui.analysis ? { behavior: ui.analysis.order.behavior.map((r) => r.uuid), resource: ui.analysis.order.resource.map((r) => r.uuid) } : null
  const counts = await ask('mods.addToWorld', { uuids: tickedIds(), order })
  if (!counts) return
  ui.manualOrder = null
  finished(counts, addToWorld)
  await afterChange()
}

async function removeFromWorld () {
  if (!needWorld()) return
  const ids = tickedIds()
  if (!ids.length) { say('Nothing is ticked.'); return }
  const world = ui.worlds.find((w) => w.folder === ui.world)
  const sure = await api.confirm({ message: `Take ${plural(ids.length, 'ticked pack')} out of "${world?.name || ui.world}"?`, detail: 'The world stops using them, and any copies inside the world\'s own folders are deleted. Your library files stay.', yes: 'Remove' })
  if (!sure.yes) return
  const result = await ask('mods.removeFromWorld', { uuids: ids })
  if (!result) return
  say(`Removed ${plural(result.removed, 'pack')} from ${world?.name || ui.world}.`)
  notify(`Removed ${plural(result.removed, 'pack')} from ${world?.name || ui.world}`, '', 'ok')
  await afterChange()
}

async function installToServer (only = null) {
  if (only) ui.ticked = new Set(only)
  const go = await checkAndPlan(`Install ${plural(tickedIds().length, 'pack')} to the server`, 'server', 'They go in the server\'s shared pack folders. Use Add to world to switch them on.')
  if (!go) return
  const counts = await ask('mods.install', { uuids: tickedIds() })
  if (!counts) return
  finished(counts, installToServer)
  await afterChange()
}

async function uninstallFromServer () {
  const ids = tickedIds()
  if (!ids.length) { say('Nothing is ticked.'); return }
  const sure = await api.confirm({ danger: true, message: `Uninstall ${plural(ids.length, 'ticked pack')} from the server's shared folders?`, detail: 'Only the installed copies are removed, never your source files.', yes: 'Uninstall' })
  if (!sure.yes) return
  const usage = await ask('mods.usage', { uuids: ids })
  let alsoWorlds = false
  if (usage?.worlds.length) {
    const also = await api.confirm({ message: 'These worlds still list some of them. Remove them from those worlds too?', detail: usage.worlds.slice(0, 8).map((w) => `- ${w.name}`).join('\n'), yes: 'Remove from worlds too' })
    alsoWorlds = also.yes
  }
  const result = await ask('mods.uninstall', { uuids: ids, alsoWorlds })
  if (!result) return
  say(`Uninstalled ${plural(result.removed, 'pack')}.`)
  notify(`Uninstalled ${plural(result.removed, 'pack')}`, '', result.problems.length ? 'err' : 'ok')
  if (result.problems.length) report('Some of it didn\'t work', '', result.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })))
  await afterChange()
}

$('#act-add').addEventListener('click', () => addToWorld())
$('#act-remove').addEventListener('click', removeFromWorld)
$('#act-install').addEventListener('click', () => installToServer())
$('#act-uninstall').addEventListener('click', uninstallFromServer)


/* Updates */

let updateRows = []

async function loadUpdates () {
  const result = await ask('updates', { showIgnored: $('#updates-ignored').checked }, { quiet: true })
  if (!result) return
  updateRows = result.rows
  ui.updateCount = result.count
  renderBadges()
  const summary = $('#updates-summary')
  summary.className = `summary ${result.count ? 'warn' : 'ok'}`
  setText(summary, !result.enabled ? 'Looking for changed mods is off in Settings.' : result.count ? `${plural(result.count, 'mod')} can be updated` : 'Everything installed is up to date')
  ui.updatePick = new Set([...ui.updatePick].filter((id) => updateRows.some((r) => r.id === id)))
  $('#update-list').replaceChildren(...(updateRows.length
    ? updateRows.map((row) => {
        const box = h('input', { type: 'checkbox', checked: ui.updatePick.has(row.id), 'aria-label': `Select ${row.name}`, on: { click: (e) => e.stopPropagation(), change: (e) => { if (e.target.checked) ui.updatePick.add(row.id); else ui.updatePick.delete(row.id) } } })
        return h('div', { class: `issue update-row${ui.updateFocus === row.id ? ' on' : ''}${row.ignored ? ' ignored' : ''}`, data: { sev: row.kind === 'older' ? 'info' : 'warn' }, on: { click: () => focusUpdate(row.id) } },
          box,
          h('div', { class: 'grow' },
            h('h4', { textContent: `${row.name}${row.ignored ? ' (ignored)' : ''}` }),
            h('p', { textContent: `${row.what}: ${row.installed} installed, ${row.library} in your library. +${row.added} -${row.removed} ~${row.changed} files` })))
      })
    : [h('p', { class: 'empty', textContent: 'Nothing to update. Mods whose files or version differ from the installed copy appear here.' })]))
  if (!ui.updateFocus) renderUpdateDetail(null)
}

async function focusUpdate (id) {
  ui.updateFocus = id
  for (const node of $('#update-list').children) node.classList.remove('on')
  const index = updateRows.findIndex((r) => r.id === id)
  $('#update-list').children[index]?.classList.add('on')
  renderUpdateDetail({ loading: true, name: updateRows[index]?.name })
  const detail = await ask('updates.detail', { id })
  if (detail && ui.updateFocus === id) renderUpdateDetail({ name: updateRows[index]?.name, packs: detail.packs })
}

function renderUpdateDetail (view) {
  const box = $('#update-detail')
  if (!view) { box.replaceChildren(h('h3', { textContent: 'What will change' }), h('p', { class: 'note', textContent: 'Select a mod to see which files, items and settings differ between your library copy and the installed copy.' })); return }
  if (view.loading) { box.replaceChildren(h('h3', { textContent: view.name }), h('p', { class: 'note', textContent: 'Reading both copies...' })); return }
  const parts = [h('h3', { textContent: view.name })]
  const files = (title, list, cls) => { if (list.length) parts.push(h('h4', { textContent: `${title} (${list.length})` }), h('pre', { class: `file-list ${cls}`, textContent: list.join('\n') })) }
  for (const pack of view.packs) {
    parts.push(h('h4', { textContent: `${pack.kind} pack: ${pack.name}` }))
    parts.push(h('p', { class: 'note', textContent: {
      version: `Version ${pack.installed} installed, ${pack.library} in your library.`,
      content: `Both are version ${pack.library}, but the files differ. Update overwrites the installed copy. Raising the version in the manifest makes the change easier to track.`,
      older: `Installed ${pack.installed} is newer than the library's ${pack.library}. Updating would downgrade it.`
    }[pack.change] }))
    if (pack.error) parts.push(h('p', { class: 'field-note bad', textContent: `Couldn't fully compare: ${pack.error}` }))
    for (const line of pack.notes) parts.push(h('p', { textContent: line }))
    files('Adds', pack.addsContent, 'add')
    files('Removes', pack.removesContent, 'rem')
    files('New files', pack.addedFiles, 'add')
    files('Removed files', pack.removedFiles, 'rem')
    files('Changed files', pack.changedFiles, 'chg')
    if (pack.moreFiles) parts.push(h('p', { class: 'note', textContent: `And ${plural(pack.moreFiles, 'more file')}.` }))
  }
  box.replaceChildren(...parts)
}

async function applyUpdates (ids) {
  if (!ids.length) { say('Select the mods to update first, or press Update all.'); return }
  const counts = await ask('updates.apply', { ids })
  if (!counts) return
  ui.updateFocus = null
  finished(counts, null)
  await afterChange()
}

$('#updates-ignored').addEventListener('change', loadUpdates)
$('#update-selected').addEventListener('click', () => applyUpdates([...ui.updatePick]))
$('#update-all').addEventListener('click', () => applyUpdates(updateRows.filter((r) => !r.ignored && r.kind !== 'older').map((r) => r.id)))
$('#update-ignore').addEventListener('click', async () => {
  const view = await ask('updates.ignore', { ids: [...ui.updatePick] })
  if (view) { applyMods(view); loadUpdates() }
})

/* Console page */

$('#console-seg').addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]')?.dataset.view
  if (!view) return
  for (const button of document.querySelectorAll('#console-seg button')) button.classList.toggle('on', button.dataset.view === view)
  $('#console-log').hidden = view !== 'log'
  $('#console-content').hidden = view !== 'content'
  if (view === 'log') els.log.scrollTop = els.log.scrollHeight
})
$('#open-log-file').addEventListener('click', async () => {
  const result = await api.openServerLog()
  if (!result.ok) say(result.error)
})

/* Notifications */

function saveNotes () {
  if (ui.engineReady) setConfig('notifications', ui.notes.slice(0, 60))
}

function notify (title, text = '', lvl = 'info', action = null, key = null) {
  if (key) ui.notes = ui.notes.filter((n) => n.key !== key)
  ui.notes.unshift({ t: Date.now() / 1000, lvl, title, text, action, key, read: false })
  ui.notes = ui.notes.slice(0, 60)
  renderNc()
  saveNotes()
}

function clearNote (key) {
  const before = ui.notes.length
  ui.notes = ui.notes.filter((n) => n.key !== key)
  if (ui.notes.length !== before) { renderNc(); saveNotes() }
}

function renderNc () {
  const unread = ui.notes.filter((n) => !n.read).length
  const count = $('#bell-count')
  count.hidden = !unread
  setText(count, unread < 10 ? String(unread) : '9+')
  $('#bell').classList.toggle('has', unread > 0)
  $('#nc-empty').hidden = ui.notes.length > 0
  $('#nc-list').replaceChildren(...ui.notes.map((note) => h('li', { class: note.read ? '' : 'unread', data: { lvl: note.lvl } },
    h('span', { class: 'nc-title', textContent: note.title }),
    note.text ? h('span', { class: 'nc-text', textContent: note.text }) : null,
    h('div', { class: 'nc-actions' },
      h('span', { class: 'nc-time', textContent: ago(note.t * 1000) }),
      note.action && PAGES[note.action] ? h('button', { type: 'button', class: 'link', textContent: 'Open', on: { click: () => { show(note.action); toggleNc(false) } } }) : null,
      h('button', { type: 'button', class: 'link', textContent: 'Dismiss', on: { click: () => { ui.notes = ui.notes.filter((n) => n !== note); renderNc(); saveNotes() } } })))))
}

function toggleNc (open) {
  const panel = $('#nc')
  const want = open === undefined ? panel.hidden : open
  panel.hidden = !want
}

$('#bell').addEventListener('click', (event) => { event.stopPropagation(); toggleNc() })
document.addEventListener('click', (event) => { if (!event.target.closest('#nc')) toggleNc(false) })
$('#nc-read').addEventListener('click', () => { for (const n of ui.notes) n.read = true; renderNc(); saveNotes() })
$('#nc-clear').addEventListener('click', () => { ui.notes = []; renderNc(); saveNotes() })

/* Settings */

function renderSettings () {
  const c = ui.config
  if (!c) return
  for (const input of document.querySelectorAll('[data-setting]')) {
    const value = c[input.dataset.setting]
    if (input.type === 'checkbox') input.checked = Boolean(value)
    else if (document.activeElement !== input) input.value = value ?? ''
  }
  const current = String(c.accent).toLowerCase()
  $('#swatches').replaceChildren(
    ...THEMES.map(([name, color]) => {
      const button = h('button', { type: 'button', class: `swatch${current === color ? ' on' : ''}`, title: name, 'aria-label': `${name} accent`, on: { click: () => chooseAccent(color) } })
      button.style.background = color
      return button
    }),
    h('input', { type: 'color', id: 'swatch-custom', value: /^#[0-9a-f]{6}$/.test(current) ? current : '#3d8bfd', title: 'Custom colour', 'aria-label': 'Custom accent colour', on: { change: (e) => chooseAccent(e.target.value) } }))
}

async function chooseAccent (color) {
  setAccent(color)
  if (await setConfig('accent', color)) renderSettings()
}

for (const input of document.querySelectorAll('[data-setting]')) {
  input.addEventListener('change', async () => {
    const key = input.dataset.setting
    const value = input.type === 'checkbox' ? input.checked : input.value.trim()
    const config = await setConfig(key, value)
    if (!config) { renderSettings(); return }
    if (['skip_folders'].includes(key)) rescan()
    if (['last_wins', 'auto_order', 'auto_fix_order', 'game_version'].includes(key)) scheduleAnalysis(0)
    if (key === 'check_changes') { const view = await ask('changes', {}, { quiet: true }); if (view) applyMods(view); loadUpdates() }
    say('Saved.')
  })
}

$('#backup-browse').addEventListener('click', async () => {
  const result = await api.pickBackupDir()
  if (result.ok && result.result) { ui.config = result.result; renderSettings() }
})

function renderAbout (state) {
  const rows = [
    ['Bedrock Hub', state.appVersion ? `Version ${state.appVersion}` : 'Unknown version'],
    ['Mod engine', state.engine.ready ? `Running on Python ${state.engine.python}` : (state.engine.error || 'Starting')],
    ['Minecraft server', state.services.server.version || 'Unknown version'],
    ['Licence', 'GPL-3.0, built on MCXboxBroadcast']
  ]
  const signature = JSON.stringify(rows)
  const about = $('#about')
  if (about.dataset.signature === signature) return
  about.dataset.signature = signature
  about.replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', { textContent: k }), h('dd', { textContent: v }))))
}

// The page you were last on. show() keeps this up to date.
let firstPage = 'library'
try { firstPage = localStorage.getItem('hub-page') || firstPage } catch {}
show(PAGES[firstPage] ? firstPage : 'library')
setWorldsView('list')
