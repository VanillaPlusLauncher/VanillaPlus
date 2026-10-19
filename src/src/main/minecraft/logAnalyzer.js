'use strict';

/*
 * Reads a game log or crash report and explains the problems it recognises in plain Russian:
 * what went wrong and what to do. Each rule looks for a well-known message from Java, Minecraft,
 * Fabric/Quilt or Forge/NeoForge. Rules never guess: an unknown crash gives no problems, and the
 * UI then just shows the log.
 *
 * A problem: { id, title, detail, fix, action } where action (optional) names a place in the
 * launcher that fixes it: 'java', 'memory', 'mods', 'version', 'jvm-args'.
 */

/** Fabric's version wording in Russian ("version 0.5.0 or later" → "0.5.0 или новее"). */
function versionText(text) {
  return text.replace(/^version /, '').replace(/^any version$/, 'любая версия').replace(/ or later$/, ' или новее').replace(/ or earlier$/, ' или старее');
}

/** Class file version → Java release (Java 8 = 52, every release adds one). */
function javaForClassVersion(classVersion) {
  return Math.round(Number(classVersion)) - 44;
}

const unique = (values) => [...new Set(values.filter(Boolean))];

/** Rules return null (no match) or one problem; `all` collects every match of a pattern. */
const RULES = [
  (text) => {
    const match = /compiled by a more recent version of the Java Runtime \(class file version ([\d.]+)\), this version of the Java Runtime only recognizes class file versions up to ([\d.]+)/.exec(text)
      ?? /UnsupportedClassVersionError:.*?class file version ([\d.]+)/.exec(text);
    if (!match) return null;
    const needed = javaForClassVersion(match[1]);
    const current = match[2] ? javaForClassVersion(match[2]) : null;
    return {
      id: 'java-too-old',
      title: `Нужна Java ${needed} или новее`,
      detail: current ? `Игра или мод собраны под Java ${needed}, а запущена Java ${current}.` : `Игра или мод собраны под Java ${needed}.`,
      fix: 'Включите автоматический выбор Java для сборки (вкладка «Java») или выберите Java нужной версии.',
      action: 'java',
    };
  },
  (text) => {
    if (!/java\.lang\.OutOfMemoryError|Out of memory|There is insufficient memory for the Java Runtime/i.test(text)) return null;
    return {
      id: 'out-of-memory',
      title: 'Игре не хватило памяти',
      detail: 'Java упёрлась в выделенную оперативную память.',
      fix: 'Выделите сборке больше памяти (вкладка «Java»). Для модпаков обычно нужно 6–8 ГБ.',
      action: 'memory',
    };
  },
  (text) => {
    if (!/Could not reserve enough space for (?:object heap|\d+KB object heap)/i.test(text)) return null;
    return {
      id: 'heap-reserve',
      title: 'Java не смогла выделить столько памяти',
      detail: 'Указано больше памяти, чем доступно, или запущена 32-битная Java.',
      fix: 'Уменьшите память для сборки или используйте 64-битную Java.',
      action: 'memory',
    };
  },
  (text) => {
    const match = /Unrecognized VM option '([^']+)'|Unrecognized option: (\S+)|Invalid maximum heap size: (\S+)/.exec(text);
    if (!match) return null;
    const option = match[1] ?? match[2] ?? match[3];
    return {
      id: 'bad-jvm-arg',
      title: 'Java не понимает аргумент запуска',
      detail: `Неизвестный или неверный аргумент: ${option}`,
      fix: 'Уберите этот аргумент в «Аргументах JVM» сборки или в общих настройках.',
      action: 'jvm-args',
    };
  },
  // Fabric / Quilt: "Mod 'Sodium Extra' (sodium-extra) 0.5 requires version 0.5.0 or later of mod 'Sodium' (sodium), which is missing!"
  (text) => {
    const lines = [...text.matchAll(/Mod '([^']+)' \(([^)]+)\)[^\n]*? requires ([^\n]*?) of (?:mod )?'?([^'\n(]+?)'? \(([^)]+)\), which is missing!/g)];
    if (lines.length === 0) return null;
    const items = unique(lines.map((line) => `«${line[1]}» требует «${line[4].trim()}» (${versionText(line[3])})`));
    return {
      id: 'missing-dependency',
      title: items.length === 1 ? 'Не хватает мода-зависимости' : `Не хватает модов-зависимостей: ${items.length}`,
      detail: items.join('\n'),
      fix: 'Установите недостающие моды на вкладке «Моды» (поиск по названию) или удалите мод, которому они нужны.',
      action: 'mods',
    };
  },
  // Fabric: "Mod 'X' (x) 1.0 is incompatible with any version of mod 'Y' (y), but a matching version is present: 2.0!"
  (text) => {
    const lines = [...text.matchAll(/Mod '([^']+)' \([^)]+\)[^\n]*? is incompatible with [^\n]*?mod '([^']+)'/g)];
    if (lines.length === 0) return null;
    return {
      id: 'incompatible-mods',
      title: 'Моды несовместимы друг с другом',
      detail: unique(lines.map((line) => `«${line[1]}» не работает вместе с «${line[2]}»`)).join('\n'),
      fix: 'Отключите один из модов каждой пары на вкладке «Моды».',
      action: 'mods',
    };
  },
  // Fabric: a mod built for another Minecraft: "requires version 1.21.4 of minecraft" is covered by the missing rule
  // only when minecraft is absent; otherwise Fabric says "requires ... of mod 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!"
  (text) => {
    const lines = [...text.matchAll(/Mod '([^']+)' \([^)]+\)[^\n]*? requires ([^\n]*?) of (?:mod )?'([^']+)' \(([^)]+)\), but only the wrong version is present: ([^!\n]+)!/g)];
    if (lines.length === 0) return null;
    return {
      id: 'wrong-dependency-version',
      title: 'Не та версия зависимости',
      detail: unique(lines.map((line) => `«${line[1]}» требует «${line[3]}» ${versionText(line[2])}, а установлена ${line[5]}`)).join('\n'),
      fix: 'Обновите моды на вкладке «Моды» или поставьте моды под версию игры этой сборки.',
      action: 'mods',
    };
  },
  // Forge / NeoForge: "Mod ID: 'geckolib', Requested by: 'mowziesmobs', Expected range: '[4.4,)', Actual version: '[MISSING]'"
  (text) => {
    const lines = [...text.matchAll(/Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']+)'/g)];
    if (lines.length === 0) return null;
    const missing = lines.filter((line) => line[4] === '[MISSING]');
    return {
      id: 'forge-dependency',
      title: missing.length > 0 ? 'Не хватает мода-зависимости' : 'Не та версия зависимости',
      detail: unique(lines.map((line) => (line[4] === '[MISSING]' ? `«${line[2]}» требует «${line[1]}» (${line[3]})` : `«${line[2]}» требует «${line[1]}» ${line[3]}, а установлена ${line[4]}`))).join('\n'),
      fix: 'Установите или обновите нужные моды на вкладке «Моды».',
      action: 'mods',
    };
  },
  (text) => {
    const fabric = [...text.matchAll(/Duplicate mod ID '?([\w.-]+)'?|Found duplicate mods?:?\s*\n?\s*Mod ID: '?([\w.-]+)'?|duplicate mods? ([\w.-]+)/gi)];
    if (fabric.length === 0) return null;
    return {
      id: 'duplicate-mods',
      title: 'Один и тот же мод установлен дважды',
      detail: `Повторяется: ${unique(fabric.map((match) => match[1] ?? match[2] ?? match[3])).join(', ')}`,
      fix: 'Оставьте один файл этого мода на вкладке «Моды», остальные удалите.',
      action: 'mods',
    };
  },
  (text) => {
    if (!/(?:is a|Found a) Fabric mod|fabric\.mod\.json[^\n]*(?:Forge|NeoForge)|This is a Forge mod|mods\.toml[^\n]*Fabric/i.test(text)) return null;
    return {
      id: 'wrong-loader',
      title: 'Мод для другого загрузчика',
      detail: 'В сборке есть мод, сделанный для другого загрузчика (Fabric и Forge несовместимы).',
      fix: 'Удалите такой мод или найдите его версию для загрузчика этой сборки.',
      action: 'mods',
    };
  },
  (text) => {
    const mods = unique([
      ...[...text.matchAll(/Mixin apply (?:for mod|failed) ([\w.-]+)/g)].map((match) => match[1]),
      ...[...text.matchAll(/from mod ([\w.-]+)\] from phase/g)].map((match) => match[1]),
      ...[...text.matchAll(/[\w.]+\.mixins?\.json:[\w.$]+ from mod ([\w.-]+)/g)].map((match) => match[1]),
    ]);
    if (mods.length === 0 && !/MixinApplyError|MixinTransformerError|InvalidMixinException/.test(text)) return null;
    return {
      id: 'mixin',
      title: 'Мод сломался при загрузке (Mixin)',
      detail: mods.length > 0 ? `Виноват, скорее всего: ${mods.join(', ')}` : 'Один из модов не смог встроиться в игру.',
      fix: 'Обновите этот мод или временно отключите его. Часто так конфликтуют два мода, меняющие одно и то же.',
      action: 'mods',
    };
  },
  // Forge crash reports: "Suspected Mod: Mod Name (modid), Version: 1.0" / "Suspected Mods: X"
  (text) => {
    const suspected = unique([
      ...[...text.matchAll(/Suspected Mods?:\s*([^\n]+)/g)].map((match) => match[1].trim()),
      ...[...text.matchAll(/Suspected Mod:\s*\n\s*([^\n]+)/g)].map((match) => match[1].trim()),
    ]).filter((value) => !/^None$|^Unknown$/i.test(value));
    if (suspected.length === 0) return null;
    return {
      id: 'suspected-mod',
      title: 'Игра подозревает мод',
      detail: suspected.join('\n'),
      fix: 'Попробуйте обновить или отключить этот мод.',
      action: 'mods',
    };
  },
  (text) => {
    const match = /(?:NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException):? ['"]?([\w/.$]+)/.exec(text);
    if (!match || /net\.minecraft\.launchwrapper|cpw\.mods\.bootstraplauncher/.test(match[1])) return null;
    const owner = match[1].replace(/\//g, '.').split('.').slice(0, 3).join('.');
    return {
      id: 'linkage',
      title: 'Мод не подходит к версии игры или другого мода',
      detail: `Не найден код: ${match[1].replace(/\//g, '.')} (${owner}…)`,
      fix: 'Обычно это мод под другую версию Minecraft или старая зависимость. Обновите моды или проверьте их версии.',
      action: 'mods',
    };
  },
  (text) => {
    if (!/Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL|OpenGL 3\.2 is not supported|No OpenGL context|Couldn't set pixel format/i.test(text)) return null;
    return {
      id: 'opengl',
      title: 'Проблема с видеодрайвером',
      detail: 'Видеокарта или драйвер не дают нужную версию OpenGL.',
      fix: 'Обновите драйвер видеокарты с сайта NVIDIA, AMD или Intel. На ноутбуках запускайте игру на дискретной видеокарте.',
    };
  },
  (text) => {
    const match = /EXCEPTION_ACCESS_VIOLATION[\s\S]{0,600}?Problematic frame:\s*\n#\s*C\s+\[([^+\]\s]+)/.exec(text);
    if (!match) return null;
    const driver = /^(nvoglv|atio6|ig\d+icd|ig[\w]*icd)/i.test(match[1]);
    return {
      id: 'native-crash',
      title: driver ? 'Вылет в видеодрайвере' : 'Вылет в системной библиотеке',
      detail: `Java упала в ${match[1]}.`,
      fix: driver ? 'Обновите драйвер видеокарты. Если не поможет — отключите шейдеры и моды на графику.' : 'Попробуйте другую Java (вкладка «Java») и отключите моды, которые меняют рендер.',
      action: driver ? null : 'java',
    };
  },
  (text) => {
    if (!/Could not find or load main class|Error: Unable to access jarfile|ZipException: zip END header not found|invalid LOC header|Failed to load native library|UnsatisfiedLinkError/.test(text)) return null;
    return {
      id: 'broken-install',
      title: 'Файлы игры повреждены',
      detail: 'Часть файлов игры или библиотек не читается.',
      fix: 'Почините файлы: вкладка «Версия» → «Починить файлы». Моды и миры останутся.',
      action: 'version',
    };
  },
  (text) => {
    if (!/Failed to verify username|Invalid session|Bad login|Not authenticated with Minecraft\.net/i.test(text)) return null;
    return {
      id: 'session',
      title: 'Сервер не принял вход',
      detail: 'Сессия аккаунта устарела или сервер требует лицензию.',
      fix: 'Перезайдите в аккаунт. На офлайн-аккаунте можно играть только на серверах без проверки лицензии.',
    };
  },
];

/** Line of a crash report that says what happened ("Description: Rendering screen"). */
function crashDescription(text) {
  const description = /^Description: (.+)$/m.exec(text)?.[1]?.trim();
  const exception = /^(?:java\.lang\.|net\.minecraft\.)?[\w.$]*(?:Exception|Error)(?::[^\n]*)?$/m.exec(text.split(/^Description: .+$/m)[1] ?? '')?.[0]?.trim();
  return description ? { description, exception: exception ?? null } : null;
}

/** Problems found in a log, in the order of the rules (most specific first), without duplicates. */
function analyzeLog(text) {
  const source = String(text ?? '');
  if (!source) {
    return { problems: [], crash: null };
  }
  const problems = [];
  for (const rule of RULES) {
    try {
      const problem = rule(source);
      if (problem && !problems.some((existing) => existing.id === problem.id)) {
        problems.push(problem);
      }
    } catch {
      // A broken rule must not hide the others.
    }
  }
  return { problems, crash: crashDescription(source) };
}

/** Explains a JVM exit code when nothing in the log did. */
function describeExitCode(code) {
  const known = {
    1: 'Игра завершилась с ошибкой.',
    '-1': 'Java завершилась аварийно.',
    '-805306369': 'Игра зависла и была закрыта системой.',
    '-1073740791': 'Вылет из-за повреждения памяти (часто мод или драйвер).',
    '-1073741819': 'Нарушение доступа к памяти (часто видеодрайвер).',
    '-1073741571': 'Переполнение стека (часто зацикленный мод).',
    137: 'Процесс игры был убит системой (не хватило памяти?).',
  };
  return known[String(code)] ?? null;
}

module.exports = { analyzeLog, describeExitCode };
