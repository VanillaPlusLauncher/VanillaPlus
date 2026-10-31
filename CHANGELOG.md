# Changelog

**English** · [Русский](CHANGELOG.ru.md)

## 1.7.0 — in development

**New name.** The launcher is now called Amethyx Launcher: a new pixel X logo and an amethyst look: violet-dark backgrounds and an amethyst accent by default (the other theme colours, cream vanilla included, stay in Settings). Settings, accounts, skins, Java and instances of Vanilla+ Launcher and RichLauncher move over by themselves on the first start.

### Friends
- Friends in the sidebar: add by name, requests, who is online and what they play, "Join" a friend's server
- Offline accounts with a popular name (Steve, Alex…) are no longer turned away: when the name is taken, the account gets a short code and friends add it as "Steve#3fa1"
- Chat like in Essential: text, in-game screenshots (kept for 30 days), clickable links, an invite to play with an instance your friend builds in one click ("Build and play"). Messages arrive instantly
- Friends join your world through the Amethyx tunnel, in every instance — vanilla too, no mod needed: open the world to LAN (Esc → "Open to LAN") and press ▶ → "Into my world" in the chat. Your friend's launcher opens a local port into your world, so their game joins from any city — no public IP or router setup. An invite stays good: whenever your world is open again, the friend gets in (the launcher keeps one tunnel for your worlds). The launcher no longer puts e4mc into instances; when you have it anyway, its address goes into the invite for friends with another launcher
- Own server → "Access from the internet": one switch, and friends with Amethyx join your server from anywhere by an invite ("Invite a friend" on the server card). The tunnel opens whenever the server runs; up to 5 tunnels free
- An invite in the chat is a card with the instance's picture, name and version. "Join" builds the instance if needed, starts it and joins at once; "Only build" just builds it; while it builds, "Stop" stops it and removes the half-built instance. If the friend already has the instance, it simply starts
- Settings → "Friends and skins" → "Friend invites": whether the instance goes with an invite, whether mods not from Modrinth or CurseForge are uploaded (always, ask, never), and what the main button of a friend's invite does (join at once or only build)
- A friend joining shows a small card over the game; when a friend's world is closed, the launcher says so instead of a silent "connection lost"
- A panel over the game: while you play, press Shift+Tab and the Amethyx panel slides in from the right — invite a friend to your world or to your own server, reply in the chat, send your latest screenshot. The keys work only while the game's window is in front, so in other programs Shift+Tab does what it always does. Nothing goes into the game, so it works in every version and with every loader. A message card over the game says which keys answer it. The keys (Shift+Tab, Alt+X or F9) and the panel itself are in Settings → "Friends and skins"
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
- "Smart helper": a grass block on the Instances page and on each instance's page opens a small chat. Ask with a button or in your own words: it checks the mods for conflicts (the same mod twice, a mod for another loader or game version, mods their authors say do not work together, a required mod missing or switched off, two render engines and other known pairs) and fixes them with one button; suggests mods for speed and convenience, or the most downloaded ones on a topic (magic, technology, decoration, mobs…) that fit the instance; finds mod updates; opens "Optimization". No AI and nothing to pay: the checks are the launcher's own. It never pops up by itself — the first-start walk-through shows it once
- Opening an instance (the first time, or another one) shows its picture and "Загружаем сборку, подождите немного" until its list is drawn, instead of a page that looks ready but answers late
- Faster downloads everywhere: many files at once, and a file of 1 MB and more in several parts at the same time, like a browser does — both set in Settings → "Library" → "Downloads"
- "Update all" updates every mod at once in parallel under one task in the top bar ("3 of 12"); the top bar also names the instance a download is for
- Faster modpack installs and a shared mod cache
- A "Servers" tab with three parts: "My server" (a server made from the instance with the same mods, without client-only ones: start, console, mod updates); "For hosting" (the instance as a server pack, a zip or a plain folder: tick the mods, configs, resource packs, data packs, a world and, if you like, a whole ready server with its core and start scripts; the server's mod list as a text file); "Other servers" (the servers you play on, the same list as in the game: players, ping, Play, add and edit)
- "My server" asks where the server runs: on this computer (as before) or in the Amethyx cloud — the cloud is marked "Soon" for now. A server on this computer shows "Access from the internet" (a tunnel, soon): up to 5 tunnels free, more with a subscription; the Amethyx server already keeps that limit
- Mods added by hand that are only on CurseForge are recognised too (by CurseForge's file fingerprint, after Modrinth): they get their name, icon, the CurseForge mark and updates. Mods from CurseForge, installed or recognised, get "Client" / "Server" from CurseForge's own file tags
- Better at telling client-only mods: mods not installed through the launcher are recognised on Modrinth by their file, Forge/NeoForge "clientSideOnly" is read, and well-known client mods (Sodium, Iris, minimaps, Mod Menu…) are known by name
- "Export": a short code (Instances → "Paste code") or a file — Modrinth (.mrpack), CurseForge (.zip), plain .zip
- "Library" instead of "Mods": modpacks, mods, resource packs, shaders and data packs; the game version and loader in filters can be changed by hand (for example, for Sinytra Connector)
- "Library" → "Карты" (maps): maps from CurseForge and Minecraft Inside for the instance's version. A map goes into the instance as a new world: from CurseForge at once; for Minecraft Inside the launcher opens the map's page, and the archive downloaded there goes into the instance by itself (the site does not let programs download for the player). Zip and rar archives, the world in any folder, several worlds at once
- Compatibility check before installing a mod (warnings can be turned off)
- World backups before mod updates and version changes, restored in one click
- Mods: select several at once, change a mod's version, mod page, export the list, "Folder" and "Configs" buttons
- Custom instance groups with drag and drop; "Change picture…" on right click; a "Notes" tab; Notes, Version, Java and Files are gathered under the instance's "Settings"

### Launcher
- A short tutorial on the first start (after the language question): the account, Play, Instances, Library, Friends, the Wardrobe and Settings are lit up one by one with a few plain words about each. Nothing to choose; "Skip" ends it. It can be shown again in Settings → "Launcher"
- The installer is dark like the launcher, with screenshots of the current look
- Updates come from the launcher's site (launcher.x-world.plus/updates/latest.json) and from GitHub: both are checked, the newest version wins, either one being down does not stop updates. A launcher on a test build also gets new test builds from the site (updates/beta.json)
- The launcher updates itself: once the new version is downloaded and nothing is running (no game, server or download), it says so for a few seconds ("Later" leaves it for the next start), closes, the installer puts the new files in place in a small window in the launcher's soft look (a rounded panel, the X bobbing in a glow like the launcher's loading mark, a bar that moves in jerks) with no pages or buttons — a line in it says what is being done right now (closing the old version, putting the program, graphics, languages and the new version in place, with the percentage; "Done! Opening the launcher…") — and the launcher opens again. A version downloaded earlier is installed on the next start before the window opens. A failed install is not retried by itself, so the launcher never keeps closing; Settings → "Updates" → "Install by itself" turns it off
- Versions are written short ("1.7", not "1.7.0"), and test builds have their own number, 1.7-beta.N (shown as "v1.7 β28" under the logo): N counts the changes since the version was set and starts again with the next version. The released 1.7 counts as newer than all of its betas
- Windows 7, 8 and 8.1: a build of its own (`installer/build.ps1 -Legacy`, Amethyx-Setup-…-win7.exe) on Electron 22, the last one that runs there; it also suits Windows 10 older than 1803 and updates from its own feeds, never to the usual installer. On a Windows older than 10 1803 the usual installer says in plain words that this build is needed and opens the download page. Where Windows has no tar.exe, Java and world backups are unpacked and packed by the launcher itself
- A light start on Windows 7 / 8 and on computers with 4 GB of memory or less: animations, blur and music begin turned off, fewer downloads at once, Chromium's low-memory mode, and the 3D player on the home screen is drawn only while it is turned or gets a new skin (with animations off on any computer). Everything can be turned on in Settings
- The memory suggested for the game always leaves at least 2 GB for the system
- A first macOS build (Apple Silicon and Intel, `installer/build-mac.ps1`, made on Windows): Java for macOS from the same vendors (Mojang's runtimes included), the system's Java found in /Library/Java, world backups with the system tar. Not signed by Apple yet; updates on macOS are by hand for now
- A new pixel-cut look: buttons, panels, fields, switches and cards have corners cut by one pixel step instead of rounded ones; buttons are solid raised blocks (a light strip on top, a darker one at the bottom) that press down when clicked, the main one in the theme colour with light specks. The Friends panel is wider so the account switch fits
- The close button hides the launcher in the tray: friends' messages and downloads go on; click the icon to open it, right-click → "Quit" to exit. Can be turned off in Settings → "Launcher"
- Tooltips in the launcher's style instead of Windows' grey ones; a glint on the main buttons, hopping sidebar icons, a breathing Play button, springy dialogs
- A launcher that moves: cards lean towards the mouse in 3D with a soft light, the panorama drifts as you move the mouse, the Minecraft logo floats and rocks, icons hop and wiggle under the pointer, the X of the name glints, buttons give under a click
- Amethyx's own notifications: a soft card in the corner of the screen with the launcher's icon and text in its pixel font; appears at once and hides by itself
- Background: panoramas from 19 Minecraft versions (1.7.10 to 26.3), loaded quickly and applied at once
- The music is silent while the game runs and pauses when the window is not in focus; a sound of your choice for every action
- Nine languages: Russian, English, Ukrainian, Polish, German, French, Spanish, Portuguese and Chinese; on the first start the launcher asks which one, nine equal buttons in a 3 × 3 grid (closing the question keeps Windows' language)
- Top left: the version, a floating logo (leads Home) and the name; a "Full screen" button (F11); more light animations (can be turned off in settings)
- Ely.by sign-in on the Ely.by website; password sign-in stays as a fallback
- Fixed: after opening the Wardrobe several times the player on the home screen turned into a white box (the 3D views were not released)
- Fixed: NameMC sometimes reported an error before the skin came in (its Cloudflare check reloads the page); its 3D picture is no longer taken for a skin
- The Wardrobe has five places: your main skin (never written over) and four slots; a new skin goes into the slot you are looking at
- A start screen: the X, the name and a 3×3 plate of budding amethyst turning in the air, on which crystals grow like a snake, from the edge round into the middle, from a small bud to a cluster, then shrink back through the same stages and grow again (only the game's own textures; the plate appears, whole, only once they are loaded — no empty stand-in), sparkles blink, while everything is loaded at once (the game's textures, instances, accounts, fonts, news); the launcher opens ready
- "Loading" everywhere is the launcher's X; mods without a picture get one from CurseForge or Modrinth by their name (BadOptimizations, for example)
- Installing several mods sounds once at the start and once when all are done
- Home: "All instances" and "minecraft.net" readable over any panorama; a recent instance opens with a click (the one Home plays is chosen in the play bar)
- The tray icon's menu and the tray notice in the launcher's pixel-cut style: cut corners, an even frame, pixel icons, the version, in the pixel font and in the interface's language
- Panels and dialogs have an even frame all round instead of a light strip along the top edge, which showed as a white line over the panorama; no white square where two scrollbars meet, and dialogs never scroll sideways
- Toasts no longer cover each other: only the newest shows, with a small grey "×N" in its corner; pointing at it spreads them into a list
- "Loading…" in the Library and Friends while the first answer is on its way; rows of the instance page come in, light up when ticked (a wave for "All"), and the selection bar slides in
- The home player strolls a few steps now and then and points at your mouse; the skin no longer flickers where its layers overlap, and with arms up the head no longer turns into them
- The instance memory slider moves right away and turns "Own value" on by itself; the "Note block" card is gone from Settings
- Fixed: the long mod list lagged (rows off screen are no longer drawn, ticking no longer redraws the list, the panorama's mouse drift no longer restyles the page); the Minecraft logo's shadow is no longer cut at the top; recent instances fade out at the edge instead of being cut
- New installer pictures; the installer checks for 64-bit Windows 10 (1803+) or 11
- The installer is the launcher's own window in its soft look instead of Setup's pages: one rounded panel with the folder ("Изменить"), the desktop shortcut tick and "Установить" (soft plates with a shadow) over a Minecraft panorama that changes every time; while installing, a line with what is being done and the percentage over a round bar that moves in jerks, like a real download; and "Готово" with "Закрыть" and "Запустить" (the window's × closes too, without starting the launcher). Fixed: the welcome picture stayed behind the later pages, and the last page could not be closed with ×
- Export like Prism Launcher: a tree of the instance folder with ticks — a ticked folder goes in whole, open it to choose single files; sizes of files and folders. For .mrpack and CurseForge, chosen mods from those sites go in as links, the rest inside; the usual contents are ticked for each format. "Экспорт…" is also in the instance's right-click menu, in the list and on the instance's page
- Share codes can carry mods that are on neither Modrinth nor CurseForge: with the player's tick they go to the Amethyx server, and whoever pastes the code gets them too, every file checked (up to 64 MB a file). They stay while the code is used and go after a week nobody downloads them. Pasting such a code shows the author's mods with a tick to leave them out
- Instance settings save themselves as you change them, without a button, a sound or a "Сохранено" popup; the Java list names the Java only and its path is plain text under it to select or copy; lists look like the pixel fields; no resize corner in text fields; the slider's handle is a square block, not an oval. Fixed: the Spanish interface was empty in 1.7-beta.60
- Fixed: the tray icon's right-click menu did not open (if the launcher's own menu ever cannot appear, Windows' plain one with "Выйти" opens instead); the grey squares by the play bar's status and in Settings → Updates are the Amethyx X again
- Shader optimization ("Шейдеры" → "Оптимизация", also in the mods' "Оптимизация"): shaders switched on in one window — Iris or Oculus installed when missing, the shader picked automatically (the heaviest this computer carries at "Скорость" / "Баланс" / "Красота", one that works with Distant Horizons when it is in the pack) or chosen by hand among known packs marked light / medium / heavy; the level also sets the shadow distance
- Mods, resource packs and shaders: three looks (detailed, compact, tiles like CurseForge) and order (A–Z, Z–A, newest, enabled first, largest first), remembered
- Instances: right-click an empty spot for "Новая группа…", "Новая сборка…" and imports; "Новая группа" can put instances in at once
- The instance's "Версия" tab picks the version from the same searchable list as "Новая сборка" and the loader from cards
- "Серверы" opens on the server list; "Свой сервер" and "Для хостинга" come after it
- Own server → "Settings": all of server.properties in five parts — General (description, players, port, licence only, white list, PvP), Game (mode, difficulty, hardcore, flight, Nether, mobs, spawn protection, command blocks), World (the worlds on the server, a world moved over from the instance, a new one with a seed and type, view and simulation distance), Players (white list, operators, banned — by command while the server runs, written with the right UUIDs while it is stopped), More (memory, Java arguments, the server icon from the instance, resource pack, chat signatures, watchdog and every other key). Everything saves itself; a running server takes it on the next start ("Restart")
- Mods on neither Modrinth nor CurseForge (your own, a friend's): before a server gets its mods the launcher asks whether each one goes on the server or stays with the players, and remembers. Until answered such a mod stays off the server, so a client-only mod can no longer stop it from starting; "Для хостинга" marks them too
- Ticks make a sound like switches; "Оптимизация" comes in with a short animation; animations pause while the window is hidden or minimised
- Updates are checked every 10 minutes; macOS updates itself too (downloads the zip, checks it, swaps Amethyx.app and opens it again)
- Mac: runs on macOS 12 Monterey too (the Mac build is on Electron 43, the last for macOS 12; 44 needs macOS 13)
- Mac: the app is signed ad hoc, so it opens without Terminal — the first time macOS refuses it, then System Settings → Privacy & Security → "Open Anyway"
- Friends' chat: "Поделиться сборкой" sends any instance in one click. Invites always carry the instance; "Собрать и играть" / "Собрать и зайти" builds it right in the chat without questions and starts the game, and once built the button just says "Играть". Sharing the same instance again gives the same code, so a friend does not get copies
- Hand-drawn pixel icons (10 × 10, shown at whole sizes so every pixel stays square) instead of the smooth outline ones — the instance settings gear among them; pixel ticks everywhere instead of Windows' checkboxes; no rounded corners left anywhere; a slider like the game's
- Fixed: "nullnull" under the update status in Settings → Updates
- Buttons in the Amethyx style "Резонанс" (picked on the style page): a dark plate with a glowing line in the theme colour; a pixel shine runs across it under the pointer, a press visibly pushes the button in, letting go springs it back. Pixel sparks fly from a pressed button (Settings → "Оформление" → "Искры при нажатии"), drawn on one canvas so they never stutter
- The start screen simply says "Loading…" under the amethyst plate, instead of naming every step
- The frame of every pixel-cut button, panel, card and field now goes round the cut corners too (it used to stop at each step); "Shaders for this computer" in "Optimization" and packs without a picture show the Amethyx X
- Fixed: the panorama sometimes stayed black after a start (for example the first one after an update): when the background was drawn twice in a row, the two copies removed each other
- Interface pass: small square buttons (×, ⋯, list views) and ticks have the frame along the cut corners too; the current page in the sidebar and the current section in Settings are pixel plates with a line in the theme colour instead of a plain rectangle; switches are a sunk slot with a raised pixel knob; mod rows, mod icons, loader buttons and menu items are pixel-cut
- An instance's "Version": "Apply" is on top of the card, with what the instance is now and what it will become — nothing changes until it is pressed
- Mods list: "Check for updates" sits in the top row and answers right there; the bar over ticked mods slides open and shut instead of jumping, and "Clear selection" has its frame; a mod's switch changes only its own row (the list no longer redraws); configs and list export moved to the "⋯" menu
- Settings → Updates: "Checking…" shows right next to the button pressed
- The soft look finished on every screen: the catalog, Java, friends, the wardrobe, the journal, files, accounts, Settings; deeper relief; chosen things sit pressed in everywhere; each icon has its own motion under the pointer ("Play" dashes off and comes back running, download drops into the tray, the folder opens, the wardrobe figure turns round); theme colours never show a grass block in place of their block
- Smoother motion: the shine crosses every button, quiet ones and small square ones too; in the catalog a plate slides between Modrinth and CurseForge, the cards shown dim while the new ones load, then come in one after another as the list glides to its new height; wide instance cards in the list lean only slightly and no longer shake or slide out of the window
- Icons on buttons and in lists are real 3D models made in Blender now: glossy plastic, metal and glass (the magnifier's lens is see-through), with depth, light and highlights — the same icons and colours. They face you straight, and their move under the pointer always plays to the end: the gear turns full round and no longer jumps back
- Switching never jumps: tiles ↔ list for instances and mods, the order, filters and search — the cards glide to their new places; tabs and modes in dialogs (accounts, "New instance", a mod's page, server settings, "Share", shaders, inviting a friend, Java) — the dialog smoothly changes size; the look, colour and font — a soft crossfade
- Mods, resource packs and shaders: three or four in a line in the compact look; the tiles are redone: the picture fills the tile, "Client" or "Server" and the name are on a dark strip at the bottom, the switch is in the corner and "⋯ ×" in the middle between it and the round tick, which shows under the pointer. The bar over the list stays on one line. Chosen mods now show. A click on a mod chooses it, like in Prism Launcher (Shift+click chooses a run)
- Notifications no longer pile up in big cards: a small book in the corner hops and counts what is new, and a click opens the list in sections — mod downloads, instances, errors, the rest; each section is a stack that opens to show everything with how long ago it was. Only an error or a notice with a button still shows as a card
- Shadows of cards and buttons no longer end in a hard line: instances, the "Recent instances" and "News" rows on Home, the friends panel, the wardrobe and dialogs
- A new, calmer look (picked on the style page): soft raised buttons with round corners on lighter panels — a pressed one sinks in, a soft shine crosses it under the pointer; cards, fields, switches and menus match. Icons on buttons and in lists are in colour, like items in the inventory, and hop with a tilt under the pointer, like the instance icons; "Гардероб" on Home is a full button with its icon; the sidebar keeps its Minecraft pictures. In this look nothing is pixelated: the icons are smooth (the same colours), and lists, ticks, sliders, scrollbars and menus are round. Settings → "Оформление" → "Шрифт" offers eleven fonts, each shown in its own letters: Pixel, Inter, Golos, Onest, Manrope, Nunito, Rubik, Montserrat, Comfortaa, Exo 2, Unbounded. Settings → "Оформление" → "Кнопки" and "Иконки" bring back the pixel buttons and single-colour icons

### Fixes
- A long mod list (150 mods) no longer stutters while scrolling or switching looks
- "Smart helper" clicked twice when opened
- In the soft look the theme colour changed only the lettering: it now recolours the whole launcher — panels, the sidebar, buttons, fields, sliders and text (Gold golden, Diamond teal, Redstone red); the logo and the Minecraft pictures keep their own colours
- "Новая сборка": the Modrinth and CurseForge tabs had another Modrinth / CurseForge switch under them; it is gone. A new "По коду" tab builds an instance from a "Поделиться" code right there
- For those who had RichLauncher or Vanilla+ Launcher before, the installer offered their old folder (Documents\RichLauncher): the launcher now goes next to it, into a folder called Amethyx, and the old copy of the program is removed (games, packs and settings are not kept there)
- "Check for updates" no longer offers an older version as an update (a beta newer than the latest release, like JEI 19.70 → 19.64)
- "Find mods" in an instance opens the Library for that instance, and "Installed" shows only what is in it (it showed the mods of the instance chosen before); a new instance becomes the chosen one
- Instances imported from Prism with the Java flag `-Xlog:...file=logs/gc.log` did not start ("Could not create the Java Virtual Machine")
- Switching the loader from Vanilla to Fabric did nothing; affected instances repair themselves
- Settings sometimes were not saved (EPERM) while an antivirus held the file
- Big instances opened slowly and froze the launcher: every mod jar was read whole to learn its name and icon (a 159-mod pack: 15.7 s with the window stuck). Now only the few small files needed are read, in the background, and remembered on disk: 0.25 s the first time, 0.1 s after a restart. Adding a mod checks compatibility faster too
- Before mod updates and version changes every world was copied again, even ones not played for weeks (a 14-world pack: about 1.1 GB each time). Now only worlds played since their last copy are copied
- In other languages the start screen's steps ("3D models…") and the dates of Minecraft news stayed in Russian
- Friends: a stray "null" under your name when your account has no code
- In a narrow window the account and window buttons slid to the left of the top bar
- While Ely.by is down the launcher no longer tells you to remove the account: it says Ely.by is not responding, and the saved sign-in stays

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
