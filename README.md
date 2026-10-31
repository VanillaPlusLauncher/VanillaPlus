# Amethyx Launcher

An open-source Minecraft: Java Edition launcher for Windows.

**English** · [Русский](README.ru.md)

**Download:** [latest release](https://github.com/VanillaPlusLauncher/VanillaPlus/releases/latest) → `Amethyx-Setup-<version>.exe`.
The installed launcher updates itself: a new version downloads in the background and installs with one click.

![Home](docs/screenshots/home.png)

## Features

- **Accounts:** offline, Microsoft, [Ely.by](https://ely.by) (skins through authlib-injector)
- **Library:** modpacks, mods, resource packs, shaders and data packs from Modrinth and CurseForge; dependencies install by themselves, mod updates (also automatically before launch), client/server marks and turning client-only mods off for a server
- **Import from other launchers:** Prism, ElyPrism, PolyMC, MultiMC, Modrinth App, CurseForge, ATLauncher, GDLauncher, Millida, TLauncher, SKLauncher, Legacy Launcher and the official launcher — instances are found automatically
- **Instances like in Prism Launcher:** tabs for mods, resource packs, shaders, worlds, your own server, screenshots and the log; change the game version and loader, per-instance Java and memory, notes, custom groups with drag and drop
- **Game log** explains common errors and shows the cause right after a crash
- **Wardrobe:** ready-made skins from a PNG, by player name or from The Skindex and NameMC (a skin downloaded there appears in the launcher by itself), 3D preview with animations; a skin per account; on a Microsoft account "Wear" changes the real profile skin (and "Reset skin" brings the default back), Ely.by accounts get an Amethyx skin and a "To Ely.by" button
- **Friends:** requests, who is online and what they play, chat, joining a friend's world or own server directly (the launcher opens the port on the router, no mod needed) in one click
- Minecraft look and feel: panoramas from different game versions, sounds (one per action, your choice) and music
- Seven languages: English, Russian, Spanish, Portuguese, German, French, Chinese
- Notices new Minecraft versions and updates itself
- Runs on 64-bit Windows 10 (version 1803 and later) and Windows 11

### New in 1.7.0 (coming soon)

- **Friends and chat:** who is online and what they play, messages, in-game screenshots, invites with an instance your friend builds in one click
- **Friends join your world** directly: open the world to LAN and invite them in the chat; the launcher opens the port on your router (UPnP) and they come in, in any instance, vanilla too
- **3D player on the home screen:** follows the mouse, waves and does gestures; under it, a Bedrock-style **Wardrobe**
- **Ready-made skins:** from a PNG, by player name, from The Skindex and NameMC — a skin downloaded on the site appears in the Wardrobe by itself; other Amethyx players see your **Amethyx skin** even on Ely.by accounts
- **Import from other launchers:** Prism, ElyPrism, MultiMC, Modrinth App, CurseForge, TLauncher and more — instances are found automatically
- **One-click optimization:** performance mods, memory, Java flags and graphics settings for your PC; never suggests mods the instance is incompatible with
- **Faster modpack installs:** 12 parallel downloads and a shared mod cache
- **One-click own server**, **instance export** as a code or a file (.mrpack, CurseForge .zip, .zip), **world backups**, **mod compatibility checks**
- **Tray:** the close button hides the launcher next to the clock; **own notifications** in the Amethyx style
- **Panoramas** from 19 Minecraft versions, **seven languages**, **a sound per action**, **Ely.by sign-in on the website**
- New name, pixel X logo and an amethyst look; data of Vanilla+ Launcher and RichLauncher moves over by itself

| Instances | Library | Wardrobe | Friends |
| --- | --- | --- | --- |
| ![Instances](docs/screenshots/builds.png) | ![Library](docs/screenshots/mods.png) | ![Wardrobe](docs/screenshots/skins.png) | ![Friends](docs/screenshots/friends.png) |

## Building from source

You need Windows 10/11, [Node.js](https://nodejs.org) (for `npm install`), [Python 3](https://www.python.org) and [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```powershell
cd src
npm install --omit=dev
cd ..
.\installer\build.ps1
```

On the first run `build.ps1` downloads Electron (checking its SHA-256), packs `src` into `app.asar` and builds the installer in `build\`.
To run without installing: `build\Amethyx\Amethyx.exe` after the same script.

Releasing a new version: raise `version` in `src/package.json`, build, then
`.\installer\publish-update.ps1 -Repo VanillaPlusLauncher/VanillaPlus -Notes "What's new" -Publish`.

## Layout

- `src/src/main` — Electron main process: accounts, installing versions and loaders, launching the game, mods, Java, updates
- `src/src/renderer` — the interface (no frameworks, ES modules)
- `src/src/preload` — the bridge between them: everything goes through IPC with input checks
- `installer` — the installer (Inno Setup), build and publishing
- `website/cloud` — the Amethyx server for friends, chat and shared skins (PHP + SQLite on the site's hosting); `server` — its earlier Cloudflare Workers version, kept only to move the data over ([server/tools/README-migrate.md](server/tools/README-migrate.md))

## License

[GPL-3.0](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).

Amethyx Launcher is an unofficial launcher. It is not affiliated with or endorsed by Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Studios.
