# Changelog

**English** · [Русский](CHANGELOG.ru.md)

## 1.7.0 — in development

**New name.** The launcher is now called Vanilla+ Launcher: a new logo and a warm look with a vanilla accent. Settings, accounts, skins, Java and instances of the previous version move over by themselves on the first start.

### Friends
- Friends in the sidebar: add by name, requests, who is online and what they play, "Join" a friend's server
- Chat like in Essential: text, in-game screenshots (kept for 30 days), clickable links, an invite to play with an instance your friend builds in one click ("Build and play"). Messages arrive instantly
- Friends join your world: the launcher installs the e4mc mod into modded instances. Open the world to LAN (Esc → "Open to LAN"), the world gets an address for friends, press ▶ → "Into my world" in the chat. Your friend gets a "Join world" button: the launcher picks or builds the right instance and joins the address — no public IP or router setup. In an instance without mods friends can only join on the same network (Wi-Fi, Radmin VPN)
- Export → "Send to a friend": the instance goes straight into the chat
- Friends, chat and shared skins work through the Vanilla+ server (the `server` folder, Cloudflare Workers); all of it can be turned off in Settings → "Friends and skins"

### Skins
- Your player stands in 3D on the right of the home screen — hold and drag it to turn it round and look at your skin from every side: follows the mouse, sways, greets you on hover, jumps when the game starts and does gestures on its own — claps, stretches, shrugs, looks around, steps in place, salutes, thinks, dances, dabs, flexes, blows a kiss, bows, strikes a pose, facepalms, celebrates — some with pixel hearts, sparkles, notes or stars around it
- A Bedrock-style "Wardrobe" under the player: your skin in the middle, Steve and Alex at the sides and your saved skins — switched with arrows and smooth movement, "Wear" in one click. The skin in the middle hops with its arms up to say hi, and every skin shows its own move when it comes to the middle
- Ready-made skins only: "Load PNG", "By name", "The Skindex" and "NameMC" — a skin downloaded on the site appears in the Wardrobe by itself, with its name; the Steve or Alex model is detected automatically; the same skin is never saved twice
- A Vanilla+ skin for Microsoft and Ely.by accounts: the account's real skin stays unchanged. In modded instances the launcher installs CustomSkinLoader, and other Vanilla+ players see your skin
- A skin per account; a sharper 3D model with correct colors and a crisp name tag

### Instances and mods
- Import from other launchers (Instances → "From other launchers"): Prism Launcher, ElyPrismLauncher, PolyMC, MultiMC, Modrinth App, CurseForge, ATLauncher, GDLauncher, Millida, TLauncher, SKLauncher, Legacy Launcher and the official launcher are found automatically; the version, loader, mods, settings, resource packs, shaders, worlds and screenshots move over
- One-click "Optimization": the launcher looks at memory, CPU, graphics card and monitor, finds conflicts, installs performance mods for the loader and version (Sodium, Lithium, FerriteCore, ModernFix and more), picks memory, Java flags and graphics settings. It reads what the instance's mods are incompatible with and never suggests such mods (for example, ScalableLux next to Create Aeronautics). "Undo" reverts everything
- Faster modpack installs: 12 parallel downloads and a shared mod cache
- One-click own server on the "Own server" tab: a server made from the instance with the same mods (without client-only ones), start, console, mod updates
- "Export": a short code (Instances → "Paste code") or a file — Modrinth (.mrpack), CurseForge (.zip), plain .zip
- "Library" instead of "Mods": modpacks, mods, resource packs, shaders and data packs; the game version and loader in filters can be changed by hand (for example, for Sinytra Connector)
- Compatibility check before installing a mod (warnings can be turned off)
- World backups before mod updates and version changes, restored in one click
- Mods: select several at once, change a mod's version, mod page, export the list, "Folder" and "Configs" buttons
- Custom instance groups with drag and drop; "Change picture…" on right click; a "Notes" tab; Notes, Version, Java and Files are gathered under the instance's "Settings"

### Launcher
- The close button hides the launcher in the tray: friends' messages and downloads go on; click the icon to open it, right-click → "Quit" to exit. Can be turned off in Settings → "Launcher"
- Tooltips in the launcher's style instead of Windows' grey ones; a glint on the main buttons, hopping sidebar icons, a breathing Play button, springy dialogs
- Vanilla+'s own notifications: a soft card in the corner of the screen with the launcher's icon and text in its pixel font; appears at once and hides by itself
- Background: panoramas from 19 Minecraft versions (1.7.10 to 26.3), loaded quickly and applied at once
- The music is silent while the game runs and pauses when the window is not in focus; a sound of your choice for every action
- Seven languages: English, Russian, Spanish, Portuguese, German, French and Chinese; on the first start the launcher asks which one (Windows' language is offered first)
- Top left: the version, a floating logo (leads Home) and the name; a "Full screen" button (F11); more light animations (can be turned off in settings)
- Ely.by sign-in on the Ely.by website; password sign-in stays as a fallback
- New installer pictures; the installer checks for 64-bit Windows 10 (1803+) or 11

### Fixes
- Instances imported from Prism with the Java flag `-Xlog:...file=logs/gc.log` did not start ("Could not create the Java Virtual Machine")
- Switching the loader from Vanilla to Fabric did nothing; affected instances repair themselves
- Settings sometimes were not saved (EPERM) while an antivirus held the file

## 1.3.1 — 2026-10-19

- The launcher notices new Minecraft versions by itself: the version list refreshes every half hour, a new release brings a notification with a "Create instance" button
- The first loading screen just says "Loading"

## 1.3.0 — 2026-10-19

The first version with auto-update.

- Launcher auto-update: checked at start and every 6 hours, downloaded in the background with a SHA-256 check, installed in one click; an "Updates" section in settings
- An instance opens in one click; new tabs: Screenshots, Log, Version, Java, Files
- The log explains common errors; after a crash it shows the cause right away and leads to the fix
- Mods: client/server marks, turning client-only or server-only mods off in bulk, automatic mod updates before launch
- "Repair files" on the "Version" tab
- Drop-down lists in the launcher's style, with search in long lists
- Fixed: installing modpacks from Modrinth ("paths[0]"); a half-installed instance is now removed
- Fixed: the launcher crashed when the connection dropped at the end of a big download

## 1.2.0

- Ely.by sign-in
- Instances with groups; mods, resource packs, shaders and modpacks from Modrinth and CurseForge
- Fabric, Quilt, Forge, NeoForge
- Skin editor with 3D preview and animations
- Java from several vendors
- Minecraft look: panorama, sounds, music
- Installer with screenshots
