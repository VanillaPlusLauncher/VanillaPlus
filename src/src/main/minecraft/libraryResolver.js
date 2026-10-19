'use strict';

const { isAllowed, CURRENT_OS_NAME } = require('./rules');

const DEFAULT_LIBRARY_BASE_URL = 'https://libraries.minecraft.net/';

/** Converts "group:artifact:version[:classifier][@ext]" into a Maven repository path. */
function mavenRelativePath(name) {
  const [coordinates, extension = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coordinates.split(':');
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return [group.replace(/\./g, '/'), artifact, version, fileName].join('/');
}

/** Old Forge profiles point at Forge's former maven host over plain HTTP. */
function normalizeBaseUrl(url) {
  if (!url) {
    return DEFAULT_LIBRARY_BASE_URL;
  }
  const withSlash = url.endsWith('/') ? url : `${url}/`;
  return withSlash.replace(/^https?:\/\/files\.minecraftforge\.net\/maven\//, 'https://maven.minecraftforge.net/').replace(/^http:\/\//, 'https://');
}

function toDownload(relativePath, artifact, fallbackBaseUrl) {
  return {
    relativePath,
    url: artifact?.url || `${fallbackBaseUrl}${relativePath}`,
    sha1: artifact?.sha1,
    size: artifact?.size,
  };
}

/**
 * Splits a version's libraries into:
 * - classpath: jars that must be on the JVM class path;
 * - natives: native archives that must be extracted into the natives folder.
 * Entries are filtered by the current OS and the given feature flags.
 */
function resolveLibraries(descriptor, features = {}) {
  const classpath = new Map();
  const natives = [];

  for (const library of descriptor.libraries ?? []) {
    if (!isAllowed(library.rules, features)) {
      continue;
    }

    const downloads = library.downloads ?? {};
    const nativeClassifier = library.natives?.[CURRENT_OS_NAME];

    if (downloads.artifact) {
      const entry = toDownload(downloads.artifact.path, downloads.artifact, DEFAULT_LIBRARY_BASE_URL);
      classpath.set(entry.relativePath, entry);
    } else if (library.name && !nativeClassifier && library.clientreq !== false) {
      // Libraries from third-party loaders describe only a name and a base URL (Fabric adds sha1/size).
      const relativePath = mavenRelativePath(library.name);
      const entry = toDownload(relativePath, { sha1: library.sha1, size: library.size }, normalizeBaseUrl(library.url));
      classpath.set(relativePath, entry);
    }

    if (nativeClassifier) {
      const classifier = nativeClassifier.replace('${arch}', '64');
      const nativeArtifact = downloads.classifiers?.[classifier];
      if (nativeArtifact) {
        natives.push({
          ...toDownload(nativeArtifact.path, nativeArtifact, DEFAULT_LIBRARY_BASE_URL),
          exclude: library.extract?.exclude ?? [],
        });
      }
    }
  }

  return { classpath: [...classpath.values()], natives };
}

module.exports = { resolveLibraries, mavenRelativePath };
