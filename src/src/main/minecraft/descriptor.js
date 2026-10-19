'use strict';

const MAX_INHERITANCE_DEPTH = 5;

/**
 * Merges a child version descriptor onto its parent (the `inheritsFrom` mechanism
 * used by mod loaders). Child values win; libraries and arguments are concatenated.
 */
function mergeDescriptors(parent, child) {
  const merged = { ...parent, ...child };
  delete merged.inheritsFrom;

  merged.libraries = [...(parent.libraries ?? []), ...(child.libraries ?? [])];

  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
    };
  }
  return merged;
}

/**
 * Resolves the inheritance chain of a descriptor.
 * `loadDescriptor(id)` must return the raw descriptor for an installed version.
 * Returns the merged descriptor plus `clientJarId`, the version folder that holds the jar.
 */
async function resolveDescriptor(versionId, loadDescriptor, depth = 0) {
  if (depth > MAX_INHERITANCE_DEPTH) {
    throw new Error(`Слишком глубокая цепочка наследования версии ${versionId}.`);
  }
  const raw = await loadDescriptor(versionId);
  if (!raw.inheritsFrom) {
    // baseId: the vanilla version at the root of the chain, which owns the natives folder.
    return { ...raw, clientJarId: raw.jar ?? raw.id, baseId: raw.id ?? versionId };
  }
  const parent = await resolveDescriptor(raw.inheritsFrom, loadDescriptor, depth + 1);
  const merged = mergeDescriptors(parent, raw);
  return { ...merged, clientJarId: raw.jar ?? parent.clientJarId, baseId: parent.baseId };
}

module.exports = { mergeDescriptors, resolveDescriptor };
