'use strict'

// The Mod Library page. It needs no world and no server: it is your mods, in one folder, and where they are used.
// Worlds and the server are places a mod can go. The engine does the work, and this file shows it.

const lib = {
  view: null,
  filter: 'all',
  detail: null,
  tab: 'overview',
  checking: false
}

const STATE_WORDS = {
  current: ['Up to date', 'ok'],
  behind: ['Update available', 'warn'],
  ahead: ['Newer than the library', 'accent'],
  edited: ['Files differ from the library', 'warn'],
  missing: ['Files missing', 'bad'],
  unknown: ['Not in the library', '']
}

/* Keeping up to date */

async function checkLibrary () {
  if (lib.checking) return
  lib.checking = true
  await refreshLib()
  const result = await ask('library.check', {}, { quiet: true })
  lib.checking = false
  if (!result) { renderLibStats(); return }
  applyLib(result.library)
  announceUpdates(result.updates)
  if (result.moved) notify(`Moved ${plural(result.moved, 'mod')} into your library folder`, 'Old saved versions were deleted to save space.', 'ok', 'library')
  if (result.unpacked) notify(`Unpacked ${plural(result.unpacked, 'archive')} in your library`, 'The original packs are now stored as extracted folders.', 'ok', 'library')
  if (result.changed) await refreshMods()
}

function announceUpdates (updates) {
  for (const update of updates) {
    const what = update.edited ? `Version ${update.to} has different files than before.` : `${update.from} to ${update.to}.`
    notify(`${update.name} was updated`, `${what} Open it in the Library to see what changed.`, 'warn', 'library', `updated-${update.uuid}`)
  }
}

async function refreshLib () {
  const view = await ask('library', {}, { quiet: true })
  if (view) applyLib(view)
}

function applyLib (view) {
  lib.view = view
  renderLibFilters()
  renderLibGrid()
  renderLibStats()
  renderLibBadge()
  renderLibBanners()
  loadLibIcons()
  if (lib.detail && !view.mods.some((m) => m.id === lib.detail.id)) closeLibDetail()
  renderStorage()
}

function renderLibBadge () {
  const badge = $('#badge-library')
  const mods = lib.view?.mods || []
  const waiting = mods.filter(needsAttention).length
  setText(badge, waiting ? String(waiting) : (mods.length ? String(mods.length) : ''))
  badge.classList.toggle('alert', waiting > 0)
}

const needsAttention = (mod) => mod.fresh || mod.behind.length > 0

async function loadLibIcons () {
  const need = (lib.view?.mods || []).map((m) => m.id).filter((id) => !ui.icons.has(id))
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

/* Adding */

async function addToLibrary (kind) {
  const plan = await api.addToLibrary(kind)
  if (plan.canceled) return
  if (!plan.ok) { say(plan.error); showMessage(plan.error); return }
  await chooseImport(plan.result)
}

const IMPORT_WORDS = { new: 'Add it', update: 'Replace the older copy', edited: 'Replace: same version, different files', older: 'Older than yours. Replaces it if ticked', same: 'Already there' }

function chooseImport (plan) {
  const dialog = $('#dlg-import')
  if (!plan.rows.length) {
    say('No mods were found there.')
    showMessage(plan.problems.length ? `No mods were found there. ${plan.problems[0]}` : 'No mods were found there. A mod has a manifest.json inside it.')
    return Promise.resolve(false)
  }
  const looseCount = plan.rows.filter((r) => r.loose).length
  setText($('#import-title'), `Add ${plural(plan.rows.length, 'mod')} to the library`)
  setText($('#import-note'), `${looseCount ? `${plural(looseCount, 'loose folder')} will be copied into the library. ` : ''}Archives are extracted. When a mod replaces an older copy, the old folders aren't kept.`)
  $('#import-rows').replaceChildren(...plan.rows.map((row) => h('tr', { title: row.source },
    h('td', {}, h('input', { type: 'checkbox', checked: row.status !== 'older' && row.status !== 'same', data: { key: row.key }, 'aria-label': `Add ${row.name}` })),
    h('td', { textContent: `${row.name} (${row.contents})` }),
    h('td', { textContent: row.version }),
    h('td', { textContent: row.libraryVersion || '-' }),
    h('td', { textContent: IMPORT_WORDS[row.status] }))))
  const lockedCount = plan.rows.filter((r) => !r.canMove).length
  const mode = $('#import-mode')
  mode.disabled = lockedCount === plan.rows.length
  dialog.querySelector('input[value="copy"]').checked = true
  setText($('#import-locked'), lockedCount ? `${plural(lockedCount, 'mod')} can only be copied, because the original is in a world, the server or the library, or is one part of a larger file.` : '')
  return new Promise((resolve) => {
    let started = false
    const go = $('#import-go')
    go.onclick = async () => {
      started = true
      const keys = [...$('#import-rows').querySelectorAll('input:checked')].map((box) => box.dataset.key)
      const how = dialog.querySelector('input[name="import-mode"]:checked').value
      dialog.close()
      resolve(await runImport(plan.token, how, keys))
    }
    dialog.addEventListener('close', () => { if (!started) resolve(false) }, { once: true })
    openDialog(dialog)
  })
}

async function runImport (token, mode, keys) {
  if (!keys.length) { say('Nothing was ticked.'); return false }
  say('Adding to the library...')
  const result = await api.mods('library.import', { token, mode, keys })
  if (!result.ok) { say(result.error); showMessage(result.error); return false }
  const r = result.result
  const text = `Library: ${r.added} added, ${r.updated} updated, ${r.skipped} already there${r.moved ? `, ${r.moved} moved` : ''}.`
  say(text)
  notify(text, '', r.problems.length ? 'err' : 'ok', 'library')
  announceUpdates(r.changes)
  if (r.problems.length) report('Some of it didn\'t work', 'The other mods weren\'t affected.', r.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })))
  await refreshMods()
  await afterChange()
  return true
}

$('#lib-add-files').addEventListener('click', () => addToLibrary('file'))
$('#lib-add-folder').addEventListener('click', () => addToLibrary('folder'))
$('#lib-rescan').addEventListener('click', rescan)
for (const id of ['#lib-open', '#settings-open-library']) {
  $(id).addEventListener('click', async () => {
    const result = await api.openLibrary()
    if (!result.ok) say(result.error)
  })
}

function renderLibBanners () {
  const old = lib.view?.oldSources || []
  $('#lib-old').hidden = !old.length
  if (old.length) setText($('#lib-old-text'), `The library used to read mods from ${old.join(', ')}. Bring those mods into the library folder?`)
  const outside = (lib.view?.mods || []).filter((m) => !m.inLibrary)
  $('#lib-outside').hidden = !outside.length
  if (outside.length) setText($('#lib-outside-text'), `${plural(outside.length, 'mod')} in your worlds or on the server ${outside.length === 1 ? 'isn\'t' : 'aren\'t'} in the library yet.`)
}

$('#lib-old-skip').addEventListener('click', async () => {
  const view = await ask('library.oldDone')
  if (view) applyLib(view)
})
$('#lib-old-go').addEventListener('click', async () => {
  const plan = await ask('library.inspectOld')
  if (!plan) return
  const done = plan.rows.length ? await chooseImport(plan) : true
  if (done) {
    const view = await ask('library.oldDone')
    if (view) applyLib(view)
  }
})
$('#lib-outside-go').addEventListener('click', () => adoptMods(null))

async function adoptMods (id) {
  const answer = await api.mods('library.adopt', id ? { id } : {})
  if (!answer.ok) { say(answer.error); showMessage(answer.error); return }
  const r = answer.result
  say(`Library: ${r.added} added, ${r.updated} updated. The copies in worlds and on the server weren't changed.`)
  announceUpdates(r.changes)
  if (r.problems.length) report('Some of it didn\'t work', 'The other mods weren\'t affected.', r.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })))
  await refreshMods()
  await refreshLib()
  if (lib.detail) await reloadLibDetail()
}

/* Browsing */

const LIB_FILTERS = {
  all: ['All', () => true],
  updates: ['Updates', needsAttention],
  used: ['In use', (m) => m.worlds.length > 0],
  unused: ['Not in use', (m) => m.worlds.length === 0],
  fav: ['Favorites', (m) => m.fav],
  outside: ['Not in library', (m) => !m.inLibrary],
  unnamed: ['Unnamed', (m) => m.unnamed]
}

function renderLibFilters () {
  const mods = lib.view?.mods || []
  $('#lib-filters').replaceChildren(...Object.entries(LIB_FILTERS).map(([key, [label, test]]) => {
    const count = mods.filter(test).length
    return (key === 'outside' || key === 'unnamed') && !count && lib.filter !== key
      ? null
      : h('button', { type: 'button', role: 'tab', class: lib.filter === key ? 'on' : '', 'aria-selected': lib.filter === key ? 'true' : 'false', textContent: `${label} ${count}`, on: { click: () => { lib.filter = key; renderLibFilters(); renderLibGrid() } } })
  }).filter(Boolean))

  const tags = uniq(mods.flatMap((m) => m.tags)).sort()
  const box = $('#lib-tag')
  const chosen = box.value
  box.replaceChildren(h('option', { value: '', textContent: 'All tags' }), ...tags.map((tag) => h('option', { value: tag, textContent: tag })))
  box.value = tags.includes(chosen) ? chosen : ''
  box.hidden = !tags.length
}

function libShown () {
  const mods = lib.view?.mods || []
  const search = $('#lib-search').value.trim().toLowerCase()
  const kind = $('#lib-kind').value
  const tag = $('#lib-tag').value
  const list = mods.filter((m) => LIB_FILTERS[lib.filter][1](m) &&
    (!kind || m.kinds.includes(kind)) &&
    (!tag || m.tags.includes(tag)) &&
    (!search || [m.name, m.description, m.note, ...m.tags, ...m.authors].join(' ').toLowerCase().includes(search)))
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  switch ($('#lib-sort').value) {
    case 'recent': return list.sort((a, b) => b.mtime - a.mtime || byName(a, b))
    case 'added': return list.sort((a, b) => b.added - a.added || byName(a, b))
    case 'used': return list.sort((a, b) => b.worlds.length - a.worlds.length || byName(a, b))
    default: return list.sort(byName)
  }
}

function libIcon (mod, large = false) {
  const src = ui.icons.get(mod.id)
  return h('div', { class: `lib-art${large ? ' large' : ''}`, data: { icon: mod.id } }, src ? h('img', { src, alt: '' }) : (mod.name.trim().charAt(0).toUpperCase() || '?'))
}

function usedText (mod) {
  if (mod.worlds.length) return mod.worlds.length === 1 ? `In ${mod.worlds[0].name}` : `In ${mod.worlds.length} worlds`
  return mod.onServer ? 'On the server, in no world' : 'Not in use'
}

function renderLibGrid () {
  const shown = libShown()
  $('#lib-grid').replaceChildren(...shown.map((mod) => h('button', { type: 'button', class: `lib-tile${needsAttention(mod) ? ' attention' : ''}`, title: mod.description || mod.name, on: { click: () => openLibMod(mod.id) } },
    mod.fresh ? h('span', { class: 'lib-flag', textContent: 'Updated' }) : (mod.behind.length ? h('span', { class: 'lib-flag quiet', textContent: 'Worlds behind' }) : (mod.inLibrary ? null : h('span', { class: 'lib-flag quiet', textContent: 'Not in library' }))),
    h('span', { class: `lib-star${mod.fav ? ' on' : ''}`, textContent: mod.fav ? '★' : '' }),
    libIcon(mod),
    h('span', { class: 'lib-name', textContent: `${mod.unnamed ? '? ' : ''}${mod.name}` }),
    h('span', { class: 'lib-sub', textContent: `${mod.contents} · ${mod.version}` }),
    h('span', { class: 'lib-foot' },
      h('span', { class: mod.worlds.length ? 'used' : '', textContent: usedText(mod) })))))
  const empty = $('#lib-empty')
  empty.hidden = shown.length > 0 || !ui.engineReady
  if (!shown.length) {
    setText(empty, lib.view?.mods.length ? 'No mods match. Clear the search or choose another filter.'
      : ui.scanning ? 'Scanning...' : 'Your library is empty. Press Add mods to import .mcaddon, .mcpack or .zip files, or a folder of mods. Imported packs are stored as extracted folders.')
  }
  const chip = $('#lib-problems')
  const issues = lib.view?.issues || []
  chip.hidden = !issues.length
  if (issues.length) setText(chip, `${plural(issues.length, 'file')} could not be read`)
}

function renderLibStats () {
  const mods = lib.view?.mods || []
  const fresh = mods.filter((m) => m.fresh).length
  const behind = uniq(mods.flatMap((m) => m.behind)).length
  const parts = [plural(mods.length, 'mod')]
  if (lib.view) parts.push(`${plural(lib.view.storage.folders, 'pack folder')} in the library, ${lib.view.storage.text}`)
  if (fresh) parts.push(`${plural(fresh, 'mod')} updated`)
  if (behind) parts.push(`${plural(behind, 'world')} behind`)
  setText($('#lib-stats'), parts.join(' · '))
}

for (const id of ['#lib-search', '#lib-kind', '#lib-tag', '#lib-sort']) {
  $(id).addEventListener(id === '#lib-search' ? 'input' : 'change', renderLibGrid)
}
$('#lib-problems').addEventListener('click', () => {
  report('Files that could not be read', 'They were skipped. Nothing else was affected.', (lib.view?.issues || []).map((i) => ({ status: 'warn', label: i.text, word: '', detail: [i.hint, i.path].filter(Boolean).join(' ') })))
})

/* One mod */

async function openLibMod (id, tab = null) {
  const detail = await ask('library.detail', { id })
  if (!detail) return
  lib.detail = detail
  lib.tab = tab || (detail.packs.some((p) => p.unread) ? 'changes' : 'overview')
  $('#lib-browse').hidden = true
  $('#lib-detail').hidden = false
  $('#content').scrollTop = 0
  renderLibDetail()
}
window.hubOpenMod = openLibMod

function closeLibDetail () {
  lib.detail = null
  $('#lib-browse').hidden = false
  $('#lib-detail').hidden = true
  renderLibGrid()
}
$('#lib-back').addEventListener('click', closeLibDetail)

async function reloadLibDetail () {
  if (!lib.detail) return
  const detail = await ask('library.detail', { id: lib.detail.id }, { quiet: true })
  if (!detail) { closeLibDetail(); return }
  lib.detail = detail
  renderLibDetail()
}

const libMod = () => lib.view?.mods.find((m) => m.id === lib.detail?.id)

function renderLibDetail () {
  const mod = libMod()
  if (!lib.detail || !mod) return
  const canAdopt = !mod.inLibrary || mod.ahead.length > 0
  $('#lib-head').replaceChildren(
    libIcon(mod, true),
    h('div', { class: 'lib-head-text' },
      h('div', { class: 'title-line' }, h('h3', { textContent: mod.name }),
        h('button', { type: 'button', class: `star${mod.fav ? ' on' : ''}`, textContent: mod.fav ? '★' : '☆', 'aria-label': mod.fav ? 'Remove from favorites' : 'Add to favorites', on: { click: () => setLibMeta({ fav: !mod.fav }) } })),
      h('p', { class: 'sub', textContent: `${mod.contents} · version ${mod.version}${mod.authors.length ? ` · by ${mod.authors.join(', ')}` : ''}` }),
      h('div', { class: 'row' },
        mod.fresh ? h('span', { class: 'chip warn', textContent: 'Updated since you last looked' }) : null,
        mod.inLibrary ? null : h('span', { class: 'chip warn', textContent: 'Not in the library' }),
        mod.tags.map((tag) => h('span', { class: 'chip', textContent: tag })))),
    h('div', { class: 'row lib-head-actions' },
      mod.fresh ? h('button', { type: 'button', textContent: 'Mark as reviewed', on: { click: markReviewed } }) : null,
      canAdopt ? h('button', { type: 'button', textContent: mod.inLibrary ? 'Update the library from the newer copy' : 'Add to the library', on: { click: () => adoptMods(mod.id) } }) : null,
      h('button', { type: 'button', class: 'primary', textContent: 'Add to a world', disabled: !lib.view.worlds.length, title: lib.view.worlds.length ? '' : 'There are no worlds yet.', on: { click: chooseWorldForMod } })))
  for (const button of $('#lib-tabs').children) {
    const on = button.dataset.tab === lib.tab
    button.classList.toggle('on', on)
    button.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  const updates = lib.detail.packs.reduce((n, p) => n + p.changes.length, 0)
  setText($('#lib-tabs [data-tab="changes"]'), updates ? `What changed (${updates})` : 'What changed')
  setText($('#lib-tabs [data-tab="worlds"]'), `Where it's used (${lib.detail.worlds.length})`)
  const body = $('#lib-body')
  body.replaceChildren()
  if (lib.tab === 'overview') renderOverview(body, mod)
  else if (lib.tab === 'changes') renderChanges(body)
  else renderWorldsTab(body, mod)
}

$('#lib-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]')?.dataset.tab
  if (!tab) return
  lib.tab = tab
  renderLibDetail()
})

async function setLibMeta (fields) {
  const view = await ask('meta.set', { id: lib.detail.id, ...fields })
  if (!view) return
  applyMods(view)
  await refreshLib()
  renderLibDetail()
}

async function markReviewed () {
  const view = await ask('library.review', { id: lib.detail.id })
  if (!view) return
  for (const uuid of libMod().uuids) clearNote(`updated-${uuid}`)
  applyLib(view)
  await reloadLibDetail()
}

/* Overview */

function renderOverview (body, mod) {
  const contents = h('div', { class: 'pack-sections' }, h('p', { class: 'note', textContent: 'Reading the pack...' }))
  const tags = h('input', { id: 'lib-tags', autocomplete: 'off', spellcheck: false, value: mod.tags.join(', ') })
  const note = h('textarea', { id: 'lib-note', rows: 3, value: mod.note })
  const saveNotes = () => {
    const wanted = uniq(tags.value.split(',').map((t) => t.trim()).filter(Boolean))
    if (JSON.stringify(wanted) !== JSON.stringify(mod.tags) || note.value.trim() !== mod.note) setLibMeta({ tags: wanted, note: note.value.trim() })
  }
  tags.addEventListener('change', saveNotes)
  note.addEventListener('change', saveNotes)
  const facts = h('dl', { class: 'details' })
  body.append(
    h('div', { class: 'lib-columns' },
      h('section', { class: 'card column' },
        h('h3', { textContent: 'About' }),
        mod.description ? h('p', { textContent: mod.description }) : null,
        facts,
        h('div', { class: 'row' },
          h('button', { type: 'button', textContent: 'Show in library', on: { click: async () => { const r = await api.openPack(lib.detail.packs[0].uuid); if (!r.ok) say(r.error) } } }),
          h('button', { type: 'button', textContent: 'Set my own label', on: { click: labelMod } }),
          mod.inLibrary || mod.partlyInLibrary ? h('button', { type: 'button', class: 'danger-ghost', textContent: 'Delete from library', on: { click: deleteFromLibrary } }) : null)),
      h('section', { class: 'card column' },
        h('h3', { textContent: 'Your notes' }),
        h('div', { class: 'field' }, h('label', { for: 'lib-tags', textContent: 'Tags, separated by commas' }), tags),
        h('div', { class: 'field' }, h('label', { for: 'lib-note', textContent: 'Notes' }), note))),
    h('section', { class: 'card column' }, h('h3', { textContent: 'What is in it' }), contents))
  fillOverview(facts, contents)
}

async function fillOverview (facts, contents) {
  const rows = []
  const parts = []
  const files = uniq(lib.detail.packs.map((p) => p.file).filter(Boolean))
  if (files.length) rows.push(['Library folder', files.join(', ')], ['Folder size', lib.detail.packs.find((p) => p.fileSize)?.fileSize])
  for (const pack of lib.detail.packs) {
    const info = await ask('pack.info', { uuid: pack.uuid }, { quiet: true })
    if (!info) continue
    if (!parts.length) {
      rows.push(['Authors', info.authors.join(', ')], ['Licence', info.license], ['Website', info.url], ['Minimum game version', info.minEngine], ['Problem', info.error])
    }
    const lines = [['Identifier', info.uuid], ['Files', `${info.files}, ${info.size}`], ['Namespaces', info.namespaces.join(', ')]]
    for (const [cat, idents] of Object.entries(info.idents)) lines.push([cat[0].toUpperCase() + cat.slice(1) + 's', idents.join(', ')])
    lines.push(['Names shown in game', info.displayNames.join(', ')], ['Needs', info.deps.map((d) => `${d.name || d.id} ${d.version}`).join(', ')], ['Scripts', info.scripts.join(', ')], ['Needed by', info.neededBy.join(', ')])
    parts.push(h('div', {}, h('h4', { class: 'lib-pack-title', textContent: `${pack.kind} pack: ${pack.name}` }), lines.filter(([, v]) => v).map(([k, v]) => h('div', { class: 'lib-line' }, h('h4', { textContent: k }), h('p', { textContent: v })))))
  }
  facts.replaceChildren(...rows.filter(([, v]) => v).map(([k, v]) => h('div', {}, h('dt', { textContent: k }), h('dd', { textContent: v }))))
  contents.replaceChildren(...(parts.length ? parts : [h('p', { class: 'note', textContent: 'The pack could not be read.' })]))
}

async function labelMod () {
  const pack = lib.detail.packs[0]
  const current = ui.config?.aliases?.[pack.uuid] || ''
  const name = await promptFor('Set my own label', 'This name is used everywhere for this pack. Leave it empty to remove the label.', current, 'Save', true)
  if (name === null) return
  const view = await ask('label.set', { uuid: pack.uuid, name })
  if (!view) return
  applyMods(view)
  ui.config = await ask('config')
  await refreshLib()
  await reloadLibDetail()
}

async function deleteFromLibrary () {
  const mod = libMod()
  const places = mod.worlds.length + (mod.onServer ? 1 : 0)
  const sure = await api.confirm({ danger: true, message: `Delete ${mod.name} from the library?`, detail: `Its file goes to the Recycle Bin, and the record of its past updates is deleted. ${places ? 'You can choose next whether to remove it from your worlds and the server too.' : 'No world or server uses it.'}`, yes: 'Delete from library' })
  if (!sure.yes) return
  let everywhere = false
  if (places) {
    const names = [...mod.worlds.map((w) => w.name), ...(mod.onServer ? ['The server folder'] : [])]
    const also = await api.confirm({ danger: true, message: 'Remove it from these as well?', detail: `${names.slice(0, 10).map((n) => `- ${n}`).join('\n')}\n\nChoose Cancel to leave those copies where they are. They'll then show as not in the library.`, yes: 'Remove from these too' })
    everywhere = also.yes
  }
  const result = await ask('library.delete', { id: mod.id, everywhere })
  if (!result) return
  say(`Deleted ${mod.name} from the library.`)
  notify(`Deleted ${mod.name} from the library`, everywhere ? 'It was removed from your worlds and the server too.' : '', 'ok')
  if (result.problems.length) report('Some of it didn\'t work', '', result.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })))
  closeLibDetail()
  applyLib(result.library)
  await refreshMods()
  await afterChange()
}

/* What changed */

function contentBlock (title, groups, cls) {
  const names = Object.entries(groups)
  if (!names.length) return null
  return h('section', { class: `card column lib-change ${cls}` },
    h('h3', { textContent: title }),
    names.map(([cat, idents]) => h('div', {}, h('h4', { textContent: `${cat} (${idents.length})` }), h('p', { class: 'mono', textContent: idents.join(', ') }))))
}

function renderChanges (body) {
  const entries = lib.detail.packs.flatMap((pack) => pack.changes.map((change) => ({ pack, change }))).sort((a, b) => b.change.at - a.change.at)
  if (!entries.length) {
    body.append(h('p', { class: 'empty', textContent: 'No updates recorded yet. When a newer copy of this mod is added, what changed is written down here. Old versions aren\'t kept.' }))
    return
  }
  entries.forEach(({ pack, change }, i) => body.append(changeCard(pack, change, i === 0)))
}

function changeCard (pack, change, open) {
  const c = change.counts
  const box = h('div', { class: 'view' })
  const card = h('section', { class: `card column lib-update${pack.unread && open ? ' unread' : ''}` },
    h('div', { class: 'lib-update-head' },
      h('h3', { textContent: change.edited ? `${pack.name}: ${change.to}, files changed` : `${pack.name}: ${change.from} to ${change.to}` }),
      h('span', { class: 'note', textContent: `${new Date(change.at).toLocaleDateString()} · ${c.added} files added, ${c.removed} removed, ${c.changed} changed` })),
    box)
  const fill = () => {
    box.replaceChildren()
    if (change.notes.length) box.append(h('ul', { class: 'lib-notes' }, change.notes.map((n) => h('li', { textContent: n }))))
    if (change.authorNotes) box.append(h('div', {}, h('h4', { textContent: 'The author\'s notes' }), h('pre', { class: 'lib-author', textContent: change.authorNotes })))
    const blocks = [contentBlock('Added', change.added, 'add'), contentBlock('Changed', change.changed, 'chg'), contentBlock('Removed', change.removed, 'rem')].filter(Boolean)
    if (blocks.length) box.append(h('div', { class: 'lib-columns three' }, blocks))
    if (change.files.length) {
      const view = h('div', { class: 'lib-file-view' })
      box.append(h('div', { class: 'lib-files' }, change.files.map((file) => h('button', { type: 'button', class: `lib-file ${file.status}`, on: { click: (e) => showFile(file, view, e.currentTarget) } },
        h('span', { class: 'lib-file-mark', textContent: { added: '+', removed: '-', changed: '~' }[file.status], 'aria-label': file.status }),
        h('span', { class: 'lib-file-path', textContent: file.path }),
        h('span', { class: 'lib-file-count' },
          file.adds ? h('span', { class: 'add', textContent: `+${file.adds}` }) : null,
          file.dels ? h('span', { class: 'rem', textContent: ` -${file.dels}` }) : null,
          file.adds === null ? fileSize(file) : null)))), view)
    }
  }
  if (open) fill()
  else box.append(h('div', {}, h('button', { type: 'button', textContent: 'Show this update', on: { click: fill } })))
  return card
}

function fileSize (file) {
  const size = file.after ?? file.before ?? 0
  return size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}

function showFile (file, box, button) {
  for (const row of button.parentElement.children) row.classList.toggle('on', row === button)
  const title = h('h4', { class: 'mono', textContent: file.path })
  if (!file.hunks) {
    const size = (n) => n === null ? 'none' : `${Math.max(1, Math.round(n / 1024))} KB`
    box.replaceChildren(title, h('p', { class: 'note', textContent: file.kind === 'text' ? 'This file changed too much to keep every line.' : `Only text files keep their changed lines. Size before: ${size(file.before)}, after: ${size(file.after)}.` }))
    return
  }
  const rows = []
  file.hunks.forEach((hunk, i) => {
    if (i) rows.push(h('div', { class: 'diff-gap', textContent: '...' }))
    for (const [mark, text, oldNo, newNo] of hunk) {
      rows.push(h('div', { class: `diff-line${mark === '+' ? ' add' : mark === '-' ? ' rem' : ''}` },
        h('span', { class: 'diff-no', textContent: oldNo ?? '' }), h('span', { class: 'diff-no', textContent: newNo ?? '' }),
        h('span', { class: 'diff-mark', textContent: mark }), h('span', { class: 'diff-text', textContent: text })))
    }
  })
  box.replaceChildren(title, h('div', { class: 'diff', tabIndex: 0 }, rows))
  if (file.cut) box.append(h('p', { class: 'note', textContent: 'That is the first part. The change is too long to show all of it.' }))
}

/* Where it's used */

const busyNow = () => latest?.busy !== null || latest?.modsBusy

function renderWorldsTab (body, mod) {
  const rows = []
  const many = lib.detail.packs.length > 1
  const seen = new Set()
  for (const pack of lib.detail.packs) {
    for (const use of pack.usage) {
      const [word, tone] = STATE_WORDS[use.state] || STATE_WORDS.unknown
      const needsUpdate = use.state === 'behind' || use.state === 'edited'
      rows.push(h('tr', {},
        h('td', {}, h('button', { type: 'button', class: 'link', textContent: use.name, title: 'Open this world\'s mods', on: { click: () => window.hubOpenWorldMods(use.folder) } })),
        h('td', { textContent: many ? `${pack.kind}: ${pack.name}` : pack.kind }),
        h('td', { textContent: use.version }),
        h('td', { textContent: { world: 'Its own copy', server: 'Server folder', missing: 'Nowhere' }[use.where] }),
        h('td', {}, h('span', { class: `chip ${tone}`, textContent: word })),
        h('td', {}, h('div', { class: 'row' },
          pack.file ? h('button', { type: 'button', class: needsUpdate ? 'primary' : '', textContent: needsUpdate ? 'Update' : 'Reinstall', disabled: busyNow(), on: { click: () => applyToTargets([use.folder]) } }) : null,
          h('button', { type: 'button', class: 'danger-ghost', textContent: 'Remove', disabled: busyNow(), on: { click: () => removeFromWorldTab(mod, use, pack) } })))))
      seen.add(use.folder)
    }
    if (pack.server) {
      const [word, tone] = STATE_WORDS[pack.server.state] || STATE_WORDS.unknown
      const needsUpdate = pack.server.state === 'behind' || pack.server.state === 'edited'
      rows.push(h('tr', {},
        h('td', { textContent: 'Server folder' }),
        h('td', { textContent: many ? `${pack.kind}: ${pack.name}` : pack.kind }),
        h('td', { textContent: pack.server.version }),
        h('td', { textContent: 'Shared by worlds that list it' }),
        h('td', {}, h('span', { class: `chip ${tone}`, textContent: word })),
        h('td', {}, h('div', { class: 'row' },
          pack.file ? h('button', { type: 'button', class: needsUpdate ? 'primary' : '', textContent: needsUpdate ? 'Update' : 'Reinstall', disabled: busyNow(), on: { click: () => applyToTargets(['server']) } }) : null,
          h('button', { type: 'button', class: 'danger-ghost', textContent: 'Remove', disabled: busyNow(), on: { click: () => removeFromServer(mod) } })))))
    }
  }
  const behind = lib.detail.packs.flatMap((p) => p.usage.filter((u) => u.state === 'behind' || u.state === 'edited').map((u) => u.folder))
  const stale = lib.detail.packs.some((p) => p.server && (p.server.state === 'behind' || p.server.state === 'edited'))
  const targets = uniq([...behind, ...(stale ? ['server'] : [])])
  const inLibrary = lib.detail.packs.some((p) => p.file)
  body.append(
    h('div', { class: 'toolbar' },
      h('p', { class: 'toolbar-note', textContent: rows.length ? 'Every place this mod is installed, compared with the copy in the library.' : `${mod.name} isn't in any world or on the server yet.` }),
      targets.length && inLibrary ? h('button', { type: 'button', class: 'primary', textContent: `Update everywhere (${targets.length})`, disabled: busyNow(), on: { click: () => applyToTargets(targets) } }) : null,
      inLibrary ? h('button', { type: 'button', textContent: 'Install to the server', title: 'Copy into the server\'s shared pack folders, without switching it on in a world.', disabled: busyNow(), on: { click: () => applyToTargets(['server']) } }) : null),
    rows.length ? h('div', { class: 'table-wrap lib-table' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['World', 'Pack', 'Version', 'Loads from', 'State', ''].map((t) => h('th', { textContent: t })))),
      h('tbody', {}, rows))) : null)
}

async function applyToTargets (targets) {
  const counts = await ask('library.apply', { id: lib.detail.id, targets })
  if (!counts) return
  finished(counts, null)
  await afterChange()
  await reloadLibDetail()
}

async function removeFromWorldTab (mod, use, pack) {
  const shared = use.where === 'server'
  const uuids = lib.detail.packs.filter((p) => p.usage.some((u) => u.folder === use.folder)).map((p) => p.uuid)
  const sure = await api.confirm({ danger: !mod.inLibrary, message: `Remove ${mod.name} from "${use.name}"?`, detail: `${plural(uuids.length, 'pack')} of this mod ${uuids.length === 1 ? 'is' : 'are'} taken out of the world. ${shared ? 'The copy in the server folder stays, because other worlds may use it.' : 'The world\'s own copy is deleted.'} ${mod.inLibrary ? 'Your library still has it.' : 'This mod isn\'t in your library, so if this is the only copy it is gone for good. Add it to the library first to keep it.'}`, yes: 'Remove' })
  if (!sure.yes) return
  const result = await ask('world.removePacks', { folder: use.folder, uuids })
  if (!result) return
  say(`Removed ${mod.name} from ${use.name}.`)
  if (result.problems.length) report('Some of it didn\'t work', '', result.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })))
  await afterChange()
  await refreshMods()
  await reloadLibDetail()
}

async function removeFromServer (mod) {
  const uuids = lib.detail.packs.filter((p) => p.server).map((p) => p.uuid)
  const sure = await api.confirm({ danger: true, message: `Remove ${mod.name} from the server folder?`, detail: `The copy in the server's shared pack folders is deleted. ${mod.inLibrary ? 'Your library still has it.' : 'This mod isn\'t in your library, so if this is the only copy it is gone for good. Add it to the library first to keep it.'}`, yes: 'Remove' })
  if (!sure.yes) return
  const usage = await ask('mods.usage', { uuids })
  let alsoWorlds = false
  if (usage?.worlds.length) {
    const also = await api.confirm({ message: 'These worlds still list it. Remove it from them too?', detail: `${usage.worlds.slice(0, 8).map((w) => `- ${w.name}`).join('\n')}\n\nChoose Cancel to leave their lists as they are. A world relying on the server's copy will then be missing the mod.`, yes: 'Remove from worlds too' })
    alsoWorlds = also.yes
  }
  const result = await ask('mods.uninstall', { uuids, alsoWorlds })
  if (!result) return
  say(`Removed ${mod.name} from the server folder.`)
  if (result.problems.length) report('Some of it didn\'t work', '', result.problems.map((p) => ({ status: 'fail', label: p.name, word: 'Failed', detail: p.text })))
  await afterChange()
  await refreshMods()
  await reloadLibDetail()
}

// Add to a world goes through the same checks as adding from the world's side
function chooseWorldForMod () {
  const mod = libMod()
  const list = $('#world-pick-list')
  const has = new Set(mod.worlds.map((w) => w.folder))
  const dialog = $('#dlg-world-pick')
  setText($('#world-pick-title'), `Add ${mod.name} to which world?`)
  list.replaceChildren(...lib.view.worlds.map((world) => h('button', { type: 'button', class: 'lib-world-choice', disabled: has.has(world.folder), on: { click: async () => {
    dialog.close()
    await selectWorld(world.folder)
    const supported = ui.mods.find((m) => m.id === mod.id)?.supported || []
    await addToWorld(supported)
    await reloadLibDetail()
  } } }, world.name, has.has(world.folder) ? h('small', { textContent: ' already has it' }) : null)))
  openDialog(dialog)
}

/* Settings */

function renderStorage () {
  const s = lib.view?.storage
  const node = $('#lib-storage')
  if (!node || !s) return
  setText(node, `${s.path}: ${plural(s.folders, 'pack folder')}, ${s.text}.`)
}
