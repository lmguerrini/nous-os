# macOS tunnel and menu bar tools

This folder contains a macOS tunnel kit and a small menu bar controller. The kit runs the tunnel client behind a local read-only gate, tracks session state and presence, and stops the tunnel when its limits are reached. The menu bar app starts and stops the kit, shows its state, and offers diagnostics.

## Requirements and configuration

Use macOS, a Swift toolchain with AppKit, Python 3, and the tunnel client executable. Set these variables in the environment used to start the kit:

- `NOUSOS_TUNNEL_CLIENT`: path to the tunnel client. If unset, the kit searches `PATH` for `tunnel-client`.
- `NOUSOS_GATE_CHILD`: executable wrapper launched by the read-only gate. This is required.
- `NOUSOS_PROPOSALS`: proposals file used by the development proxy preflight.
- `NOUSOS_PYTHON`: Python 3 executable. If unset, the kit searches `PATH` for `python3`.
- `NOUSOS_TUNNEL_KIT`: optional path to `nousos-tunnel.sh` for the menu bar app. The app otherwise uses the connector beside this source checkout; `install.sh` stores that checkout path in its LaunchAgent.

The tunnel client profile is expected at `~/.config/tunnel-client/nousos-read.yaml`. The kit stores runtime state and logs under the current user's Library folders.

## Control and shutdown

Run commands from the repository root. Export the required kit variables first.

```sh
tools/macos/connector/nousos-tunnel.sh start --presence
tools/macos/connector/nousos-tunnel.sh status
tools/macos/connector/nousos-tunnel.sh stop
```

Presence mode keeps the tunnel available while the Mac is in use and shuts it down after 30 minutes away. Regular sessions shut down after the configured idle period; every session also has a maximum duration. The menu bar's start action uses presence mode. Presence can also be enabled or disabled separately through the menu.

## Menu bar

The Italian menu labels are `Accendi NousOS` (start), `Spegni NousOS` (stop), `Avvio automatico quando uso il Mac` (presence mode), `Diagnostica` (diagnostics), and `Esci` (quit). Status text includes `Spento`, `Avvio…`, `Connesso`, `Riconnessione…`, or `Errore` as appropriate.

The menu bar icon uses a brain outline while off, a filled brain while connected, a dim outline while starting, a filled brain with a refresh badge while reconnecting, and an outline with an alert badge on error.

## Install and remove the menu app

On macOS, install the app and its per-user LaunchAgent with:

```sh
bash tools/macos/menu-bar/install.sh
```

Remove it with:

```sh
bash tools/macos/menu-bar/uninstall.sh
```

## Local tests

These checks require macOS and are not part of CI. Run the Swift classifier tests and Python kit tests from the repository root:

```sh
bash tools/macos/menu-bar/tests/run-tests.sh
python3 -m pytest tools/macos/connector -q -p no:cacheprovider
```
