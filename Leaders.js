// Leader-line layout.
//
// Each button on the shell gets a label chip in one of two gutters, joined
// back to its anchor by a leader. Three things have to hold at once or the
// diagram stops being readable:
//
//   1. a chip sits as close to its button's height as it can,
//   2. chips in a gutter never overlap,
//   3. leaders never cross each other.
//
// (3) comes free from (2) as long as chips keep their anchors' vertical
// order, so the whole problem is one-dimensional: choose chip centres that
// are monotonically increasing, respect a minimum spacing, and sit as near
// the desired centres as possible.
//
// That is isotonic regression under an L2 objective, which pool-adjacent-
// violators solves exactly in linear time. Greedy "push the next one down"
// placement is the usual shortcut and it drifts badly once a cluster forms
// near the top — every label below the cluster gets shoved down even when
// there was slack above it. PAVA instead spreads a crowded cluster around
// its own centre of mass and leaves everything else where it wanted to be.

// ------------------------------------------------------------ 1-D placement

// Desired centres in, non-overlapping centres out. `pitch` is the minimum
// centre-to-centre distance (chip height + gap).
//
// Solved in the shifted space z_i = y_i - i*pitch, where the spacing
// constraint y_{i+1} >= y_i + pitch becomes plain monotonicity z_{i+1} >= z_i.
function isotonic(desired, pitch) {
  var n = desired.length
  if (n === 0) return []

  // Each block holds a run of labels that had to be pooled together.
  // `sum`/`count` carry the mean of the block in shifted space.
  var blocks = []
  for (var i = 0; i < n; i++) {
    var block = { sum: desired[i] - i * pitch, count: 1, start: i }
    // Merge backwards while this block would sit above its predecessor,
    // which is exactly the monotonicity violation PAVA pools away.
    while (blocks.length > 0) {
      var prev = blocks[blocks.length - 1]
      if (prev.sum / prev.count <= block.sum / block.count) break
      block.sum += prev.sum
      block.count += prev.count
      block.start = prev.start
      blocks.pop()
    }
    blocks.push(block)
  }

  var out = new Array(n)
  for (var b = 0; b < blocks.length; b++) {
    var mean = blocks[b].sum / blocks[b].count
    for (var k = 0; k < blocks[b].count; k++) {
      var index = blocks[b].start + k
      out[index] = mean + index * pitch
    }
  }
  return out
}

// Slide the whole column into [top, bottom]; compress evenly only when it
// genuinely cannot fit, so the common case never distorts.
function fitToBounds(centres, pitch, top, bottom, half) {
  var n = centres.length
  if (n === 0) return []
  var needed = (n - 1) * pitch + 2 * half
  var room = bottom - top

  if (needed > room) {
    var step = n > 1 ? (room - 2 * half) / (n - 1) : 0
    var packed = []
    for (var i = 0; i < n; i++) packed.push(top + half + i * step)
    return packed
  }

  var out = centres.slice()
  var shiftUp = (out[n - 1] + half) - bottom
  if (shiftUp > 0) for (var a = 0; a < n; a++) out[a] -= shiftUp
  var shiftDown = top - (out[0] - half)
  if (shiftDown > 0) for (var c = 0; c < n; c++) out[c] += shiftDown
  return out
}

// ------------------------------------------------------------ leader path

// Anchor to chip in three runs: a short stub straight off the shell, a
// vertical climb in the gutter, then a horizontal run into the chip edge.
// Corners are rounded by the renderer via the returned radius.
//
// Returns points in draw order. A leader whose anchor already lines up
// with its chip degenerates to a single straight run, which is the whole
// point of placing chips at their anchor height wherever possible.
function leaderPath(anchor, chip, elbowX, radius) {
  var enterX = chip.side === "left" ? chip.x + chip.w : chip.x
  var y = chip.y

  if (Math.abs(anchor.y - y) < 0.75) {
    return { points: [{ x: anchor.x, y: y }, { x: enterX, y: y }], radius: 0, straight: true }
  }
  return {
    points: [
      { x: anchor.x, y: anchor.y },
      { x: elbowX, y: anchor.y },
      { x: elbowX, y: y },
      { x: enterX, y: y }
    ],
    // Never round more than half the shortest run, or the corners fight.
    radius: Math.max(0, Math.min(radius, Math.abs(y - anchor.y) / 2, Math.abs(elbowX - anchor.x), Math.abs(enterX - elbowX))),
    straight: false
  }
}

// ------------------------------------------------------------ full layout

// opts:
//   buttons    [{ code, x, y, side, ... }] anchors already in canvas pixels
//   bounds     { top, bottom } vertical room the chips may use
//   left/right { x, width } gutter geometry, x is the outer edge
//   chipHeight, chipGap, stub, radius
//
// Chip widths come from the caller because only the renderer can measure
// text; widths[code] in pixels, falling back to the gutter width.
function layout(opts) {
  var buttons = opts.buttons || []
  var chipHeight = opts.chipHeight || 34
  var gap = opts.chipGap === undefined ? 8 : opts.chipGap
  var pitch = chipHeight + gap
  var half = chipHeight / 2
  var widths = opts.widths || {}
  var bounds = opts.bounds || { top: 0, bottom: 400 }

  var sides = { left: [], right: [] }
  for (var i = 0; i < buttons.length; i++) {
    var side = buttons[i].side === "left" ? "left" : "right"
    sides[side].push(buttons[i])
  }

  var out = []
  var names = ["left", "right"]
  for (var s = 0; s < names.length; s++) {
    var name = names[s]
    var group = sides[name].slice()
    if (group.length === 0) continue

    // Anchor order is the order chips must keep for leaders not to cross.
    group.sort(function (a, b) { return a.y - b.y || a.code - b.code })

    var desired = []
    for (var d = 0; d < group.length; d++) desired.push(group[d].y)

    var centres = fitToBounds(isotonic(desired, pitch), pitch, bounds.top, bounds.bottom, half)

    var gutter = name === "left" ? opts.left : opts.right
    for (var g = 0; g < group.length; g++) {
      var button = group[g]
      var width = widths[button.code] || gutter.width
      var chip = {
        // Left-gutter chips are right-aligned against the shell so their
        // entry edges line up; right-gutter chips are left-aligned.
        x: name === "left" ? gutter.x + gutter.width - width : gutter.x,
        y: centres[g],
        w: width,
        h: chipHeight,
        side: name
      }
      var elbowX = name === "left"
        ? Math.min(button.x - opts.stub, chip.x + width + opts.stub)
        : Math.max(button.x + opts.stub, chip.x - opts.stub)

      out.push({
        code: button.code,
        side: name,
        anchor: { x: button.x, y: button.y },
        chip: chip,
        leader: leaderPath({ x: button.x, y: button.y }, chip, elbowX, opts.radius === undefined ? 10 : opts.radius)
      })
    }
  }
  return out
}

// Vertical room a gutter needs before layout() has to start compressing.
function requiredHeight(count, chipHeight, gap) {
  if (count <= 0) return 0
  return count * chipHeight + (count - 1) * gap
}

if (typeof module !== "undefined") {
  module.exports = {
    isotonic: isotonic,
    fitToBounds: fitToBounds,
    leaderPath: leaderPath,
    layout: layout,
    requiredHeight: requiredHeight
  }
}
