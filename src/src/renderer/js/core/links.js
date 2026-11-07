import { openWebPage } from '../components/webPage.js';

/*
 * Links open inside the launcher: a Modrinth project as its own page in the launcher (when the caller
 * can show one), anything else on the web in the launcher's browser dialog (components/webPage.js).
 */

const MODRINTH_KINDS = new Set(['mod', 'plugin', 'datapack', 'shader', 'resourcepack', 'modpack', 'project']);

/** The real address behind CurseForge's "linkout" redirect (often encoded twice). */
export function unwrapLink(url) {
  try {
    const parsed = new URL(url);
    if (/(^|\.)curseforge\.com$/i.test(parsed.hostname) && parsed.pathname.replace(/\/+$/, '') === '/linkout') {
      let target = parsed.searchParams.get('remoteUrl') ?? '';
      for (let step = 0; step < 3 && /^https?%3A/i.test(target); step += 1) target = decodeURIComponent(target);
      if (/^https?:\/\//i.test(target)) return target;
    }
  } catch {
    // Not a URL: as it is.
  }
  return url;
}

/** A Modrinth project's page: { slug, section } ("gallery", "versions"…), or null. */
export function modrinthProject(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (!/^(www\.)?modrinth\.com$/i.test(hostname)) return null;
    const [kind, slug, section] = pathname.split('/').filter(Boolean);
    if (!MODRINTH_KINDS.has(kind) || !slug) return null;
    return { slug: decodeURIComponent(slug), section: section ?? null };
  } catch {
    return null;
  }
}

/**
 * Opens `url` inside the launcher. `onProject({ slug, section }, url)`: shows a Modrinth project as a
 * launcher page; without it the project's site opens in the browser dialog like any other page.
 */
export function openLink(url, { onProject = null, title = null } = {}) {
  const real = unwrapLink(String(url ?? ''));
  const project = onProject ? modrinthProject(real) : null;
  if (project) {
    onProject(project, real);
    return;
  }
  openWebPage(real, { title });
}
