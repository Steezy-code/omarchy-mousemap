import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui as Ui
import "Dpi.js" as Dpi

// Pointer speed, in DPI, and the presets you switch between.
//
// Reads and writes through the panel rather than holding its own copy, so
// the header readout and this sidebar can never disagree about which
// preset is live.
//
// Selecting or editing a preset applies it to the running compositor
// immediately, because pointer speed is the one setting nobody can judge
// from a number. Nothing is written to disk until Apply, which is the same
// promise every other control in this panel makes.
Item {
  id: root

  property var panel: null

  readonly property var config: panel ? panel.dpiConfig : Dpi.blank()
  readonly property bool on: panel ? panel.dpiOn : false
  readonly property int current: panel ? panel.dpiCurrent : 0
  readonly property int editing: panel ? panel.dpiEditing : -1
  readonly property int ceiling: Dpi.ceilingFor(config.base)

  readonly property var live: on && current < config.presets.length
    ? config.presets[current] : null

  // Where the live preset sits in everything this mouse could reach, which
  // is what the meter under the readout is showing. Anchored at zero rather
  // than at the lowest preset so the bar means the same thing whatever the
  // presets happen to be.
  readonly property real position: live && ceiling > 0
    ? Math.max(0, Math.min(1, live.dpi / ceiling)) : 0

  ColumnLayout {
    anchors.fill: parent
    spacing: Style.space(3)

    // ---------------------------------------------------------- header
    RowLayout {
      Layout.fillWidth: true
      spacing: Style.space(2)

      ColumnLayout {
        spacing: 1
        Text {
          text: "Pointer speed"
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.subtitle
          font.weight: Font.DemiBold
        }
        Text {
          text: root.on ? root.config.presets.length + " presets" : "off"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }
      Item { Layout.fillWidth: true }
      Ui.Button {
        text: root.on ? "Turn off" : "Turn on"
        bordered: true
        active: !root.on
        onClicked: root.panel.setDpiEnabled(!root.on)
      }
    }

    Rectangle {
      Layout.fillWidth: true
      implicitHeight: 1
      color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.12)
    }

    // ---------------------------------------------------------- off
    //
    // The pitch, for a mouse that has never had presets. It says what this
    // does and, just as importantly, what it does not do — nothing is
    // written to the mouse here either.
    ColumnLayout {
      Layout.fillWidth: true
      visible: !root.on
      spacing: Style.space(3)

      Text {
        Layout.fillWidth: true
        text: "Switch between named pointer speeds — a slow one for aiming, "
            + "a fast one for crossing three monitors — and bind a button to "
            + "step through them."
        wrapMode: Text.WordWrap
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
      }
      Text {
        Layout.fillWidth: true
        text: "Like everything else here, this is a Hyprland setting scoped to "
            + "this mouse. Nothing is written to the mouse itself, so it still "
            + "behaves as it always did on any other machine."
        wrapMode: Text.WordWrap
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
      Item { Layout.fillHeight: true }
    }

    // ---------------------------------------------------------- readout
    //
    // The number, big, because it is the whole point of the panel — and a
    // meter showing where it sits in everything this mouse can reach, so
    // "1600" means something without knowing the sensor is set to 1600.
    Rectangle {
      Layout.fillWidth: true
      visible: root.on
      radius: Style.cornerRadius > 0 ? Style.cornerRadius : 6
      color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.10)
      border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.35)
      border.width: 1
      implicitHeight: readout.implicitHeight + Style.space(6)

      ColumnLayout {
        id: readout
        anchors.fill: parent
        anchors.margins: Style.space(3)
        spacing: Style.space(2)

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(2)
          Text {
            text: root.live ? String(root.live.dpi) : "—"
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.displayLarge
            font.weight: Font.DemiBold
          }
          Text {
            Layout.alignment: Qt.AlignBottom
            Layout.bottomMargin: Style.space(2)
            text: "DPI"
            color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.7)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            font.weight: Font.DemiBold
          }
          Item { Layout.fillWidth: true }
          Text {
            Layout.alignment: Qt.AlignBottom
            Layout.bottomMargin: Style.space(2)
            text: root.live ? root.live.name : ""
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
            Layout.maximumWidth: parent.width * 0.45
          }
        }

        Rectangle {
          Layout.fillWidth: true
          implicitHeight: Math.max(4, Style.space(2))
          radius: height / 2
          color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.14)

          Rectangle {
            height: parent.height
            radius: parent.radius
            color: Color.accent
            width: parent.width * root.position
            Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
          }
        }

        Text {
          Layout.fillWidth: true
          text: "reaches " + root.ceiling + " DPI"
          wrapMode: Text.WordWrap
          color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.75)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }
    }

    // ---------------------------------------------------------- presets
    Flickable {
      Layout.fillWidth: true
      Layout.fillHeight: true
      visible: root.on
      contentWidth: width
      contentHeight: body.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      ColumnLayout {
        id: body
        width: parent.width
        spacing: Style.space(2)

        Ui.PanelSectionHeader {
          Layout.fillWidth: true
          text: "PRESETS"
        }

        Repeater {
          model: { root.panel ? root.panel.configRev : 0; return root.config.presets }

          delegate: Rectangle {
            id: card
            required property var modelData
            required property int index
            readonly property bool chosen: root.current === index
            readonly property bool open: root.editing === index

            Layout.fillWidth: true
            implicitHeight: cardRow.implicitHeight + Style.space(4)
            radius: Style.cornerRadius > 0 ? Style.cornerRadius : 5
            color: chosen ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
                          : (cardMouse.containsMouse
                             ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.08)
                             : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.035))
            border.width: 1
            border.color: chosen ? Color.accent
                                 : (open ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.3)
                                         : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.10))

            RowLayout {
              id: cardRow
              anchors.fill: parent
              anchors.leftMargin: Style.space(3)
              anchors.rightMargin: Style.space(2)
              spacing: Style.space(2)

              Text {
                Layout.fillWidth: true
                text: card.modelData.name
                color: card.chosen ? Color.accent : Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.weight: card.chosen ? Font.DemiBold : Font.Normal
                elide: Text.ElideRight
              }
              Text {
                text: card.modelData.dpi
                color: card.chosen ? Color.accent : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              // Opens the editor for this preset without selecting it, so
              // renaming the sniper preset does not drop the pointer to it.
              Ui.Button {
                text: card.open ? "✕" : "✎"
                bordered: false
                fontSize: Style.font.caption
                horizontalPadding: Style.space(2)
                verticalPadding: Style.space(1)
                tooltipText: card.open ? "Close" : "Rename or change this preset"
                onClicked: root.panel.dpiEditing = card.open ? -1 : card.index
              }
            }

            MouseArea {
              id: cardMouse
              anchors.fill: parent
              anchors.rightMargin: Style.space(9)   // leave the edit button clickable
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.panel.selectDpiPreset(card.index)
            }
          }
        }

        // ------------------------------------------------------ editor
        Rectangle {
          Layout.fillWidth: true
          visible: root.editing >= 0 && root.editing < root.config.presets.length
          radius: Style.cornerRadius > 0 ? Style.cornerRadius : 5
          color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.05)
          border.width: 1
          border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.14)
          implicitHeight: editor.implicitHeight + Style.space(5)

          ColumnLayout {
            id: editor
            anchors.fill: parent
            anchors.margins: Style.space(3)
            spacing: Style.space(2)

            readonly property var preset: root.editing >= 0 && root.editing < root.config.presets.length
              ? root.config.presets[root.editing] : null

            Ui.TextField {
              Layout.fillWidth: true
              // One way only: rebinding on every keystroke fights the
              // cursor. The panel is updated on edit instead.
              text: editor.preset ? editor.preset.name : ""
              placeholderText: "Name"
              maximumLength: Dpi.MAX_NAME
              onTextEdited: root.panel.editDpiPreset(root.editing, { name: text }, false)
            }

            RowLayout {
              Layout.fillWidth: true
              spacing: Style.space(2)
              Ui.PanelSlider {
                Layout.fillWidth: true
                fillColor: Color.accent
                knobColor: Color.accent
                minimum: Dpi.STEP
                maximum: root.ceiling
                step: Dpi.STEP
                integer: true
                value: editor.preset ? editor.preset.dpi : 0
                onMoved: function (next) { root.panel.editDpiPreset(root.editing, { dpi: next }, false) }
                onReleased: function (next) { root.panel.editDpiPreset(root.editing, { dpi: next }, true) }
              }
              Text {
                Layout.minimumWidth: Style.space(24)
                horizontalAlignment: Text.AlignRight
                text: editor.preset ? editor.preset.dpi : ""
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }

            RowLayout {
              Layout.fillWidth: true
              spacing: Style.space(2)
              Item { Layout.fillWidth: true }
              Ui.Button {
                text: "Remove preset"
                bordered: true
                onClicked: root.panel.removeDpiPreset(root.editing)
              }
            }
          }
        }

        Ui.Button {
          Layout.fillWidth: true
          text: "Add a preset"
          bordered: true
          enabled: root.config.presets.length < Dpi.MAX_PRESETS
          onClicked: root.panel.addDpiPreset()
        }

        // ------------------------------------------------------ base
        Ui.PanelSectionHeader {
          Layout.fillWidth: true
          Layout.topMargin: Style.space(3)
          text: "YOUR MOUSE'S OWN DPI"
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(2)
          Ui.PanelSlider {
            Layout.fillWidth: true
            minimum: Dpi.MIN_BASE
            maximum: 6400
            step: 100
            integer: true
            value: root.config.base
            onMoved: function (next) { root.panel.setDpiBase(next, false) }
            onReleased: function (next) { root.panel.setDpiBase(next, true) }
          }
          Text {
            Layout.minimumWidth: Style.space(24)
            horizontalAlignment: Text.AlignRight
            text: root.config.base
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }
        }

        Text {
          Layout.fillWidth: true
          text: "What the sensor itself is set to. MouseMap never changes it and "
              + "cannot read it — set it in G HUB, Solaar or Piper and say so here."
          wrapMode: Text.WordWrap
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        Text {
          Layout.fillWidth: true
          text: "Set it high: coming down from a high sensor DPI stays smooth, "
              + "and presets cannot go above " + root.ceiling + " DPI."
          wrapMode: Text.WordWrap
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        Text {
          Layout.fillWidth: true
          text: "Wrong number? Every preset is off by the same factor — the labels "
              + "drift, the steps between them stay exact."
          wrapMode: Text.WordWrap
          color: Qt.rgba(Color.muted.r, Color.muted.g, Color.muted.b, 0.8)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          font.italic: true
        }

        // Where the button hint lives, inside the scroll rather than
        // competing with the presets for the column's fixed height.
        Text {
          Layout.fillWidth: true
          Layout.topMargin: Style.space(3)
          text: "Click a button on the diagram and pick Next DPI preset to switch "
              + "with your thumb, or Hold to slow down for a sniper button."
          wrapMode: Text.WordWrap
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        Item { Layout.preferredHeight: Style.space(3) }
      }
    }

    // ---------------------------------------------------------- footer
    RowLayout {
      Layout.fillWidth: true
      spacing: Style.space(2)
      Item { Layout.fillWidth: true }
      Ui.Button {
        text: "Done"
        bordered: true
        onClicked: root.panel.dpiOpen = false
      }
    }
  }
}
