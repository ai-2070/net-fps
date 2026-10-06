# Net Shooter

A small first-person shooter prototype built with [three.js](https://threejs.org/), with online co-op over [NET](https://ai2070.net/docs) (`@net-mesh/browser` 0.40.0).

## Running

```sh
npm install
npm start
```

`npm start` builds the game into `dist/` (`scripts/build.mjs`), rebuilds it on every change, and serves it over HTTPS at https://localhost:8081/ (WebCrypto and WebRTC need a secure context). For co-op, open it in two browsers, or two tabs. In one, go to Play → Co-op → Host game. In the other, open the server browser and join.

Co-op needs a NET anchor, which introduces players' browsers to each other. By default it uses NET's public anchor, `https://anchor.ai2070.net`, so there's nothing to run for it. The public anchor keeps each site's games apart: players of your page see each other's lobbies, never another site's, even one that also calls its game `net-shooter`.

One-time setup for `npm start`: **mkcert**, for a certificate your browser trusts. `winget install FiloSottile.mkcert` (or `brew install mkcert`), then `mkcert -install`.

To run your own anchor instead, `npm start -- --local-anchor` starts one on :8444 and prints a page URL with `?anchor=` pointing at it. It needs a `net-mesh` with the anchor feature: download `net-mesh-anchor-v0.40.0-<platform>` from the [NET release](https://github.com/ai-2070/net/releases/tag/v0.40.0) (x86_64 Linux and Windows), or build it with `cargo install net-cli --features rtc-bootstrap`. Put it at `.anchor/bin/net-mesh(.exe)`, or set `NET_MESH_BIN`. The first run fills `.anchor/` with the mesh key, the credential issuer key and the certificate. It's git-ignored; keep it private.

Other options:
- `npm start -- --host <LAN IP>`: play across your LAN. Other machines must trust your mkcert CA.
- `?anchor=https://…` on the page URL: use a different anchor than the public one.
- `ANCHOR_STATS=1`, `ANCHOR_VERBOSE=1|2|3`: anchor diagnostics.
- `netDebug()` in the devtools console: this player's connection details.

Use a regular browser. Embedded editor previews may block WebRTC.

### Building

`npm run build` writes the game to `dist/`, ready for any static host:

- `js/main.js`, bundled with three.js and NET from `node_modules` and minified. NET (`js/net.js`) stays a separate chunk, loaded only when co-op is opened, so solo never loads it.
- NET's WebAssembly leaf (`net_leaf.js` and `net_leaf_bg.wasm`), copied next to the chunks. NET imports it at run time from beside its own code, which no bundler can follow.
- `index.html` and `css/style.css`.

three.js and NET are pinned npm dependencies (Renovate keeps them current); only the font still comes from a CDN (Google Fonts).

## Controls

| Action | Input |
| --- | --- |
| Move | W A S D |
| Look | Mouse |
| Fire | Left click (hold for automatic fire) |
| Aim down sights | Right click |
| Reload | R |
| Sprint | Shift |
| Jump | Space |
| Pause | Esc |

## What's in it

- **Solo:** a walled arena with crates and cover, plus eight target dummies that patrol, take damage (headshots do double), and respawn three seconds after they go down.
- **Menus:** main menu, mode select (Solo / Co-op), settings (player name, sensitivity, FOV, volume, saved in `localStorage`), controls, and a pause menu (Resume, Settings, Controls, Quit to main menu). Esc steps back out of sub-menus.
- **Co-op over [NET](https://ai2070.net/docs), 2–4 players:**
  - **Host game** opens a NET lobby with the form's settings: server name, max players (2–4), map, region tag, optional password and friendly fire. Everything but the password and friendly fire shows in the server browser; a password marks the game locked.
  - **Server browser** lists open games with NET's `listLobbies`, with columns for server, region, map, players and route. Search matches server names; the region dropdown, Hide full and Hide empty filter the list; column headers sort it; Refresh fetches it again. If NET can't be reached, the list says why and the status reads "Not connected to NET".
  - **Joining:** select a row, then Join (or double-click, or Enter; the arrow keys move the selection). Full games can't be joined. Selecting a locked game shows a password box next to Join, and the host checks the password.
  - **The host is authoritative.** Each player predicts their own movement with the same rules the host runs (`js/sim.js`), and the host confirms it. Other players are smoothed between host snapshots.
  - **Shots** feel instant locally, but the host decides what they hit, using NET's lag compensation (`rewind`): a shot hits what the shooter saw when they fired.
  - **Targets and kills** are shared. "Targets down" counts the whole team.
  - **Connections:** players connect peer-to-peer over WebRTC. The anchor only introduces them, and relays traffic when a direct link can't be made. For a joined player, the pause menu shows the route (Direct or Relayed) and the round trip, e.g. "Co-op · Direct · 42 ms"; the host's shows "Co-op · Hosting".
  - **Leaving:** when a player leaves or closes the tab, their character disappears. If the host leaves, the game ends for everyone.
  - **Limits:** friendly fire is a lobby setting only, since players have no health yet. Players don't collide with each other.

  How the browser maps to NET:
  - **Region** is a label the host picks from a fixed list (EU West, EU East, NA East, NA West, South America, Asia, Oceania). NET doesn't measure it, so it's only a category to filter by, not a speed hint. The host form says so under the field.
  - **Route** replaces a ping column. NET reports whether the path to a peer is direct or relayed through another node. A listing has no route or round-trip figure until you've joined, so the browser shows "—". The round trip in the pause menu comes from the netcode clock once connected.

## How co-op uses NET

All of it is in `js/net.js`, which `js/main.js` loads only when you open co-op. A NET outage never breaks solo.

| Piece | NET API | What it does here |
|---|---|---|
| Connection | `requestCredential`, `connect` | The page asks the anchor for an anonymous credential and becomes a NET node. There's one node per page, with a fresh identity on every load. |
| Staying connected | `call` (to a service nobody runs) | Before browsing or hosting, and when the tab comes back to the front, the node checks its session with the anchor is still there; if not, it's replaced. |
| Hosting | `createLobby` | Hosts the game's store: the roster of names, colours and kills. It also publishes the listing the server browser shows. |
| Server browser | `listLobbies` | Lists open games: name, region, map, players, lock. |
| Joining | `joinLobby`, then an `enlist` action | Joins the store. The host checks the password in `enlist`, so it never leaves the host's page. |
| Movement | `hostNetcode` / `joinNetcode` | Host-authoritative tick at 30 Hz. Each client predicts itself and reconciles, and other players are interpolated. |
| Shots | netcode inputs + `rewind` | Shots ride along with inputs, and the host resolves them against the targets as the shooter saw them. |
| Direct links | `peerAttempt`, `acceptPeer` | The host answers joining players, so they connect peer-to-peer instead of staying on the anchor's relay. |

Things worth knowing, found while building it:

- **Each hosted game gets its own store ID and movement label**, with a random suffix; joiners read it from the listing. If a tab reused the names of a game it had hosted before, a player tab that was in the earlier game couldn't join the new one until someone reloaded.
- **A tab left in the background can lose its session with the anchor** (the browser slows or freezes it, and the anchor drops it). It then neither sees games nor is seen hosting one. `liveNode` in `js/net.js` checks the node before it's used for that (at most every 20 s) and when the tab comes back to the front, and makes a new one if the session is gone. Never during a game.
- **Joining doesn't wait for a direct link.** `connectPeer` only returns once the direct attempt has settled, which where none can be had is the whole ICE deadline. The lobby is joined through a node whose `connectPeer` goes on after 1.5 s, over the relayed session; the direct link, when it comes, takes over underneath. If that fast join fails, it's retried with the full wait. Netcode is handed the node without `connectPeer` at all, so movement starts on the session the lobby already brought up.
- **The host answers every offer while the pair isn't direct and no attempt is under way**, not just the first, so a player whose first direct attempt failed can still go direct later. Since NET 0.39, `connectPeer` itself never cancels an attempt under way or re-offers on a direct pair.
- **The anchor must be NET 0.37.1 or later.** A 0.37.0 anchor stops relaying to a browser 90 s after it connects, so a host becomes unreachable to new players.

### How NET was added

The game started as a solo shooter whose co-op menus were already shaped around NET: a server browser with Region and Route columns and a Host Game form, but only placeholder data behind them. NET was added in these steps:

1. **Load NET only for co-op.** `js/main.js` loads `js/net.js` with a dynamic `import()` the first time co-op is opened, so solo never loads NET. (It first came from the jsDelivr CDN; it's now an npm dependency, bundled into its own chunk.)
2. **Share the movement rules.** Player movement and collision moved out of `js/game.js` into `js/sim.js` as a pure `stepPlayer(state, input)` function with no three.js in it, next to the arena layout. Solo, the co-op host and each client's prediction all run the same function, so the host and clients agree on movement (0 prediction corrections in testing).
3. **Write the session layer (`js/net.js`).** `hostGame` and `joinGame` return a small session object that the game uses: `input()`, `entities()`, `roster()`, `teamKills()`, `onEnd()`, `leave()`. Everything NET-specific stays behind it: lobby, store, netcode and connection handling.
4. **Add a co-op mode to `js/game.js`.**
   - **Input:** a fixed 60 Hz loop sends inputs to the session, including while paused (the player just stands still).
   - **Rendering:** the local player is drawn where the session's prediction says; targets come from host snapshots.
   - **Other players:** drawn as avatars with name tags and tracers.
   - **Host only:** the host keeps simulating the targets and resolves everyone's shots in `resolveShot()`, moving targets back to where the shooter saw them (netcode `rewind`) before raycasting.
5. **Connect the menus.** The server browser's placeholder generator was replaced with `listLobbies`. The Join button now joins, with a password box for locked games. The Host Game form now calls `createLobby` with its settings. Settings gained a player name.
6. **Add a local anchor.** `scripts/dev.mjs` (`npm start -- --local-anchor`) runs `net-mesh anchor serve` for the game ID `net-shooter`, creating the mesh key, issuer key and mkcert certificate on first run.
7. **Test with real browsers.** A Playwright script ran the whole flow with separate browser contexts: host with a password, find the game in the browser, wrong and then right password, move, shoot, close the tab, re-host. It found and fixed these issues:
   - A node that had just connected listed no games, because announcements take a moment to arrive. The browser now keeps looking for 4 s.
   - A second NET node opened in the same tab right after closing the first had no session to the host. The page now keeps one node for its whole life (replaced only once its session is known to be gone).
   - Shot data on the player's movement entity counted as prediction "corrections". Shots now ride as separate `shot:<id>` entities.
   - Re-hosting reused closed streams between the same two tabs. Each game now gets its own store ID and movement label.

   Some lessons came from an earlier NET test game and were built in from the start:
   - The host only sends players whose inputs are still arriving, so a closed tab's character vanishes within about 2 s.
   - The host calls `acceptPeer`, so joins go direct instead of waiting about 20 s for the direct attempt to time out.
   - Each page load gets a fresh identity, so a reloaded tab can rejoin.

## Project layout

```
index.html          markup for the HUD and every menu screen
css/style.css       styling
js/main.js          entry point; game state (menu / playing / paused), pointer lock
js/game.js          scene, camera, player controls, rifle, targets, co-op rendering
js/sim.js           arena layout and player movement (shared by solo, co-op host and prediction)
js/net.js           NET: lobbies, host/join, netcode, connection handling (loaded only for co-op)
js/servers.js       the server browser
js/ui.js            menu screen stack, settings, host form
js/hud.js           HUD: ammo, kills, hit marker
js/audio.js         synthesized sound effects (Web Audio)
js/toast.js         notification toast

scripts/build.mjs   npm run build: the game into dist/
scripts/dev.mjs     npm start: build and watch, HTTPS page server, optional local NET anchor
```
