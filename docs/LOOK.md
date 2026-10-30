# The launcher's look — what it must stay

This is the look the owner chose (October 2026). Any change to the interface keeps everything below
unless the owner asks otherwise. Backups of this state: the git tags `look-soft-1`, `look-soft-2` (latest).

## The chosen look

| Part | How it is | Where |
|---|---|---|
| Buttons and panels | **Soft**: raised plates (shadow down-right, light up-left, a lit top edge) on lighter violet-grey panels; round corners; no frames or bevel lines | `css/soft.css`, `data-style="soft"` (default) |
| Chosen things | **Pressed in**: darker than the plates around, inner shadow, text in the theme colour; never shown by an outline. The same in tab bars and switches: the group is one raised plate, the chosen option is pressed into it | `soft.css` §5 |
| Motion | Choices fade over 220 ms; switches' plates slide; the catalog dims the old cards while loading and the new ones rise in as the list glides to its height; cards lean towards the pointer (wide ones only slightly) | `soft.css`, `features/alive.css`, `features/catalog.css`, `core/effects.js resizeSmoothly`, `components/alive.js` |
| Font | **Tiny5, the Minecraft pixel font** (default). Settings → Оформление → Шрифт offers 11 | `tokens.css` `data-font` |
| Icons on buttons and in lists | **Smooth and coloured**, the colours of items in the inventory | `css/icons.css`, `assets/ui/*.smooth.svg` |
| Sidebar | **Minecraft pictures** (items and blocks of the game) — never replaced by drawn icons | `layout/shell.js` |
| Theme colour tiles | **Minecraft blocks** (amethyst, honeycomb, cherry…); a colour gem only if the game file is missing | `settingsPage.js`, `core/mc.js mcPictureOr` |
| Hover on a button | Its own icon moves its own way (Играть dashes off and back, download drops, folder opens, gear turns, wardrobe figure turns, cross spins…); others hop with a tilt | `css/motion.css` |
| Shine | A soft band of light crosses a button under the pointer | `features/pixel.css` runs it, `soft.css` §4 paints it |
| Press | The button sinks in | `soft.css` §4 |

The pixel look (square, pixel-cut, Minecraft bevels) stays as a choice: Settings → Оформление →
Интерфейс → Кнопки: «Пиксельные». It is `features/` alone (`pixel.css` over the screens' files);
`soft.css` touches nothing outside `:root[data-style="soft"]`.

## Where the styles are (`src/src/renderer/css`, in loading order)

1. `tokens.css` — colours, fonts, radii, theme colours.
2. `base.css`, `layout.css`, `components.css`, `pages.css`, `mc.css` — the components.
3. `features.css` — only the list of the files in `features/`, in the order they load:

   | File | What is in it |
   |---|---|
   | `shell.css` | the window around the pages: first start, sidebar extras, context menu, tooltips, toasts, «Загрузка…», cursor, start screen, language picker, walk-through |
   | `controls.css` | links, ticks, small switches and chips, dropdowns, fields, path rows, segmented controls, dialog footers and tabs |
   | `home.css` | Главная: logo, recent and news rows, play bar with its instance switcher, the player and «Гардероб» |
   | `instances.css` | Сборки: groups, the three card styles, «Новая сборка», icon picker, moving from other launchers |
   | `instance.css` | an instance's page: tabs, mods / packs / shaders lists and their three looks, worlds, servers, screenshots, files, journal, its settings, optimisation, shaders, sharing and export |
   | `server.css` | «Мой сервер»: where it runs, its card, hosting export, its settings, unknown mods |
   | `catalog.css` | Библиотека and «Найти моды»: Modrinth / CurseForge switch, cards, project dialog |
   | `skins.css` | skins page, capes, wardrobe, effects around the 3D player |
   | `friends.css` | Друзья: list, conversation, invites, sharing an instance in the chat |
   | `settings.css` | Настройки: layout, fonts, Java, accounts, panoramas, sounds |
   | `alive.css` | motion shared by the screens: pages and cards coming in, presses, leaning cards, the logo |
   | `pixel.css` | the Minecraft look of the controls: square corners, pixel frames, plates that sink, ticks, switches |

   The order matters: where two files style the same thing, the later one wins.
4. `soft.css` — the soft look: 1 tokens · 2 shape · 3 panels and cards · 4 buttons · 5 chosen things ·
   6 rows, bars and fields · 7 controls · 8 small things.
5. `icons.css` — which picture an icon shows (pixel one-colour, pixel coloured, smooth).
6. `motion.css` — each icon's hover motion: one rule, a `--icon-motion` per icon, the keyframes.

Rules for new styles: a screen's rule goes into that screen's file in `features/`, next to the rules
of the same element (one rule per selector in a file: add to it rather than writing it again further
down); a soft-look rule goes into the matching section of `soft.css` and starts with
`:root[data-style="soft"]`; a new chosen state is added to the one list in §5, not given its own
colours; a new icon gets its picture in both generators and a line in `icons.css` and `motion.css`.

## Icons

- `installer/tools/make-pixel-icons.js` — pixel art from `src/assets/ui/pixel-icons.txt` →
  `<name>.svg` (one colour) and `<name>.color.svg` (coloured).
- `installer/tools/make-smooth-icons.js` → `<name>.smooth.svg`.
- Window buttons (—, ▢, ×) and arrows stay in the text colour.

## Checking a change

The test copy (`--user-data-dir` = a test profile with its own `gameDirectory`) and a tour script
take screenshots of every screen; look for square corners, hard frames, flat dark boxes, outlines
on chosen things, buttons without a plate, and icons that do not move their own way.
