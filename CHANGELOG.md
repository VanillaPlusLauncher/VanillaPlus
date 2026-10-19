# Changelog

**English** · [Русский](CHANGELOG.ru.md)

## 1.7.0 — in development

**New name.** The launcher is now called Amethyx Launcher: a new pixel X logo and an amethyst look: violet-dark backgrounds and an amethyst accent by default (the other theme colours, cream vanilla included, stay in Settings). Settings, accounts, skins, Java and instances of Vanilla+ Launcher and RichLauncher move over by themselves on the first start.

### Friends
- Friends in the sidebar: add by name, requests, who is online and what they play, "Join" a friend's server
- Offline accounts with a popular name (Steve, Alex…) are no longer turned away: when the name is taken, the account gets a short code and friends add it as "Steve#3fa1"
- Chat like in Essential: text, in-game screenshots (kept for 30 days), clickable links, an invite to play with an instance your friend builds in one click ("Build and play"). Messages arrive instantly
- Friends join your world: the launcher installs the e4mc mod into modded instances. Open the world to LAN (Esc → "Open to LAN"), the world gets an address for friends, press ▶ → "Into my world" in the chat. Your friend gets a "Join world" button: the launcher picks or builds the right instance and joins the address — no public IP or router setup. In an instance without mods friends can only join on the same network (Wi-Fi, Radmin VPN)
- Export → "Send to a friend": the instance goes straight into the chat
- Friends, chat and shared skins work through the Amethyx server (the `server` folder, Cloudflare Workers); all of it can be turned off in Settings → "Friends and skins"

### Skins
- Your player stands in 3D on the right of the home screen — hold and drag it to turn it round and look at your skin from every side: follows the mouse, sways, greets you on hover, jumps when the game starts and does gestures on its own — claps, stretches, shrugs, looks around, steps in place, salutes, thinks, dances, dabs, flexes, blows a kiss, bows, strikes a pose, facepalms, celebrates — some with pixel hearts, sparkles, notes or stars around it
- A Bedrock-style "Wardrobe" under the player: your skin in the middle, Steve and Alex at the sides and your saved skins — switched with arrows and smooth movement, "Wear" in one click. The skin in the middle hops with its arms up to say hi, and every skin shows its own move when it comes to the middle. The skin you wear is marked "worn" where it already is — wearing a skin never adds a copy; three short steps explain how to get skins from the sites
- Ready-made skins only: "Load PNG", "By name", "The Skindex" and "NameMC" — a skin downloaded on the site appears in the Wardrobe by itself, with its name; the Steve or Alex model is detected automatically; the same skin is never saved twice
- Microsoft accounts: "Wear" also puts the skin on your real Minecraft profile, so every player on every server sees it; "Reset skin" brings back the default one
- Ely.by accounts: an Amethyx skin (other Amethyx players see it in modded instances through CustomSkinLoader); "To Ely.by" hands the skin file over to the Ely.by upload page for everyone else
- A skin per account; a sharper 3D model with correct colors and a crisp name tag

### Instances and mods
- Import from other launchers (Instances → "From other launchers"): Prism Launcher, ElyPrismLauncher, PolyMC, MultiMC, Modrinth App, CurseForge, ATLauncher, GDLauncher, Millida, TLauncher, SKLauncher, Legacy Launcher and the official launcher are found automatically; the version, loader, mods, settings, resource packs, shaders, worlds and screenshots move over
- One-click "Optimization": the launcher looks at memory, CPU, graphics card and monitor, finds conflicts, installs performance mods for the loader and version (Sodium, Lithium, FerriteCore, ModernFix and more), picks memory, Java flags and graphics settings. It reads what the instance's mods are incompatible with and never suggests such mods (for example, ScalableLux next to Create Aeronautics). "Undo" reverts everything
- Faster downloads everywhere: many files at once, and a file of 1 MB and more in several parts at the same time, like a browser does — both set in Settings → "Library" → "Downloads"
- "Update all" updates every mod at once in parallel under one task in the top bar ("3 of 12"); the top bar also names the instance a download is for
- Faster modpack installs and a shared mod cache
- A "Servers" tab with three parts: "My server" (a server made from the instance with the same mods, without client-only ones: start, console, mod updates); "For hosting" (the instance as a server pack, a zip or a plain folder: tick the mods, configs, resource packs, data packs, a world and, if you like, a whole ready server with its core and start scripts; the server's mod list as a text file); "Other servers" (the servers you play on, the same list as in the game: players, ping, Play, add and edit)
- Better at telling client-only mods: mods not installed through the launcher are recognised on Modrinth by their file, Forge/NeoForge "clientSideOnly" is read, and well-known client mods (Sodium, Iris, minimaps, Mod Menu…) are known by name
- "Export": a short code (Instances → "Paste code") or a file — Modrinth (.mrpack), CurseForge (.zip), plain .zip
- "Library" instead of "Mods": modpacks, mods, resource packs, shaders and data packs; the game version and loader in filters can be changed by hand (for example, for Sinytra Connector)
- Compatibility check before installing a mod (warnings can be turned off)
- World backups before mod updates and version changes, restored in one click
- Mods: select several at once, change a mod's version, mod page, export the list, "Folder" and "Configs" buttons
- Custom instance groups with drag and drop; "Change picture…" on right click; a "Notes" tab; Notes, Version, Java and Files are gathered under the instance's "Settings"

### Launcher
- A short tutorial on the first start (after the language question): the account, Play, Instances, Library, Friends, the Wardrobe and Settings are lit up one by one with a few plain words about each. Nothing to choose; "Skip" ends it. It can be shown again in Settings → "Launcher"
- The installer is dark like the launcher, with screenshots of the current look
- A new pixel-cut look: buttons, panels, fields, switches and cards have corners cut by one pixel step instead of rounded ones; buttons are solid raised blocks (a light strip on top, a darker one at the bottom) that press down when clicked, the main one in the theme colour with light specks. The Friends panel is wider so the account switch fits
- The close button hides the launcher in the tray: friends' messages and downloads go on; click the icon to open it, right-click → "Quit" to exit. Can be turned off in Settings → "Launcher"
- Tooltips in the launcher's style instead of Windows' grey ones; a glint on the main buttons, hopping sidebar icons, a breathing Play button, springy dialogs
- A launcher that moves: cards lean towards the mouse in 3D with a soft light, the panorama drifts as you move the mouse, the Minecraft logo floats and rocks, icons hop and wiggle under the pointer, the X of the name glints, buttons give under a click
- Amethyx's own notifications: a soft card in the corner of the screen with the launcher's icon and text in its pixel font; appears at once and hides by itself
- Background: panoramas from 19 Minecraft versions (1.7.10 to 26.3), loaded quickly and applied at once
- The music is silent while the game runs and pauses when the window is not in focus; a sound of your choice for every action
- Seven languages: English, Russian, Spanish, Portuguese, German, French and Chinese; on the first start the launcher asks which one (Windows' language is offered first)
- Top left: the version, a floating logo (leads Home) and the name; a "Full screen" button (F11); more light animations (can be turned off in settings)
- Ely.by sign-in on the Ely.by website; password sign-in stays as a fallback
- Fixed: after opening the Wardrobe several times the player on the home screen turned into a white box (the 3D views were not released)
- Fixed: NameMC sometimes reported an error before the skin came in (its Cloudflare check reloads the page); its 3D picture is no longer taken for a skin
- The Wardrobe has five places: your main skin (never written over) and four slots; a new skin goes into the slot you are looking at
- A start screen: the X, the name and a piece of an amethyst geode turning in the air (amethyst, budding amethyst, calcite and smooth basalt with the game's own textures; crystals grow from a small bud to a cluster, sparkles blink) while everything is loaded at once (the game's textures, instances, accounts, fonts, news); the launcher opens ready
- "Loading" everywhere is the launcher's X; mods without a picture get one from CurseForge or Modrinth by their name (BadOptimizations, for example)
- Installing several mods sounds once at the start and once when all are done
- Home: "All instances" and "minecraft.net" readable over any panorama; a recent instance opens with a click (the one Home plays is chosen in the play bar)
- The tray icon's menu in the launcher's own style
- Toasts no longer cover each other: only the newest shows, with a small grey "×N" in its corner; pointing at it spreads them into a list
- "Loading…" in the Library and Friends while the first answer is on its way; rows of the instance page come in, light up when ticked (a wave for "All"), and the selection bar slides in
- The home player strolls a few steps now and then and points at your mouse; the skin no longer flickers where its layers overlap, and with arms up the head no longer turns into them
- The instance memory slider moves right away and turns "Own value" on by itself; the "Note block" card is gone from Settings
- Fixed: the long mod list lagged (rows off screen are no longer drawn, ticking no longer redraws the list, the panorama's mouse drift no longer restyles the page); the Minecraft logo's shadow is no longer cut at the top; recent instances fade out at the edge instead of being cut
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
