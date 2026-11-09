// macOS menu-bar helper for dsh-notify-spirit, run with `osascript -l JavaScript`.
//
// argv: <view.json path> <host pid> <whale.png path>
//
// The host atomically rewrites view.json; this script polls its mtime and
// re-renders. Menu clicks are written to stdout as one JSON line each:
// {"action":"<id>"}.
//
// The icon is the DSH whale, tinted by state. `assets/whale.png` is a
// white-on-transparent silhouette; it is loaded as a template image and tinted
// per state, so one asset serves every pose. The status item's image is then
// marked non-template: a template status image is force-tinted monochrome by
// the menu bar, which would throw away exactly the signal this plugin carries.
//
//   idle     neutral grey that still reads on both light and dark bars
//   ongoing  the green DSH uses for a finished session (--state-success)
//   warning  the amber DSH uses for a session that needs you (--state-warn)
//
// `app.run` keeps the process alive; the host pid is polled so a crashed host
// never leaves an orphan icon.
ObjC.import('Cocoa')
ObjC.import('stdlib')

/**
 * Icon height in points. Measured against the neighbouring menu-bar glyphs
 * (WeChat is 30x28 px, the GitHub mark 34x28 px on a 2x display), so 14pt —
 * 28 px — is the size the bar expects. The width follows the asset's aspect
 * ratio rather than being forced into a square, which is what made the whale
 * look flat before.
 */
var ICON_H = 14

/**
 * The only coloured state. Idle and running stay a plain template glyph — the
 * menu bar then tints them itself, so they are pure black on a light bar and
 * pure white on a dark one, exactly like WeChat and the system icons beside
 * them. Painting them a fixed grey instead was what made the icon read wrong.
 */
var WARNING_COLOR = [0.961, 0.620, 0.043] // #f59e0b — --dsw-alias-state-warn-primary

function run(argv) {
  var viewPath = argv[0]
  var hostPid = Number(argv[1] || 0)
  var whalePath = argv[2] || ''

  var app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)

  var item = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1)
  var fm = $.NSFileManager.defaultManager
  var stdout = $.NSFileHandle.fileHandleWithStandardOutput
  var lastStamp = ''
  var target
  var cache = {}

  function send(action) {
    var line = $(JSON.stringify({ action: action }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)
    stdout.writeData(line)
  }

  function warn(text) {
    $.NSFileHandle.fileHandleWithStandardError.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  }

  /**
   * One whale image for `state`, cached per state.
   *
   * Idle and running hand the menu bar the untouched asset marked as a
   * template: AppKit then draws it in the bar's own foreground colour, which
   * is what makes WeChat and the system glyphs next to it read as solid
   * black (or white in dark mode). Compositing the asset onto a second
   * NSImage first — as an earlier version did — multiplies its alpha, so the
   * template tints to a washed-out grey instead of full ink.
   *
   * Warning is the one coloured state: it is flattened onto an opaque-but-
   * masked copy and marked non-template, because the colour is the message.
   */
  function whaleFor(state) {
    if (cache[state]) return cache[state]

    var source = $.NSImage.alloc.initWithContentsOfFile($(whalePath))
    if (!source || source.isNil()) {
      warn('whale asset missing: ' + whalePath)
      return null
    }

    // Keep the asset's own aspect ratio; only the height is fixed.
    var size = source.size
    var ratio = size.height > 0 ? size.width / size.height : 1
    var h = ICON_H
    var w = Math.round(h * ratio * 10) / 10

    if (state !== 'warning') {
      // Use the asset itself: no extra compositing step, so the template
      // tint stays at full opacity.
      source.setSize($.NSMakeSize(w, h))
      source.setTemplate(true)
      cache[state] = source
      return source
    }

    // Warning: paint the mask amber on an otherwise transparent canvas.
    source.setSize($.NSMakeSize(w, h))
    source.setTemplate(true)

    var out = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h))
    out.lockFocus
    var frame = $.NSMakeRect(0, 0, w, h)
    source.drawInRect(frame)
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(
      WARNING_COLOR[0], WARNING_COLOR[1], WARNING_COLOR[2], 1).set
    $.NSRectFillUsingOperation(frame, $.NSCompositingOperationSourceAtop)
    out.unlockFocus
    out.setTemplate(false)
    cache[state] = out
    return out
  }

  function readView() {
    var attrs = fm.attributesOfItemAtPathError(viewPath, null)
    if (!attrs || attrs.isNil()) return null
    var stamp = ObjC.unwrap(attrs.fileModificationDate.description) + ':' + ObjC.unwrap(attrs.fileSize)
    if (stamp === lastStamp) return null
    lastStamp = stamp
    var text = $.NSString.stringWithContentsOfFileEncodingError(viewPath, $.NSUTF8StringEncoding, null)
    if (!text || text.isNil()) return null
    try {
      return JSON.parse(ObjC.unwrap(text))
    } catch (e) {
      return null
    }
  }

  function buildMenu(rows) {
    var menu = $.NSMenu.alloc.init
    menu.autoenablesItems = false
    ;(rows || []).forEach(function (row) {
      if (row.separator) {
        menu.addItem($.NSMenuItem.separatorItem)
        return
      }
      var mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(row.label), null, '')
      mi.enabled = row.enabled !== false
      if (row.action) {
        mi.action = 'menuClicked:'
        mi.target = target
        mi.representedObject = $(row.action)
      }
      if (row.children && row.children.length) {
        mi.action = $()
        mi.enabled = true
        mi.submenu = buildMenu(row.children)
      }
      menu.addItem(mi)
    })
    return menu
  }

  function apply(view) {
    if (view.quit) {
      app.terminate(null)
      return
    }
    // The image is cached per state by whaleFor(); only a state change swaps it.
    var img = whaleFor(view.state)
    if (img) item.button.image = img
    item.button.imagePosition = $.NSImageLeft
    item.button.title = $(view.title ? ' ' + view.title : '')
    item.button.toolTip = $(view.tooltip || '')
    item.menu = buildMenu(view.menu)
  }

  target = $.NSObject.alloc.init
  ObjC.registerSubclass({
    name: 'DshSpiritTarget',
    methods: {
      'menuClicked:': {
        types: ['void', ['id']],
        implementation: function (sender) {
          var id = ObjC.unwrap(sender.representedObject)
          if (!id) return
          if (id === 'hide-tray') {
            send(id)
            app.terminate(null)
            return
          }
          send(id)
        },
      },
      'tick:': {
        types: ['void', ['id']],
        implementation: function () {
          // Nothing but "read the view and draw it" happens here. An earlier
          // version also probed the host pid on every tick; the probe threw
          // (JXA has no usable kill/NSTask/NSRunningApplication binding), the
          // exception aborted the tick before the view was read, and the icon
          // froze on its first frame forever. The host ends this process
          // through `quit` in view.json instead, and `pdeathsig`-style
          // orphan protection is unnecessary because the host always writes
          // that flag on unload.
          try {
            var view = readView()
            if (view) apply(view)
          } catch (e) {
            warn('spirit render failed: ' + e)
          }
        },
      },
    },
  })

  target = $.DshSpiritTarget.alloc.init

  var first = readView()
  if (first) apply(first)
  else item.button.title = $(' …')

  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, target, 'tick:', null, true)
  app.run
}
