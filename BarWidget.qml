import QtQuick
import qs.Commons
import qs.Ui

// Bar entry: one glyph that opens the map. The panel is a real window
// rather than a bar popup, so this only has to summon it.
BarWidget {
  id: root
  moduleName: "io.github.steezy-code.mousemap"

  implicitWidth: Math.max(Style.bar.iconSlot, glyph.implicitWidth + Style.space(3))
  implicitHeight: Style.bar.iconSlot

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius > 0 ? Style.cornerRadius : 4
    color: area.containsMouse ? Style.hoverFill : "transparent"

    Text {
      id: glyph
      anchors.centerIn: parent
      // nf-md-mouse. Omarchy's default family is a Nerd Font patch; a
      // family without it falls back to the box glyph rather than failing.
      text: "󰍽"
      color: root.bar ? root.bar.barForeground : Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.bar.iconFont
    }
  }

  MouseArea {
    id: area
    anchors.fill: parent
    hoverEnabled: true
    onClicked: if (root.bar) root.bar.run("omarchy-shell shell toggle io.github.steezy-code.mousemap")
  }
}
