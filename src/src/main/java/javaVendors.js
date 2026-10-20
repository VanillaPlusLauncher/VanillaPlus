'use strict';

const { fetchJson } = require('../core/http');
const { PLATFORM, IS_MAC, mojangPlatformKey } = require('./javaPlatform');

/*
 * Where each Java distribution comes from (Windows x64, or macOS on Apple Silicon / Intel). Every
 * vendor but Mojang gives one archive with the JDK (zip on Windows, tar.gz on macOS); Mojang
 * publishes its runtimes (the ones the official launcher uses) as a list of files, see
 * javaInstaller.js.
 */

const MOJANG_RUNTIMES_URL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const { os, arch, archive, label } = PLATFORM;

const VENDORS = {
  mojang: {
    label: 'Mojang',
    description: 'Официальная Java из лаунчера Minecraft',
    majors: [8, 16, 17, 21, 25],
  },
  temurin: {
    label: 'Eclipse Temurin',
    description: 'Adoptium — самая популярная открытая сборка',
    majors: [8, 11, 16, 17, 21, 25],
    zipUrl: async (major) => `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse?project=jdk`,
  },
  zulu: {
    label: 'Azul Zulu',
    description: 'Сборка Azul, есть даже старые версии',
    majors: [8, 11, 13, 15, 16, 17, 21, 25],
    zipUrl: async (major) => {
      const packages = await fetchJson(
        `https://api.azul.com/metadata/v1/zulu/packages/?java_version=${major}&os=${IS_MAC ? 'macos' : 'windows'}&arch=${arch}&archive_type=${archive}&java_package_type=jdk&javafx_bundled=false&crac_supported=false&latest=true&release_status=ga&availability_types=CA&page_size=1`,
      );
      if (!packages[0]?.download_url) {
        throw new Error(`У Azul нет Java ${major} для ${label}.`);
      }
      return packages[0].download_url;
    },
  },
  corretto: {
    label: 'Amazon Corretto',
    description: 'Сборка Amazon с долгой поддержкой',
    majors: [8, 11, 17, 21, 25],
    zipUrl: async (major) => `https://corretto.aws/downloads/latest/amazon-corretto-${major}-${arch}-${IS_MAC ? 'macos' : 'windows'}-jdk.${archive}`,
  },
  microsoft: {
    label: 'Microsoft',
    description: 'Сборка Microsoft Build of OpenJDK',
    majors: [11, 17, 21, 25],
    zipUrl: async (major) => `https://aka.ms/download-jdk/microsoft-jdk-${major}-${IS_MAC ? 'macos' : 'windows'}-${arch}.${archive}`,
  },
  liberica: {
    label: 'BellSoft Liberica',
    description: 'Сборка BellSoft',
    majors: [8, 11, 17, 21, 25],
    zipUrl: async (major) => {
      const releases = await fetchJson(
        `https://api.bell-sw.com/v1/liberica/releases?version-feature=${major}&os=${IS_MAC ? 'macos' : 'windows'}&arch=${arch === 'aarch64' ? 'arm' : 'x86'}&bitness=64&package-type=${archive}&bundle-type=jdk&version-modifier=latest&fields=downloadUrl`,
      );
      const release = releases.find((candidate) => candidate.downloadUrl?.endsWith(`.${archive}`));
      if (!release) {
        throw new Error(`У BellSoft нет Java ${major} для ${label}.`);
      }
      return release.downloadUrl;
    },
  },
  oracle: {
    label: 'Oracle',
    description: 'Oracle JDK (бесплатно по лицензии NFTC)',
    majors: [21, 25],
    zipUrl: async (major) => `https://download.oracle.com/java/${major}/latest/jdk-${major}_${IS_MAC ? 'macos' : 'windows'}-${arch}_bin.${archive}`,
  },
};

/** Mojang's runtime component for a Java major version on this system: { name, manifestUrl, version }. */
async function mojangComponent(major) {
  const all = await fetchJson(MOJANG_RUNTIMES_URL);
  const components = all[mojangPlatformKey()] ?? {};
  const preferred = ['java-runtime-epsilon', 'java-runtime-delta', 'java-runtime-gamma', 'java-runtime-beta', 'java-runtime-alpha', 'jre-legacy'];
  for (const name of preferred) {
    const entry = components[name]?.[0];
    if (!entry) {
      continue;
    }
    const versionName = entry.version?.name ?? '';
    const entryMajor = versionName.startsWith('8u') || versionName.startsWith('1.8') ? 8 : Number.parseInt(versionName, 10);
    if (entryMajor === major) {
      return { name, manifestUrl: entry.manifest.url, version: versionName };
    }
  }
  throw new Error(`У Mojang нет Java ${major} для ${label}.`);
}

function listVendors() {
  return Object.entries(VENDORS).map(([id, vendor]) => ({ id, label: vendor.label, description: vendor.description, majors: vendor.majors }));
}

module.exports = { VENDORS, listVendors, mojangComponent };
