'use strict'

// The server, Xbox account and console, from HMBC. hub.js holds the sidebar, worlds, mods and settings.

const api = window.hub
const $ = (selector, root = document) => root.querySelector(selector)

const els = {
  overall: $('#overall-text'),
  message: $('#message'),
  log: $('#log'),
  update: $('#update-server'),
  login: $('#login'),
  start: $('#start'),
  refresh: $('#refresh'),
  stop: $('#stop')
}
const dialogs = { xbox: $('#dlg-xbox'), status: $('#dlg-status') }

let latest = null

function setText (node, text) {
  if (node.textContent !== text) node.textContent = text
}

function showMessage (text, ok = false, node = els.message) {
  node.hidden = !text
  node.classList.toggle('ok', ok)
  setText(node, text || '')
}

/* Service panels and sign-in blocks */

function renderSignIn (root, signIn) {
  const block = $('.signin', root)
  const show = Boolean(signIn && signIn.code)
  block.hidden = !show
  root._signIn = show ? signIn : null
  if (show) setText($('.code', root), signIn.code)
}

function renderService (root, vm) {
  root.dataset.lamp = vm.lamp
  setText($('.headline', root), vm.headline)
  setText($('.hint', root), vm.hint || '')

  const details = $('.details', root)
  const signature = JSON.stringify(vm.details)
  if (details.dataset.signature !== signature) {
    details.dataset.signature = signature
    details.replaceChildren(...vm.details.map((item) => {
      const row = document.createElement('div')
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = item.label
      dd.textContent = item.value
      if (item.tone) dd.classList.add(item.tone)
      row.append(dt, dd)
      return row
    }))
  }
  renderSignIn(root, vm.signIn)
}

function wireSignIn (root, errorNode) {
  const copy = $('.copy', root)
  copy.addEventListener('click', async () => {
    if (!root._signIn) return
    await api.copyText(root._signIn.code)
    copy.textContent = 'Copied'
    setTimeout(() => { copy.textContent = 'Copy code' }, 1500)
  })
  $('.open', root).addEventListener('click', async () => {
    if (!root._signIn) return
    const result = await api.openSignIn(root._signIn.url)
    if (!result.ok) showMessage(result.error, false, errorNode)
  })
}

/* Whole-window render */

function renderOverall (state) {
  const overall = state.status?.overall
  els.overall.classList.toggle('bad', overall === 'bad')
  els.overall.classList.toggle('wait', overall === 'wait')
  setText(els.overall, state.status?.headline || '')
}

// Open the sign-in dialog by itself the first time a code shows up, so no extra click is needed
const announcedCodes = new Set()
function maybeOpenSignIn (state) {
  const info = state.xbox.bridge
  const code = info.kind === 'code' ? info.signIn.code : null
  if (!code || announcedCodes.has(code)) return
  announcedCodes.add(code)
  if (!document.querySelector('dialog[open]')) openDialog(dialogs.xbox)
}

function renderXbox (state) {
  maybeOpenSignIn(state)
  const row = $('[data-xbox="bridge"]')
  const info = state.xbox.bridge
  setText($('.xbox-status', row), info.text)
  renderSignIn(row, info.signIn)
  $('#xbox-start').hidden = info.kind !== 'idle'
  $('#xbox-start').disabled = state.busy !== null
}

/* Cards */

const MODES = { survival: 'Survival', creative: 'Creative', adventure: 'Adventure', spectator: 'Spectator' }

function ago (ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

function span (seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h ${m}m`
  if (h) return `${h}h ${m}m ${s % 60}s`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

function setThumb (src, caption) {
  const img = $('#world-img')
  if (src) { if (img.getAttribute('src') !== src) img.src = src } else img.removeAttribute('src')
  img.hidden = !src
  $('#world-empty').hidden = Boolean(src)
  setText($('#world-caption'), caption)
}

function renderServerCard (state) {
  const { settings, worldInfo } = state
  if (document.activeElement !== $('#host') && $('#host').dataset.saved !== settings.host) {
    $('#host').value = settings.host
    $('#host').dataset.saved = settings.host
  }
  if (settings.world.hosting) {
    setThumb(worldInfo?.icon || '', `${worldInfo?.levelName || settings.world.name}, hosted on this VM`)
  } else {
    setThumb('', 'No world chosen. Pick one on the Worlds page.')
  }
  setText($('#manage-worlds'), settings.world.hosting ? 'Change world' : 'Choose a world')
  $('#manage-mods').hidden = !settings.world.hosting
}

function renderStats (state) {
  const { settings, status, services, update } = state
  const item = status?.items.find((i) => i.id === 'server')
  const pill = $('#server-pill')
  const side = $('#side-pill')
  pill.dataset.s = item?.status || 'off'
  side.dataset.s = item?.status || 'off'
  setText($('#server-state'), item ? item.word : 'Off')
  setText($('#side-state'), item ? item.word : 'Off')
  const bridgeItem = status?.items.find((i) => i.id === 'bridge')
  $('#side-bridge').dataset.s = bridgeItem?.status || 'off'
  setText($('#side-bridge-state'), bridgeItem ? bridgeItem.word : 'Off')
  setText($('#server-detail'), item?.detail || '')

  const server = services.server
  const up = server.state === 'ready'
  const worldName = settings.world.hosting ? (state.worldInfo?.levelName || settings.world.name) : ''
  setText($('#side-world'), worldName ? `World: ${worldName}` : 'No world chosen')
  setText($('#st-players'), up ? `${server.players.length} / ${settings.maxPlayers || '?'}` : '-')
  setText($('#st-online'), up && server.players.length ? server.players.join(', ') : '-')
  setText($('#st-version'), (server.version || '-') + (update?.available ? ` (${update.latest} available)` : ''))
  setText($('#st-mode'), settings.gameMode ? (MODES[settings.gameMode.toLowerCase()] || settings.gameMode) : '-')
  setText($('#st-world'), worldName || '-')
  setText($('#st-saved'), state.worldInfo?.savedAt ? ago(state.worldInfo.savedAt) : '-')
  setText($('#st-address'), settings.configured ? settings.host : 'Not set')
  renderUptime()
}

function renderUptime () {
  if (!latest) return
  const since = latest.services?.server?.startedAt
  setText($('#st-uptime'), since ? span((Date.now() - since) / 1000) : '-')
}
setInterval(renderUptime, 1000)

function renderFriends (state) {
  const { friends } = state
  const box = $('#auto-accept')
  box.checked = friends ? friends.autoAccept : state.settings.autoAccept
  const note = $('#friends-note')
  const list = $('#requests')
  if (!friends) {
    setText(note, state.bridge.lamp === 'lit' ? 'Checking for requests.' : state.services.bridge.state === 'running' ? 'Friend requests appear here once the bridge is online.' : 'Start the bridge to see friend requests.')
    list.dataset.signature = ''
    list.replaceChildren()
    return
  }
  setText(note, friends.requests.length ? '' : (friends.autoAccept ? 'New requests are accepted for you.' : 'No pending requests.'))
  const signature = JSON.stringify(friends.requests)
  if (list.dataset.signature === signature) return
  list.dataset.signature = signature
  list.replaceChildren(...friends.requests.map((request) => {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'req-name'
    name.textContent = request.gamertag
    const approve = document.createElement('button')
    approve.type = 'button'
    approve.className = 'primary'
    approve.textContent = 'Approve'
    const deny = document.createElement('button')
    deny.type = 'button'
    deny.textContent = 'Deny'
    for (const [button, yes] of [[approve, true], [deny, false]]) {
      button.addEventListener('click', async () => {
        approve.disabled = true
        deny.disabled = true
        const result = await api.answerFriend(request.xuid, yes)
        if (!result.ok) { approve.disabled = false; deny.disabled = false }
        showMessage(result.ok ? '' : result.error, false, $('#friends-error'))
      })
    }
    li.append(name, approve, deny)
    return li
  }))
}

$('#auto-accept').addEventListener('change', async (event) => {
  const result = await api.setAutoAccept(event.target.checked)
  showMessage(result.ok ? '' : result.error, false, $('#friends-error'))
})

/* Server options, saved in server.properties */

function renderServerOptions (state) {
  const options = state.settings.options
  for (const input of document.querySelectorAll('#server-options [data-prop]')) {
    input.disabled = !options
    if (!options) continue
    const value = options[input.dataset.prop]
    if (input.type === 'checkbox') input.checked = 'invert' in input.dataset ? !value : value
    else if (document.activeElement !== input) input.value = String(value)
  }
  const count = state.settings.allowlist.players.length
  setText($('#allowlist-note'), `${count ? `${count} player${count === 1 ? '' : 's'} on the list.` : 'Nobody is on the list yet.'} Manage it under Allow list below. A running server switches straight away.`)
  const note = $('#options-error')
  if (!options) {
    showMessage('Couldn\'t find server.properties, so these can\'t be changed. Is the server installed?', false, note)
    note.dataset.missing = 'yes'
  } else if (note.dataset.missing) {
    showMessage('', false, note)
    delete note.dataset.missing
  }
}

// Some changes can lock everyone out, so they're checked first
async function confirmOption (key, value) {
  if (key === 'allow-list' && value && !latest.settings.allowlist.players.length) {
    return (await api.confirm({ danger: true, message: 'Turn on the allow list?', detail: 'Nobody is on the list yet, so nobody new will be able to join. Add players under Allow list first.', yes: 'Turn on anyway' })).yes
  }
  if (key === 'online-mode' && !value) {
    return (await api.confirm({ danger: true, message: 'Let players join without a Microsoft account?', detail: 'Anyone who can reach the server could then join under any name. Only turn this off for a server on your own network.', yes: 'Turn off' })).yes
  }
  if (key === 'allow-player-joining' && !value) {
    return (await api.confirm({ danger: true, message: 'Stop players from joining?', detail: 'After the server restarts, only scripts in add-ons can let players in. Without such a script, nobody can join.', yes: 'Turn off' })).yes
  }
  return true
}

async function saveOption (input) {
  const key = input.dataset.prop
  const value = input.type === 'checkbox' ? ('invert' in input.dataset ? !input.checked : input.checked) : input.value
  const go = await confirmOption(key, value)
  const result = go ? await api.setServerOption(key, value) : { ok: true }
  showMessage(result.ok ? '' : result.error, false, $('#options-error'))
  if (!go || !result.ok) renderServerOptions(latest)
}

for (const input of document.querySelectorAll('#server-options [data-prop]')) {
  input.addEventListener('change', () => saveOption(input))
}
$('#idle-timeout').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.target.blur() })

/* Allow list */

async function changeAllowlist (action, name, ignores) {
  const result = await api.changeAllowlist(action, name, ignores)
  showMessage(result.ok ? '' : result.error, false, $('#allowlist-error'))
  return result.ok
}

function allowlistRow (player) {
  const li = document.createElement('li')
  const who = document.createElement('span')
  who.className = 'who'
  const name = document.createElement('b')
  name.textContent = player.name
  const note = document.createElement('small')
  note.textContent = player.xuid ? 'Linked to their Microsoft account' : 'Not joined yet'
  who.append(name, note)

  const limit = document.createElement('label')
  limit.className = 'check'
  limit.title = 'They can still join when the server is full, up to a few extra places.'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = player.ignoresPlayerLimit
  box.addEventListener('change', async () => {
    box.disabled = true
    if (!await changeAllowlist('limit', player.name, box.checked)) box.checked = !box.checked
    box.disabled = false
  })
  limit.append(box, document.createTextNode('Can join when full'))

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'danger-ghost'
  remove.textContent = 'Remove'
  remove.setAttribute('aria-label', `Remove ${player.name}`)
  remove.addEventListener('click', async () => {
    remove.disabled = true
    if (!await changeAllowlist('remove', player.name)) remove.disabled = false
  })
  li.append(who, limit, remove)
  return li
}

function renderAllowlist (state) {
  const { allowlist, options } = state.settings
  const on = options?.['allow-list']
  const file = allowlist.file === 'allowlist.json' ? '' : ` The server uses ${allowlist.file}, so that's the file changed here.`
  setText($('#allowlist-status'), (on ? 'On: only these players can join.' : 'Off: anyone can join. Turn it on in Server options above to use this list.') + file)

  const broken = Boolean(allowlist.error)
  $('#allowlist-name').disabled = broken
  $('#allowlist-add').disabled = broken
  const error = $('#allowlist-error')
  if (broken) {
    showMessage(allowlist.error, false, error)
    error.dataset.broken = 'yes'
  } else if (error.dataset.broken) {
    showMessage('', false, error)
    delete error.dataset.broken
  }

  // Online players who aren't on the list yet, to add with one click
  const listed = new Set(allowlist.players.map((p) => p.name.toLowerCase()))
  const missing = state.services.server.state === 'ready' && !broken ? state.services.server.players.filter((n) => !listed.has(n.toLowerCase())) : []
  const online = $('#allowlist-online')
  const onlineSig = JSON.stringify(missing)
  if (online.dataset.signature !== onlineSig) {
    online.dataset.signature = onlineSig
    online.hidden = !missing.length
    online.replaceChildren(document.createTextNode('Online now:'), ...missing.map((name) => {
      const add = document.createElement('button')
      add.type = 'button'
      add.textContent = `Add ${name}`
      add.addEventListener('click', async () => { add.disabled = true; if (!await changeAllowlist('add', name)) add.disabled = false })
      return add
    }))
  }

  const list = $('#allowlist-players')
  const signature = JSON.stringify([allowlist.players, broken])
  if (list.dataset.signature === signature) return
  list.dataset.signature = signature
  if (!allowlist.players.length) {
    const empty = document.createElement('li')
    empty.className = 'allowlist-empty'
    empty.textContent = broken ? 'The list can\'t be shown until the file is fixed.' : 'Nobody is on the list yet.'
    list.replaceChildren(empty)
    return
  }
  list.replaceChildren(...allowlist.players.map(allowlistRow))
  if (broken) for (const control of list.querySelectorAll('input, button')) control.disabled = true
}

$('#allowlist-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = $('#allowlist-name')
  if (await changeAllowlist('add', input.value)) input.value = ''
  input.focus()
})

function renderAccount (state) {
  const { account } = state
  const tag = state.bridge.account?.gamertag || account.gamertag
  setText($('#gamertag'), tag || 'Not signed in')
  setText($('#avatar-initial'), tag ? tag.trim().charAt(0).toUpperCase() : '?')
  const img = $('#avatar-img')
  const picture = account.gamertag === tag ? account.picture : ''
  if (picture) { if (img.getAttribute('src') !== picture) img.src = picture } else img.removeAttribute('src')
  img.hidden = !picture
  $('#avatar-initial').hidden = Boolean(picture)
}

function render (state) {
  latest = state

  renderOverall(state)
  renderService($('[data-service="bridge"]'), state.bridge)
  renderAccount(state)
  renderFriends(state)
  renderServerOptions(state)
  renderAllowlist(state)
  renderServerCard(state)
  renderStats(state)
  renderXbox(state)
  renderStatus(state)
  renderConsole(state)
  renderContentSummary()

  const busy = state.busy !== null
  const serverOff = state.services.server.state === 'off' || state.services.server.state === 'crashed'
  const bridgeOn = state.services.bridge.state === 'running'
  const running = !serverOff || bridgeOn
  renderProgress(state.progress)
  els.start.disabled = busy || (!serverOff && bridgeOn)
  els.stop.disabled = busy || !running
  els.refresh.disabled = busy || !running
  $('#server-start').disabled = busy || !serverOff
  $('#server-stop').disabled = busy || serverOff
  $('#bridge-start').disabled = busy || bridgeOn
  $('#bridge-stop').disabled = busy || !bridgeOn
  setText($('#server-start'), state.busy === 'server-up' ? 'Starting' : 'Start server')
  setText($('#server-stop'), state.busy === 'server-down' ? 'Stopping' : 'Stop server')
  setText($('#bridge-start'), state.busy === 'bridge-up' ? 'Starting' : 'Start bridge')
  setText($('#bridge-stop'), state.busy === 'bridge-down' ? 'Stopping' : 'Stop bridge')
  els.update.disabled = busy
  setText($('#start-text'), state.busy === 'up' ? 'Starting' : 'Start')
  setText($('#refresh-text'), state.busy === 'refresh' ? 'Restarting' : 'Restart')
  setText($('#stop-text'), state.busy === 'down' ? 'Stopping' : 'Stop')
  setText(els.update, state.busy === 'update' ? 'Updating' : (state.update?.available ? `Update to ${state.update.latest}` : 'Check for updates'))

  window.hubRender?.(state)
  window.hubCloud?.(state.cloud)
}

/* Status window */

const STATUS_WORD = { pass: 'Passed', warn: 'Check', fail: 'Failed', skip: 'Skipped' }

function statusRow (item, word) {
  const li = document.createElement('li')
  li.dataset.s = item.status
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.setAttribute('aria-hidden', 'true')
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = item.label
  const label = document.createElement('span')
  label.className = 'word'
  label.textContent = word
  const detail = document.createElement('span')
  detail.className = 'detail'
  detail.textContent = item.detail
  li.append(dot, name, label, detail)
  return li
}

function renderStatus (state) {
  if (!state.status) return
  const overall = $('#status-overall')
  overall.dataset.s = state.status.overall
  setText(overall, state.status.headline)
  const list = $('#status-list')
  const signature = JSON.stringify(state.status.items)
  if (list.dataset.signature === signature) return
  list.dataset.signature = signature
  list.replaceChildren(...state.status.items.map((item) => statusRow(item, item.word)))
}

function renderChecks (result) {
  const message = $('#checks-message')
  showMessage(result.summary, result.level === 'pass', message)
  $('#check-list').replaceChildren(...result.results.map((r) => statusRow(r, STATUS_WORD[r.status])))
  const final = $('#check-final')
  final.hidden = !result.finalStep
  setText(final, result.finalStep || '')
}

async function runSetupTest () {
  const button = $('#run-checks')
  button.disabled = true
  setText(button, 'Testing')
  const result = await api.runChecks()
  button.disabled = false
  setText(button, 'Run setup test')
  if (!result.ok) { showMessage(result.error || 'The test couldn\'t run.', false, $('#checks-message')); return }
  renderChecks(result)
}

$('#open-status').addEventListener('click', () => {
  if (latest) renderStatus(latest)
  showMessage('', false, $('#checks-message'))
  openDialog(dialogs.status)
})
$('#run-checks').addEventListener('click', runSetupTest)

/* Console */

const commandBox = $('#command')
const commandNote = $('#command-note')
const COMMAND_HINT = 'For example: list, say Hello, or kick Name. Press the up arrow for earlier commands.'
const history = []
let historyAt = 0
let commandError = ''

function renderConsole (state) {
  const ready = state.services.server.state === 'ready'
  $('#send-command').disabled = !ready
  commandNote.classList.toggle('bad', Boolean(commandError))
  setText(commandNote, commandError || (ready ? COMMAND_HINT : 'Start the server to send commands.'))
}

async function sendCommand () {
  const text = commandBox.value
  const result = await api.sendCommand(text)
  commandError = result.ok ? '' : result.error
  if (result.ok) {
    if (history[history.length - 1] !== text) history.push(text)
    historyAt = history.length
    commandBox.value = ''
  }
  if (latest) renderConsole(latest)
}

$('#send-command').addEventListener('click', sendCommand)
commandBox.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { sendCommand(); return }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  historyAt = Math.min(history.length, Math.max(0, historyAt + (event.key === 'ArrowUp' ? -1 : 1)))
  commandBox.value = history[historyAt] ?? ''
})

/* Content Log */

const contentList = $('#content-list')
const contentLevel = $('#content-level')
const contentSearch = $('#content-search')
const contentRows = new Map() // entry id to { entry, row }
const LEVEL_WORD = { error: 'Error', warning: 'Warning', info: 'Info' }

function contentMatches (entry) {
  if (contentLevel.value !== 'all' && entry.level !== contentLevel.value) return false
  const search = contentSearch.value.trim().toLowerCase()
  if (!search) return true
  return `${entry.category} ${entry.message} ${entry.detail}`.toLowerCase().includes(search)
}

function makeContentRow () {
  const row = document.createElement('li')
  const part = (name, tag = 'span') => { const node = document.createElement(tag); node.className = name; return node }
  const text = part('text')
  text.append(part('category'), part('said'))
  row.append(part('time'), part('level'), text, part('count'), part('trace', 'pre'))
  return row
}

function fillContentRow (row, entry) {
  row.dataset.level = entry.level
  setText($('.time', row), entry.time)
  setText($('.level', row), LEVEL_WORD[entry.level])
  setText($('.category', row), `[${entry.category}] `)
  setText($('.said', row), entry.message)
  setText($('.count', row), entry.count > 1 ? `x${entry.count}` : '')
  setText($('.trace', row), entry.detail)
  row.hidden = !contentMatches(entry)
}

function renderContentSummary () {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const { entry } of contentRows.values()) counts[entry.level]++
  const tab = $('#tab-content')
  setText(tab, counts.error ? `Content Log (${counts.error})` : 'Content Log')
  tab.classList.toggle('has-errors', counts.error > 0)
  const badge = $('#badge-console')
  setText(badge, counts.error ? String(counts.error) : '')
  badge.classList.toggle('alert', counts.error > 0)
  for (const option of contentLevel.options) {
    const word = { all: 'Everything', error: 'Errors', warning: 'Warnings', info: 'Info' }[option.value]
    const n = option.value === 'all' ? contentRows.size : counts[option.value]
    setText(option, `${word} (${n})`)
  }

  const empty = $('#content-empty')
  const serverUp = latest?.services.server.state === 'ready'
  let text = ''
  if (!contentRows.size) text = serverUp ? 'Nothing reported. Your add-ons loaded without a message.' : 'Nothing yet. Messages appear here when the server starts.'
  else if (![...contentRows.values()].some(({ row }) => !row.hidden)) text = 'Nothing matches.'
  setText(empty, text)
  contentList.hidden = !contentRows.size
  $('#content-copy').disabled = !contentRows.size
  $('#content-clear').disabled = !contentRows.size
}

function applyContent (entry) {
  if (!entry) {
    contentRows.clear()
    contentList.replaceChildren()
    renderContentSummary()
    return
  }
  const nearBottom = contentList.scrollHeight - contentList.scrollTop - contentList.clientHeight < 40
  let known = contentRows.get(entry.id)
  if (!known) {
    known = { entry, row: makeContentRow() }
    contentRows.set(entry.id, known)
    contentList.append(known.row)
  }
  known.entry = entry
  fillContentRow(known.row, entry)
  if (nearBottom) contentList.scrollTop = contentList.scrollHeight
  renderContentSummary()
}

function filterContent () {
  for (const { entry, row } of contentRows.values()) row.hidden = !contentMatches(entry)
  renderContentSummary()
}

contentLevel.addEventListener('change', filterContent)
contentSearch.addEventListener('input', filterContent)
$('#content-clear').addEventListener('click', async () => {
  setText($('#content-note'), '')
  await api.clearContent()
})
$('#content-copy').addEventListener('click', async () => {
  await api.copyContent()
  setText($('#content-note'), 'Copied.')
})

function renderProgress (progress) {
  const box = $('#progress')
  box.hidden = !progress
  if (!progress) return
  const pct = Math.round(progress.value * 100)
  setText($('#progress-label'), progress.label)
  setText($('#progress-pct'), `${pct}%`)
  $('#progress-fill').style.width = `${pct}%`
  $('.meter', box).setAttribute('aria-valuenow', String(pct))
}

function appendLog (line) {
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40
  els.log.append(document.createTextNode(line + '\n'))
  while (els.log.childNodes.length > 500) els.log.firstChild.remove()
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight
}

/* Actions */

async function startStack (errorNode = els.message, action = 'up') {
  if (!latest) return
  showMessage('', false, errorNode)
  if (!latest.settings.configured) {
    if (errorNode !== els.message) errorNode.closest('dialog')?.close()
    window.hubShow?.('server')
    showMessage('Enter this VM\'s public IP address in the Server card first.')
    $('#host').focus()
    return
  }
  const result = await api.run(action)
  if (!result.ok) showMessage(result.error, false, errorNode)
}

async function runPart (action) {
  showMessage('')
  const result = await api.run(action)
  if (!result.ok) showMessage(result.error)
}

els.start.addEventListener('click', () => startStack())
$('#server-start').addEventListener('click', () => startStack(els.message, 'server-up'))
$('#bridge-start').addEventListener('click', () => startStack(els.message, 'bridge-up'))
$('#server-stop').addEventListener('click', () => runPart('server-down'))
$('#bridge-stop').addEventListener('click', () => runPart('bridge-down'))
els.refresh.addEventListener('click', async () => {
  showMessage('')
  const result = await api.run('refresh')
  if (!result.ok) showMessage(result.error)
})
els.stop.addEventListener('click', async () => {
  showMessage('')
  const result = await api.run('down')
  if (!result.ok) showMessage(result.error)
})
els.update.addEventListener('click', async () => {
  showMessage('')
  const result = await api.updateServer()
  showMessage(result.ok ? (result.message || '') : result.error, result.ok)
})

/* Dialogs */

function openDialog (dialog) {
  if (!dialog.open) dialog.showModal()
}

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close]')
  if (close) close.closest('dialog').close()
})

// Log in to Xbox
const xboxError = $('#xbox-error')
for (const row of document.querySelectorAll('[data-xbox]')) wireSignIn(row, xboxError)
wireSignIn($('.account-card'), els.message)
els.login.addEventListener('click', () => {
  if (!latest) return
  showMessage('', false, xboxError)
  renderXbox(latest)
  openDialog(dialogs.xbox)
})
$('#xbox-start').addEventListener('click', () => startStack(xboxError, 'bridge-up'))

// Server card: the address saves when you leave the box
const serverNote = $('#server-note')

function note (text, tone) {
  serverNote.classList.toggle('bad', tone === 'bad')
  setText(serverNote, text)
}

async function saveAddress () {
  if (!latest) return
  const host = $('#host').value
  if (host.trim() === latest.settings.host) return
  const result = await api.saveSettings({ host })
  if (!result.ok) { note(result.error, 'bad'); return }
  $('#host').dataset.saved = result.settings.host
  note('Saved. It applies the next time the server starts.')
}
$('#host').addEventListener('change', saveAddress)
$('#host').addEventListener('keydown', (event) => { if (event.key === 'Enter') saveAddress() })

/* Go, once hub.js and library.js have loaded too */

window.addEventListener('DOMContentLoaded', () => {
  api.onState(render)
  api.onLog(appendLog)
  api.onContent(applyContent)
  api.getState().then(({ state, log, content }) => {
    for (const line of log) appendLog(line)
    for (const entry of content) applyContent(entry)
    render(state)
  })
})
