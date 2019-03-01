import { BrowserView, BrowserWindow, Menu } from 'electron'
import * as beakerCore from '@beaker/core'
import path from 'path'
import Events from 'events'
import _throttle from 'lodash.throttle'
import parseDatURL from 'parse-dat-url'
import emitStream from 'emit-stream'
import _get from 'lodash.get'
import _pick from 'lodash.pick'
import * as rpc from 'pauls-electron-rpc'
import normalizeURL from 'normalize-url'
import viewsRPCManifest from '../rpc-manifests/views'
import * as zoom from './views/zoom'
import * as shellMenus from './subwindows/shell-menus'
import * as statusBar from './subwindows/status-bar'
import * as permPrompt from './subwindows/perm-prompt'
import * as modals from './subwindows/modals'
const settingsDb = beakerCore.dbs.settings
const historyDb = beakerCore.dbs.history
const bookmarksDb = beakerCore.dbs.bookmarks

const Y_POSITION = 78 
const DEFAULT_URL = 'beaker://start'
const TRIGGER_LIVE_RELOAD_DEBOUNCE = 500 // throttle live-reload triggers by this amount

// the variables which are automatically sent to the shell-window for rendering
const STATE_VARS = [
  'url',
  'title',
  'peers',
  'zoom',
  'isActive',
  'isPinned',
  'isBookmarked',
  'isLoading',
  'isReceivingAssets',
  'canGoBack',
  'canGoForward',
  'isAudioMuted',
  'isCurrentlyAudible',
  'isInpageFindActive',
  'currentInpageFindString',
  'currentInpageFindResults',
  'availableAlternative',
  'donateLinkHref',
  'localPath',
  'isLiveReloading'
]

// globals
// =

var activeViews = {} // map of {[win.id]: Array<View>}
var closedURLs = {} // map of {[win.id]: Array<string>}
var windowEvents = {} // mapof {[win.id]: Events}
var noRedirectHostnames = new Set() // set of hostnames which have dat-redirection disabled

// classes
// =

var DEBUG = 1

class View {
  constructor (win, opts = {isPinned: false}) {
    this.browserWindow = win
    this.browserView = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, 'webview-preload.build.js'),
        contextIsolation: false,
        webviewTag: false,
        sandbox: true,
        defaultEncoding: 'utf-8',
        nativeWindowOpen: true,
        nodeIntegration: false,
        scrollBounce: true
      }
    })
    this.browserView.setBackgroundColor('#fff')

    // webview state
    this.loadingURL = null // URL being loaded, if any
    this.isLoading = false // is the tab loading?
    this.isReceivingAssets = false // has the webview started receiving assets in the current load-cycle?
    this.zoom = 0 // what's the current zoom level?

    // browser state
    this.isActive = false // is this the active page in the window?
    this.isPinned = Boolean(opts.isPinned) // is this page pinned?
    this.liveReloadEvents = null // live-reload event stream
    this.isInpageFindActive = false // is the inpage-finder UI active?
    this.currentInpageFindString = undefined // what's the current inpage-finder query string?
    this.currentInpageFindResults = undefined // what's the current inpage-finder query results?
    
    // helper state
    this.peers = 0 // how many peers does the site have?
    this.isBookmarked = false // is the active page bookmarked?
    this.datInfo = null // metadata about the site if viewing a dat
    this.donateLinkHref = null // the URL of the donate site, if set by the dat.json
    this.localPath = null // the path of the local sync directory, if set
    this.availableAlternative = '' // tracks if there's alternative protocol available for the site

    // wire up events
    this.webContents.on('did-start-loading', this.onDidStartLoading.bind(this))
    this.webContents.on('did-start-navigation', this.onDidStartNavigation.bind(this))
    this.webContents.on('did-navigate', this.onDidNavigate.bind(this))
    this.webContents.on('did-navigate-in-page', this.onDidNavigateInPage.bind(this))
    this.webContents.on('did-stop-loading', this.onDidStopLoading.bind(this))
    this.webContents.on('update-target-url', this.onUpdateTargetUrl.bind(this))
    this.webContents.on('new-window', this.onNewWindow.bind(this))
    this.webContents.on('media-started-playing', this.onMediaChange.bind(this))
    this.webContents.on('media-paused', this.onMediaChange.bind(this))
    this.webContents.on('found-in-page', this.onFoundInPage.bind(this))
  }

  get webContents () {
    return this.browserView.webContents
  }

  get url () {
    return this.webContents.getURL()
  }

  get origin () {
    return toOrigin(this.url)
  }

  get title () {
    // TODO
    // this doesnt give us the best and quickest results
    // it'd be better to watch title-change events and to track the title manually
    return this.webContents.getTitle()
  }

  get canGoBack () {
    return this.webContents.canGoBack()
  }

  get canGoForward () {
    return this.webContents.canGoForward()
  }

  get isAudioMuted () {
    return this.webContents.isAudioMuted()
  }

  get isCurrentlyAudible () {
    return this.webContents.isCurrentlyAudible()
  }

  get isLiveReloading () {
    return !!this.liveReloadEvents
  }

  get state () {
    return _pick(this, STATE_VARS)
  }

  // management
  // =

  loadURL (url) {
    // TODO manage url and loadingURL
    this.browserView.webContents.loadURL(url)
  }

  activate () {
    this.isActive = true

    const win = this.browserWindow
    win.setBrowserView(this.browserView)
    permPrompt.show(this.browserView)
    modals.show(this.browserView)
    var {width, height} = win.getBounds()
    this.browserView.setBounds({x: 0, y: Y_POSITION, width, height: height - Y_POSITION})
    this.browserView.setAutoResize({width: true, height: true})
  }

  deactivate (dontNullTheView = false) {
    if (!dontNullTheView && this.isActive) {
      this.browserWindow.setBrowserView(null)
    }

    permPrompt.hide(this.browserView)
    modals.hide(this.browserView)
    this.isActive = false
  }

  destroy () {
    this.deactivate()
    permPrompt.close(this.browserView)
    modals.close(this.browserView)
    this.browserView.destroy()
  }

  async updateHistory () {
    var url = this.url
    var title = this.title
  
    if (!/^beaker:\/\/(start|history)/i.test(url)) {
      historyDb.addVisit(0, {url, title})
      if (this.isPinned) {
        savePins(this.browserWindow)
      }
    }
  }

  toggleMuted () {
    this.webContents.setAudioMuted(!this.isAudioMuted)
    this.emitUpdateState()
  }

  // inpage finder
  // =

  showInpageFind () {
    if (this.isInpageFindActive) {
      // go to next result on repeat "show" commands
      this.moveInpageFind(1)
    } else {
      this.isInpageFindActive = true
      this.currentInpageFindResults = {activeMatchOrdinal: 0, matches: 0}
      this.emitUpdateState()
    }
    this.browserWindow.webContents.focus()
  }

  hideInpageFind () {
    this.webContents.stopFindInPage('clearSelection')
    this.isInpageFindActive = false
    this.currentInpageFindString = undefined
    this.currentInpageFindResults = undefined
    this.emitUpdateState()
  }

  setInpageFindString (str, dir) {
    this.currentInpageFindString = str
    this.webContents.findInPage(this.currentInpageFindString, {findNext: false, forward: dir !== -1})
  }

  moveInpageFind (dir) {
    this.webContents.findInPage(this.currentInpageFindString, {findNext: false, forward: dir !== -1})
  }

  // alternative protocols
  // =

  async checkForDatAlternative (url) {
    let u = (new URL(url))
    // try to do a name lookup
    var siteHasDatAlternative = await beakerCore.dat.dns.resolveName(u.hostname).then(
      res => Boolean(res),
      err => false
    )
    if (siteHasDatAlternative) {
      var autoRedirectToDat = !!await beakerCore.dbs.settings.get('auto_redirect_to_dat')
      if (autoRedirectToDat && !noRedirectHostnames.has(u.hostname)) {
        // automatically redirect
        let datUrl = url.replace(u.protocol, 'dat:')
        this.loadURL(datUrl)
      } else {
        // track that dat is available
        this.availableAlternative = 'dat:'
      }
    } else {
      this.availableAlternative = ''
    }
    this.emitUpdateState()
  }

  // live reloading
  // =

  toggleLiveReloading () {
    if (this.liveReloadEvents) {
      this.liveReloadEvents.close()
      this.liveReloadEvents = false
    } else if (this.datInfo) {
      let archive = beakerCore.dat.library.getArchive(this.datInfo.key)
      if (!archive) return

      let {version} = parseDatURL(this.url)
      let {checkoutFS} = beakerCore.dat.library.getArchiveCheckout(archive, version)
      this.liveReloadEvents = checkoutFS.pda.watch()

      let event = (this.datInfo.isOwner) ? 'changed' : 'invalidated'
      const reload = _throttle(() => {
        this.browserView.webContents.reload()
      }, TRIGGER_LIVE_RELOAD_DEBOUNCE, {leading: false})
      this.liveReloadEvents.on('data', ([evt]) => {
        if (evt === event) reload()
      })
      // ^ note this throttle is run on the front edge.
      // That means snappier reloads (no delay) but possible double reloads if multiple files change
    }
    this.emitUpdateState()
  }

  stopLiveReloading () {
    if (this.liveReloadEvents) {
      this.liveReloadEvents.close()
      this.liveReloadEvents = false
      this.emitUpdateState()
    }
  }

  // state fetching
  // =

  // helper called by UIs to pull latest state if a change event has occurred
  // eg called by the bookmark systems after the bookmark state has changed
  async refreshState () {
    await Promise.all([
      this.fetchIsBookmarked(true),
      this.fetchDatInfo(true)
    ])
    this.emitUpdateState()
  }

  async fetchIsBookmarked (noEmit = false) {
    var bookmark = await bookmarksDb.getBookmark(0, normalizeURL(this.url, {
      stripFragment: false,
      stripWWW: false,
      removeQueryParameters: false,
      removeTrailingSlash: true
    }))
    this.isBookmarked = !!bookmark
    if (!noEmit) {
      this.emitUpdateState()
    }
  }

  async fetchDatInfo (noEmit = false) {
    if (!this.url.startsWith('dat://')) {
      return
    }
    var key = await beakerCore.dat.dns.resolveName(this.url)
    this.datInfo = await beakerCore.dat.library.getArchiveInfo(key)
    this.peers = this.datInfo.peers
    this.donateLinkHref = _get(this, 'datInfo.links.payment.0.href')
    this.localPath = _get(this, 'datInfo.userSettings.localSyncPath')
    if (!noEmit) {
      this.emitUpdateState()
    }
  }

  // events
  // =

  emitUpdateState () {
    emitUpdateState(this.browserWindow, this)
  }

  onDidStartLoading (e) {
    // update state
    this.isLoading = true
    this.isReceivingAssets = false

    // emit
    this.emitUpdateState()
  }

  onDidStartNavigation (e, url) {
    // turn off live reloading if we're leaving the domain
    if (toOrigin(url) !== toOrigin(this.url)) {
      this.stopLiveReloading()
    }
  }

  onDidNavigate (e, url) {
    // read zoom
    zoom.setZoomFromSitedata(this)

    // update state
    this.isReceivingAssets = true
    this.fetchIsBookmarked()
    this.fetchDatInfo()

    // emit
    this.emitUpdateState()
  }

  onDidNavigateInPage (e) {
    this.updateHistory()
  }

  onDidStopLoading (e) {
    this.updateHistory()

    // update state
    this.isLoading = false
    this.isReceivingAssets = false

    // check for dat alternatives
    if (this.url.startsWith('https://')) {
      this.checkForDatAlternative(this.url)
    } else {
      this.availableAlternative = ''
    }

    // emit
    this.emitUpdateState()
  }

  onUpdateTargetUrl (e, url) {
    statusBar.set(this.browserWindow, url)
  }

  onNewWindow (e, url, frameName, disposition) {
    e.preventDefault()
    if (!this.isActive) return // only open if coming from the active tab
    var setActive = (disposition === 'foreground-tab' || disposition === 'new-window')
    create(this.browserWindow, url, {setActive})
  }

  onMediaChange (e) {
    // our goal with this event handler is to detect that audio is playing
    // this lets us then render an "audio playing" icon on the tab
    // for whatever reason, the event consistently precedes the "is audible" being set by at most 1s
    // so, we delay for 1s, then emit a state update
    setTimeout(() => this.emitUpdateState(), 1e3)
  }

  onFoundInPage (e, res) {
    this.currentInpageFindResults = {
      activeMatchOrdinal: res.activeMatchOrdinal,
      matches: res.matches
    }
    this.emitUpdateState()
  }
}

// exported api
// =

export function setup () {
  // track peer-counts
  beakerCore.dat.library.createEventStream().on('data', ([evt, {details}]) => {
    if (evt !== 'network-changed') return
    for (let winId in activeViews) {
      for (let view of activeViews[winId]) {
        if (view.datInfo && view.datInfo.url === details.url) {
          view.peers = details.connections
          view.emitUpdateState()
        }
      }
    }
  })
}

export function getAll (win) {
  return activeViews[win.id] || []
}

export function getByIndex (win, index) {
  if (index === 'active') return getActive(win)
  return getAll(win)[index]
}

export function getAllPinned (win) {
  return getAll(win).filter(p => p.isPinned)
}

export function getActive (win) {
  return getAll(win).find(view => view.isActive)
}

export function findContainingWindow (view) {
  for (let winId in activeViews) {
    for (let v of activeViews[winId]) {
      if (v.browserView === view) {
        return v.browserWindow
      }
    }
  }
}

export function create (win, url, opts = {setActive: false, isPinned: false}) {
  url = url || DEFAULT_URL
  var view = new View(win, {isPinned: opts.isPinned})
  
  activeViews[win.id] = activeViews[win.id] || []
  if (opts.isPinned) {
    activeViews[win.id].splice(indexOfLastPinnedView(win), 0, view)
  } else {
    activeViews[win.id].push(view)
  }

  view.loadURL(url)

  // make active if requested, or if none others are
  if (opts.setActive || !getActive(win)) {
    setActive(win, view)
  }
  emitReplaceState(win)

  return view
}

export function remove (win, view) {
  // find
  var views = getAll(win)
  var i = views.indexOf(view)
  if (i == -1) {
    return console.warn('view-manager remove() called for missing view', view)
  }

  // save, in case the user wants to restore it
  closedURLs[win.id] = closedURLs[win.id] || []
  closedURLs[win.id].push(view.url)

  // set new active if that was
  if (view.isActive && views.length > 1) {
    setActive(win, views[i + 1] || views[i - 1])
  }

  // remove
  view.stopLiveReloading()
  views.splice(i, 1)
  view.destroy()

  // persist pins w/o this one, if that was
  if (view.isPinned) {
    savePins(win)
  }

  // close the window if that was the last view
  if (views.length === 0) {
    return win.close()
  }

  // emit
  emitReplaceState(win)
}

export function removeAllExcept (win, view) {
  var views = getAll(win).slice() // .slice() to duplicate the list
  for (let v of views) {
    if (v !== view) {
      remove(win, v)
    }
  }
}

export function removeAllToRightOf (win, view) {
  while (true) {
    let views = getAll(win)
    let index = views.indexOf(view) + 1
    if (index >= views.length) break
    remove(win, getByIndex(win, index))
  }
}

export function setActive (win, view) {
  if (typeof view === 'number') {
    view = getByIndex(win, view)
  }
  if (!view) return
  var active = getActive(win)
  if (active) {
    active.deactivate(true)
  }
  if (view) {
    view.activate()
  }
  emitReplaceState(win)
}

export function initializeFromSnapshot (win, snapshot) {
  for (let url of snapshot) {
    create(win, url)
  }
}

export function takeSnapshot (win) {
  return getAll(win)
    .filter((p) => !p.isPinned)
    .map((p) => p.getIntendedURL())
}

export function togglePinned (win, view) {
  // move tab to the "end" of the pinned tabs
  var views = getAll(win)
  var oldIndex = views.indexOf(view)
  var newIndex = indexOfLastPinnedView(win)
  if (oldIndex < newIndex) newIndex--
  views.splice(oldIndex, 1)
  views.splice(newIndex, 0, view)

  // update view state
  view.isPinned = !view.isPinned
  emitReplaceState(win)

  // persist
  savePins(win)
}

export function savePins (win) {
  return settingsDb.set('pinned_tabs', JSON.stringify(getAllPinned(win).map(p => p.url)))
}

export async function loadPins (win) {
  var json = await settingsDb.get('pinned_tabs')
  try { JSON.parse(json).forEach(url => create(win, url, {isPinned: true})) }
  catch (e) {
    console.log('Failed to load pins', e)
  }
}

export function reopenLastRemoved (win) {
  var url = (closedURLs[win.id] || []).pop()
  if (url) {
    var view = create(win, url)
    setActive(win, view)
    return view
  }
}

export function reorder (win, oldIndex, newIndex) {
  if (oldIndex === newIndex) {
    return
  }
  var views = getAll(win)
  var view = getByIndex(win, oldIndex)
  views.splice(oldIndex, 1)
  views.splice(newIndex, 0, view)
  emitReplaceState(win)
}

export function changeActiveBy (win, offset) {
  var views = getAll(win)
  var active = getActive(win)
  if (views.length > 1) {
    var i = views.indexOf(active)
    if (i === -1) { return console.warn('Active page is not in the pages list! THIS SHOULD NOT HAPPEN!') }

    i += offset
    if (i < 0) i = views.length - 1
    if (i >= views.length) i = 0

    setActive(win, views[i])
  }
}

export function changeActiveTo (win, index) {
  var views = getAll(win)
  if (index >= 0 && index < views.length) {
    setActive(win, views[index])
  }
}

export function changeActiveToLast (win) {
  var views = getAll(win)
  setActive(win, views[views.length - 1])
}

export function emitReplaceState (win) {
  var state = getWindowTabState(win)
  emit(win, 'replace-state', state)
}

export function emitUpdateState (win, view) {
  var index = typeof view === 'number' ? index : getAll(win).indexOf(view)
  if (index === -1) {
    console.warn('WARNING: attempted to update state of a view not on the window')
    return
  }
  var state = getByIndex(win, index).state
  emit(win, 'update-state', {index, state})
}

// rpc api
// =

rpc.exportAPI('background-process-views', viewsRPCManifest, {
  createEventStream () {
    return emitStream(getEvents(getWindow(this.sender)))
  },

  async refreshState (tab) {
    var win = getWindow(this.sender)
    var view = getByIndex(win, tab)
    if (view) {
      view.refreshState()
    }
  },

  async getState () {
    var win = getWindow(this.sender)
    return getWindowTabState(win)
  },

  async getTabState (tab, opts) {
    var win = getWindow(this.sender)
    var view = getByIndex(win, tab)
    if (view) {
      var state = Object.assign({}, view.state)
      if (opts) {
        if (opts.datInfo) state.datInfo = view.datInfo
        if (opts.networkStats) state.networkStats = view.datInfo ? view.datInfo.networkStats : {}
        if (opts.sitePerms) state.sitePerms = await beakerCore.dbs.sitedata.getPermissions(view.url)
      }
      return state
    }
  },

  async createTab (url, opts = {setActive: false, addToNoRedirects: false}) {
    if (opts.addToNoRedirects) {
      addToNoRedirects(url)
    }

    var win = getWindow(this.sender)
    var view = create(win, url, opts)
    return getAll(win).indexOf(view)
  },

  async loadURL (index, url, opts = {addToNoRedirects: false}) {
    if (opts.addToNoRedirects) {
      addToNoRedirects(url)
    }

    getByIndex(getWindow(this.sender), index).loadURL(url)
  },

  async closeTab (index) {
    var win = getWindow(this.sender)
    remove(win, getByIndex(win, index))
  },

  async setActiveTab (index) {
    var win = getWindow(this.sender)
    setActive(win, getByIndex(win, index))
  },

  async reorderTab (oldIndex, newIndex) {
    var win = getWindow(this.sender)
    reorder(win, oldIndex, newIndex)
  },

  async showTabContextMenu (index) {
    var win = getWindow(this.sender)
    var view = getByIndex(win, index)
    var menu = Menu.buildFromTemplate([
      { label: 'New Tab', click: () => create(win, null, {setActive: true}) },
      { type: 'separator' },
      { label: 'Duplicate', click: () => create(win, view.url) },
      { label: (view.isPinned) ? 'Unpin Tab' : 'Pin Tab', click: () => togglePinned(win, view) },
      { label: (view.isAudioMuted) ? 'Unmute Tab' : 'Mute Tab', click: () => view.toggleMuted() },
      { type: 'separator' },
      { label: 'Close Tab', click: () => remove(win, view) },
      { label: 'Close Other Tabs', click: () => removeAllExcept(win, view) },
      { label: 'Close Tabs to the Right', click: () => removeAllToRightOf(win, view) },
      { type: 'separator' },
      { label: 'Reopen Closed Tab', click: () => reopenLastRemoved(win) }
    ])
    menu.popup({window: win})
  },

  async goBack (index) {
    getByIndex(getWindow(this.sender), index).browserView.webContents.goBack()
  },

  async goForward (index) {
    getByIndex(getWindow(this.sender), index).browserView.webContents.goForward()
  },

  async stop (index) {
    getByIndex(getWindow(this.sender), index).browserView.webContents.stop()
  },

  async reload (index) {
    getByIndex(getWindow(this.sender), index).browserView.webContents.reload()
  },

  async resetZoom (index) {
    zoom.zoomReset(getByIndex(getWindow(this.sender), index))
  },

  async toggleLiveReloading (index) {
    getByIndex(getWindow(this.sender), index).toggleLiveReloading()
  },

  async showInpageFind (index) {
    getByIndex(getWindow(this.sender), index).showInpageFind()
  },

  async hideInpageFind (index) {
    getByIndex(getWindow(this.sender), index).hideInpageFind()
  },

  async setInpageFindString (index, str, dir) {
    getByIndex(getWindow(this.sender), index).setInpageFindString(str, dir)
  },

  async moveInpageFind (index, dir) {
    getByIndex(getWindow(this.sender), index).moveInpageFind(dir)
  },

  async showMenu (id, opts) {
    await shellMenus.show(getWindow(this.sender), id, opts)
  },

  async toggleMenu (id, opts) {
    await shellMenus.toggle(getWindow(this.sender), id, opts)
  }
})

// internal methods
// =

function getWindow (sender) {
  var win = BrowserWindow.fromWebContents(sender)
  while (win.getParentWindow()) {
    // if called from a subwindow (eg a shell-menu) find the parent
    win = win.getParentWindow()
  }
  return win
}

function getEvents (win) {
  if (!(win.id in windowEvents)) {
    windowEvents[win.id] = new Events()
  }
  return windowEvents[win.id]
}

function emit (win, ...args) {
  getEvents(win).emit(...args)
}

function getWindowTabState (win) {
  return getAll(win).map(view => view.state)
}

function indexOfLastPinnedView (win) {
  var views = getAll(win)
  var index = 0
  for (index; index < views.length; index++) {
    if (!views[index].isPinned) break
  }
  return index
}

function toOrigin (str) {
  try {
    var u = new URL(str)
    return u.protocol + '//' + u.hostname
  } catch (e) { return '' }
}

function addToNoRedirects (url) {
  try {
    var u = new URL(url)
    noRedirectHostnames.add(u.hostname)
  } catch (e) {
    console.log('Failed to add URL to noRedirectHostnames', url, e)
  }
}