'use strict'

// Settings: AutoSave and GitHub Cloud, and the window that offers newer saves from the cloud.
// The main process holds the GitHub sign-in. This file only shows what it reports and sends back what was clicked.

const cloudUi = { view: null, shownCheck: 0, tokenOpen: false }

const CLOUD_STATE = {
  same: ['Up to date', 'ok'],
  'cloud-newer': ['Newer in the cloud', 'newer'],
  'cloud-only': ['Only in the cloud', 'newer'],
  'local-newer': ['Waiting to upload', ''],
  'local-only': ['Not uploaded yet', ''],
  both: ['Changed on both', 'both'],
  none: ['No saves yet', ''],
  off: ['', '']
}

async function cloudCall (action, params = {}) {
  const answer = await api.cloud(action, params)
  const box = action === 'linkLibrary' || action === 'createLibrary' || action === 'unlinkLibrary' ||
    action === 'libraryUpdateMode' || action === 'syncLibrary' || action === 'restoreLibrary'
    ? $('#library-cloud-error')
    : ['linkSettings', 'createSettings', 'unlinkSettings', 'settingsIncludeXbox', 'forgetSettingsVault', 'unlockSettingsVault', 'syncSettings', 'restoreSettings'].includes(action)
      ? $('#settings-cloud-error')
      : $('#cloud-error')
  box.hidden = answer.ok
  if (!answer.ok) setText(box, answer.error)
  return answer.ok ? (answer.result ?? true) : null
}

const when = (ms) => (ms ? `${new Date(ms).toLocaleString()}` : '-')

window.hubCloud = (view) => {
  if (!view) return
  cloudUi.view = view
  renderCloud()
  // A check found newer saves: say so once
  if (view.checkId !== cloudUi.shownCheck && view.newer > 0 && !view.busy) {
    cloudUi.shownCheck = view.checkId
    if (!document.querySelector('dialog[open]')) openCloudDialog()
    notify(`${plural(view.newer, 'world')} ${view.newer === 1 ? 'has' : 'have'} a newer save in GitHub Cloud`, 'Download it before you play, or the next session carries on from this computer\'s copy.', 'warn', 'worlds', 'cloud-newer')
  }
  if (!view.newer) clearNote('cloud-newer')
}

function renderCloud () {
  const v = cloudUi.view
  $('#autosave-on').checked = v.autosave || v.linked
  $('#autosave-on').disabled = v.linked
  setText($('#autosave-where'), v.linked ? `Always on while GitHub Cloud is linked. Saved in ${v.root}.` : `Saved in ${v.root}.`)
  const chip = $('#cloud-chip')
  setText(chip, v.linked ? (v.busy || 'On') : v.signedIn ? 'Choose a repo' : 'Off')
  chip.className = `chip${v.linked ? ' ok' : ''}`
  const button = $('#worlds-cloud')
  button.hidden = !v.linked
  setText(button, v.newer ? `GitHub Cloud (${v.newer} newer)` : 'GitHub Cloud')
  button.classList.toggle('primary', v.newer > 0)

  const body = $('#cloud-body')
  const focused = document.activeElement && body.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)
  if (!focused) {
    const parts = []
    if (!v.signedIn) parts.push(...signInParts(v))
    else if (!v.repo) parts.push(...repoParts(v))
    else parts.push(...linkedParts(v))
    body.replaceChildren(...parts)
  }
  renderLibraryCloud(v)
  renderSettingsCloud(v)
  if (!$('#dlg-cloud').open) return
  renderCloudDialog()
}

function renderLibraryCloud (v) {
  const body = $('#library-cloud-body')
  const chip = $('#library-cloud-chip')
  const box = $('#library-cloud-error')
  const focused = document.activeElement && body.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)
  setText(chip, v.libraryBusy ? 'Working' : v.libraryLinked ? 'Connected' : v.signedIn ? 'Choose a repo' : 'Off')
  chip.className = `chip${v.libraryLinked ? ' ok' : ''}`
  if (v.libraryError) {
    setText(box, v.libraryError)
    box.hidden = false
  }
  if (focused) return

  if (!v.signedIn) {
    body.replaceChildren(h('p', { class: 'note', textContent: 'Sign in to GitHub above to connect a separate repo for the Mod Library.' }))
    return
  }
  if (!v.libraryRepo) {
    const input = h('input', { id: 'library-cloud-repo', autocomplete: 'off', spellcheck: false, placeholder: `${v.login}/bedrock-mod-library` })
    body.replaceChildren(
      h('div', { class: 'field' },
        h('label', { for: 'library-cloud-repo', textContent: 'Separate repo for the Mod Library' }),
        h('div', { class: 'inline' }, input,
          h('button', { type: 'button', class: 'primary', textContent: 'Link', on: { click: () => cloudCall('linkLibrary', { repo: input.value }) } }))),
      h('div', { class: 'row' },
        h('button', { type: 'button', textContent: 'Create a private repo', on: { click: async () => {
          const name = await promptFor('Create a private repo', 'Name for the Mod Library backup', 'bedrock-mod-library', 'Create')
          if (name) await cloudCall('createLibrary', { name })
        } } }),
        h('span', { class: 'note', textContent: 'This must be different from the repo used for world saves.' }))
    )
    return
  }

  const mode = h('select', {
    id: 'library-cloud-update-mode',
    on: { change: (e) => cloudCall('libraryUpdateMode', { value: e.target.value }) }
  },
  h('option', { value: 'add', selected: v.libraryUpdateMode === 'add', textContent: 'Add — keep previous pack versions' }),
  h('option', { value: 'replace', selected: v.libraryUpdateMode === 'replace', textContent: 'Replace — update the current copy' }))
  const parts = [
    h('div', { class: 'cloud-row' },
      h('p', { class: 'grow', textContent: `Backing up to ${v.libraryRepo} as ${v.login}.${v.repoVisibility?.library === false ? ' Public repo: anyone can view the mod files.' : ''}${v.lastLibrarySync ? ` Last synced ${ago(v.lastLibrarySync)}.` : ''}` }),
      h('button', { type: 'button', textContent: 'Open on GitHub', on: { click: () => api.openGitHub(v.libraryRepoUrl) } }),
      h('button', { type: 'button', textContent: 'Change repo', on: { click: () => cloudCall('unlinkLibrary') } }),
      h('button', { type: 'button', textContent: 'Restore from GitHub', disabled: v.libraryBusy, on: { click: restoreLibrary } }),
      h('button', { type: 'button', class: 'primary', textContent: v.libraryBusy ? 'Working...' : 'Sync now', disabled: v.libraryBusy, on: { click: syncLibrary } })),
    h('div', { class: 'field' },
      h('label', { for: 'library-cloud-update-mode', textContent: 'When a mod is updated' }),
      mode,
      h('p', { class: 'field-note', textContent: v.libraryUpdateMode === 'add'
        ? 'Add saves the replaced pack in a versions folder in GitHub before updating the current copy.'
        : 'Replace updates the current copy in GitHub without adding a new version snapshot.' }))
  ]
  body.replaceChildren(...parts)
}

function renderSettingsCloud (v) {
  const body = $('#settings-cloud-body')
  const chip = $('#settings-cloud-chip')
  const box = $('#settings-cloud-error')
  const focused = document.activeElement && body.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)
  setText(chip, v.settingsBusy ? 'Working' : v.settingsLinked ? (v.settingsVaultUnlocked ? 'Ready' : 'Locked') : v.signedIn ? 'Choose a private repo' : 'Off')
  chip.className = `chip${v.settingsLinked && v.settingsVaultUnlocked ? ' ok' : ''}`
  if (v.settingsError) {
    setText(box, v.settingsError)
    box.hidden = false
  }
  if (focused) return

  if (!v.signedIn) {
    body.replaceChildren(h('p', { class: 'note', textContent: 'Sign in to GitHub above, then connect a separate private repo for settings.' }))
    return
  }
  if (!v.settingsRepo) {
    const input = h('input', { id: 'settings-cloud-repo', autocomplete: 'off', spellcheck: false, placeholder: `${v.login}/bedrock-hub-settings` })
    body.replaceChildren(
      h('div', { class: 'field' },
        h('label', { for: 'settings-cloud-repo', textContent: 'Private settings repo (required)' }),
        h('div', { class: 'inline' }, input,
          h('button', { type: 'button', class: 'primary', textContent: 'Link private repo', on: { click: () => cloudCall('linkSettings', { repo: input.value }) } }))),
      h('div', { class: 'row' },
        h('button', { type: 'button', textContent: 'Create a private repo', on: { click: async () => {
          const name = await promptFor('Create a private repo', 'Name for the encrypted settings backup', 'bedrock-hub-settings', 'Create')
          if (name) await cloudCall('createSettings', { name })
        } } }),
        h('span', { class: 'note', textContent: 'This must differ from the world and Mod Library repos.' }))
    )
    return
  }

  const parts = [
    h('div', { class: 'cloud-row' },
      h('p', { class: 'grow', textContent: `Encrypted settings in ${v.settingsRepo}.${v.lastSettingsSync ? ` Last synced ${ago(v.lastSettingsSync)}.` : ''}` }),
      h('button', { type: 'button', textContent: 'Open on GitHub', on: { click: () => api.openGitHub(v.settingsRepoUrl) } }),
      h('button', { type: 'button', textContent: 'Change repo', disabled: v.settingsBusy, on: { click: () => cloudCall('unlinkSettings') } })),
  ]
  if (!v.settingsVaultUnlocked) {
    const phrase = h('input', { id: 'settings-vault-passphrase', type: 'password', autocomplete: 'new-password', placeholder: 'At least 12 characters' })
    const confirmation = h('input', { id: 'settings-vault-confirm', type: 'password', autocomplete: 'new-password', placeholder: 'Confirm passphrase for a new vault' })
    parts.push(
      h('div', { class: 'field' },
        h('label', { for: 'settings-vault-passphrase', textContent: 'Unlock or create the settings vault' }),
        phrase,
        confirmation,
        h('p', { class: 'field-note', textContent: 'On this device, Windows protects the passphrase so you only enter it once. On a new device, sign in to GitHub and enter it once to unlock the backup.' }),
        h('button', { type: 'button', class: 'primary', textContent: 'Unlock / set passphrase', disabled: v.settingsBusy, on: { click: async () => {
          const answer = await cloudCall('unlockSettingsVault', { passphrase: phrase.value, confirmation: confirmation.value })
          if (answer) {
            phrase.value = ''
            confirmation.value = ''
            phrase.blur()
            confirmation.blur()
            renderSettingsCloud(cloudUi.view)
          }
        } } }))
    )
    body.replaceChildren(...parts)
    return
  }

  const includeXbox = h('input', {
    type: 'checkbox',
    checked: v.settingsIncludeXbox,
    on: { change: (e) => cloudCall('settingsIncludeXbox', { value: e.target.checked }) }
  })
  parts.push(
    h('label', { class: 'toggle' }, includeXbox,
      h('span', {}, h('b', { textContent: 'Include Xbox bridge session data' }),
        h('small', { textContent: 'Transfers Microsoft refresh-token caches. Stop the server and bridge before syncing or restoring.' }))),
    h('p', { class: 'field-note', textContent: 'Includes app preferences, server settings, host address, allowlist, and GitHub sign-in data. Sync and restore are manual; restores keep a local safety copy. A public settings repo is never accepted.' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', textContent: 'Restore from GitHub', disabled: v.settingsBusy, on: { click: restoreSettings } }),
      h('button', { type: 'button', class: 'primary', textContent: v.settingsBusy ? 'Working...' : 'Sync now', disabled: v.settingsBusy, on: { click: syncSettings } }),
      h('button', { type: 'button', textContent: 'Forget passphrase here', disabled: v.settingsBusy, on: { click: forgetSettingsVault } }))
  )
  body.replaceChildren(...parts)
}

async function syncLibrary () {
  say('Backing up the Mod Library to GitHub...')
  const result = await cloudCall('syncLibrary')
  if (result) say(`Mod Library backed up to GitHub.${result.skipped ? ` ${result.skipped} files over 95 MB were skipped.` : ''}`)
}

async function restoreLibrary () {
  say('Restoring the Mod Library from GitHub...')
  const result = await cloudCall('restoreLibrary')
  if (!result || result.cancelled) return
  say(`Mod Library restored from GitHub.${result.backup ? ` Previous library kept at ${result.backup}.` : ''}`)
  await rescan()
}

async function syncSettings () {
  say('Encrypting and backing up settings to GitHub...')
  const result = await cloudCall('syncSettings', { includeXbox: cloudUi.view?.settingsIncludeXbox === true })
  if (result) say('Encrypted settings backed up to GitHub.')
}

async function restoreSettings () {
  say('Restoring settings from GitHub...')
  const result = await cloudCall('restoreSettings')
  if (!result || result.cancelled) return
  say(`Settings restored from GitHub. Safety copy: ${result.backupDir}.${result.includeXbox ? ' Xbox bridge session data was restored.' : ''}`)
  notify('Settings restored', `A local safety copy was saved at ${result.backupDir}.`, 'ok', 'settings')
  await rescan()
}

async function forgetSettingsVault () {
  const sure = await api.confirm({ message: 'Forget the settings vault passphrase on this device?', detail: 'The encrypted backup stays in GitHub, but this device will need the passphrase again before syncing or restoring.', yes: 'Forget passphrase' })
  if (sure.yes) await cloudCall('forgetSettingsVault')
}

function signInParts (v) {
  const parts = []
  if (v.signIn) {
    parts.push(h('div', { class: 'cloud-code' },
      h('p', { textContent: 'Open GitHub and enter this code. This page carries on by itself once you have.' }),
      h('output', { class: 'code', textContent: v.signIn.code }),
      h('div', { class: 'row' },
        h('button', { type: 'button', textContent: 'Copy code', on: { click: () => api.copyText(v.signIn.code) } }),
        h('button', { type: 'button', class: 'primary', textContent: 'Open GitHub', on: { click: () => api.openGitHub(v.signIn.url) } }),
        h('button', { type: 'button', textContent: 'Cancel', on: { click: () => cloudCall('cancelSignIn') } }))))
    return parts
  }
  parts.push(h('div', { class: 'row' },
    v.deviceFlow ? h('button', { type: 'button', class: 'primary', textContent: 'Sign in with GitHub', on: { click: () => cloudCall('signIn') } }) : null,
    h('button', { type: 'button', class: v.deviceFlow ? '' : 'primary', textContent: 'Use a token', on: { click: () => { cloudUi.tokenOpen = !cloudUi.tokenOpen; renderCloud() } } })))
  if (cloudUi.tokenOpen || !v.deviceFlow) {
    const input = h('input', { id: 'cloud-token', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'github_pat_...' })
    parts.push(h('div', { class: 'field' },
      h('label', { for: 'cloud-token', textContent: 'GitHub token' }),
      h('div', { class: 'inline' }, input, h('button', { type: 'button', class: 'primary', textContent: 'Sign in', on: { click: async () => { if (await cloudCall('token', { token: input.value })) input.value = '' } } }))),
      h('p', { class: 'field-note', textContent: 'Make a fine-grained token for the repos you will link (worlds and Mod Library), with Contents set to Read and write. It is stored encrypted on this computer.' }),
      h('div', {}, h('button', { type: 'button', class: 'link', textContent: 'Make a token on GitHub', on: { click: () => api.openGitHub('https://github.com/settings/personal-access-tokens/new') } })))
  }
  return parts
}

function repoParts (v) {
  const input = h('input', { id: 'cloud-repo', autocomplete: 'off', spellcheck: false, placeholder: `${v.login}/bedrock-worlds` })
  return [
    h('div', { class: 'cloud-row' }, h('p', { class: 'grow', textContent: `Signed in as ${v.login}.` }), h('button', { type: 'button', textContent: 'Sign out', on: { click: signOutCloud } })),
    h('div', { class: 'field' },
      h('label', { for: 'cloud-repo', textContent: 'Repo for your worlds' }),
      h('div', { class: 'inline' }, input, h('button', { type: 'button', class: 'primary', textContent: 'Link', on: { click: () => cloudCall('link', { repo: input.value }) } }))),
    h('div', { class: 'row' },
      h('button', { type: 'button', textContent: 'Create a private repo', on: { click: async () => {
        const name = await promptFor('Create a private repo', 'Name for the repo', 'bedrock-worlds', 'Create')
        if (name) await cloudCall('create', { name })
      } } }),
      h('span', { class: 'note', textContent: 'Use the same repo on every computer you play on.' }))
  ]
}

function linkedParts (v) {
  const toggle = (key, label, small) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: v[key], on: { change: (e) => cloudCall('set', { key, value: e.target.checked }) } }),
    h('span', {}, h('b', { textContent: label }), h('small', { textContent: small })))
  return [
    h('div', { class: 'cloud-row' },
      h('p', { class: 'grow', textContent: `Saving to ${v.repo} as ${v.login}.${v.lastCheck ? ` Checked ${ago(v.lastCheck)}.` : ''}` }),
      h('button', { type: 'button', textContent: 'Check now', disabled: Boolean(v.busy), on: { click: () => cloudCall('check') } }),
      h('button', { type: 'button', textContent: 'Open on GitHub', on: { click: () => api.openGitHub(v.repoUrl) } }),
      h('button', { type: 'button', textContent: 'Change repo', on: { click: () => cloudCall('unlink') } }),
      h('button', { type: 'button', textContent: 'Sign out', on: { click: signOutCloud } })),
    h('div', { class: 'toggles' },
      toggle('autoUpload', 'Upload each world when the server stops', 'Off: use Upload below when you want to.'),
      toggle('keepHistory', 'Keep older saves in the repo\'s history', 'Each upload only sends what changed. Off: every upload sends the whole world, but the repo stays small.')),
    v.repoVisibility?.worlds === false ? h('p', { class: 'field-note', textContent: 'Warning: this world repo is public. Anyone can view its world backups. Make it private on GitHub.' }) : null,
    cloudWorldsTable(v),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'danger-ghost', textContent: 'Start the repo\'s history over', title: 'Makes the repo small again', on: { click: startOverCloud } }),
      h('span', { class: 'note', textContent: 'The repo grows with every session. This uploads each world once more with no history.' }))
  ]
}

function cloudWorldsTable (v) {
  if (!v.worlds.length) return h('p', { class: 'note', textContent: 'No saves yet. Start and stop a world on the server, and it is uploaded.' })
  const hosted = latest?.settings.world.name
  const running = latest && latest.services.server.state !== 'off' && latest.services.server.state !== 'crashed'
  return h('div', { class: 'table-wrap cloud-worlds' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['World', 'This computer', 'GitHub Cloud', 'State', ''].map((t) => h('th', { textContent: t })))),
    h('tbody', {}, v.worlds.map((w) => {
      const [word, tone] = CLOUD_STATE[w.state] || ['', '']
      const locked = running && hosted === w.folder
      return h('tr', {},
        h('td', { textContent: w.name }),
        h('td', { textContent: w.local ? `${when(w.local.at)}` : '-' }),
        h('td', { textContent: w.cloud ? `${when(w.cloud.at)} on ${w.cloud.device}` : '-' }),
        h('td', {}, h('span', { class: `cloud-state ${tone}`, textContent: w.uploading ? 'Uploading...' : word })),
        h('td', {}, h('div', { class: 'row' },
          w.cloud ? h('button', { type: 'button', class: tone === 'newer' || tone === 'both' ? 'primary' : '', textContent: 'Download', disabled: locked || Boolean(v.busy), title: locked ? 'Stop the server first.' : '', on: { click: () => downloadWorld(w) } }) : null,
          w.local ? h('button', { type: 'button', textContent: 'Upload', disabled: w.uploading, on: { click: () => uploadWorld(w) } }) : null)))
    }))))
}

async function downloadWorld (w) {
  const local = w.local && w.state !== 'cloud-only'
  if (local) {
    const sure = await api.confirm({ message: `Load the cloud save of "${w.name}"?`, detail: `It replaces the world on this computer, saved ${when(w.local.at)}, with the one saved ${when(w.cloud?.at)} on ${w.cloud?.device}. This computer's copy is kept as a backup.`, yes: 'Load the cloud save' })
    if (!sure.yes) return
  }
  say(`Downloading ${w.name}...`)
  const result = await cloudCall('download', { folder: w.folder })
  if (!result) return
  say(`Downloaded ${result.name}.`)
  notify(`Downloaded ${result.name} from GitHub Cloud`, result.missing.length ? `These packs aren't in your Mod Library: ${result.missing.join(', ')}` : (result.restored.length ? `${plural(result.restored.length, 'pack')} put back from your library.` : ''), result.missing.length ? 'warn' : 'ok', 'worlds')
  if (result.missing.length) report('Some packs are missing', 'Add them to the Mod Library, then use Reinstall on the world.', result.missing.map((name) => ({ status: 'warn', label: name, word: 'Missing', detail: '' })))
  await refreshWorlds()
  await rescan()
}

async function uploadWorld (w) {
  const result = await cloudCall('upload', { folder: w.folder })
  if (result) say(`Uploaded ${w.name}.`)
}

async function signOutCloud () {
  const sure = await api.confirm({ message: 'Sign out of GitHub?', detail: 'Uploads stop. Your saves on this computer and in the repo stay where they are.', yes: 'Sign out' })
  if (sure.yes) await cloudCall('signOut')
}

async function startOverCloud () {
  const sure = await api.confirm({ danger: true, message: 'Start the repo\'s history over?', detail: 'Older saves in the repo\'s history are dropped, and every world on this computer is uploaded again in full. Other computers keep working. GitHub frees the space later.', yes: 'Start over' })
  if (!sure.yes) return
  say('Uploading every world again...')
  if (await cloudCall('startOver')) say('The repo\'s history was started over.')
}

/* The window for newer saves */

function openCloudDialog () {
  renderCloudDialog()
  openDialog($('#dlg-cloud'))
}

function renderCloudDialog () {
  const v = cloudUi.view
  const list = v.worlds.filter((w) => ['cloud-newer', 'cloud-only', 'both'].includes(w.state))
  $('#cloud-dlg-list').replaceChildren(...(list.length
    ? list.map((w) => h('div', { class: `issue cloud-row`, data: { sev: w.state === 'both' ? 'error' : 'warn' } },
        h('div', { class: 'grow' },
          h('h4', { textContent: w.name }),
          h('p', { textContent: w.state === 'cloud-only'
            ? `Saved ${when(w.cloud?.at)} on ${w.cloud?.device}. Not on this computer yet.`
            : `Cloud: ${when(w.cloud?.at)} on ${w.cloud?.device}. This computer: ${when(w.local?.at)}.${w.state === 'both' ? ' Both changed since they last matched.' : ''}` })),
        h('button', { type: 'button', class: 'primary', textContent: 'Download', disabled: Boolean(v.busy), on: { click: () => downloadWorld(w) } })))
    : [h('p', { class: 'empty', textContent: 'Everything is up to date.' })]))
}

$('#worlds-cloud').addEventListener('click', openCloudDialog)
$('#autosave-on').addEventListener('change', (e) => cloudCall('set', { key: 'autosave', value: e.target.checked }))
api.cloud('view').then((answer) => { if (answer.ok) window.hubCloud(answer.result) })
