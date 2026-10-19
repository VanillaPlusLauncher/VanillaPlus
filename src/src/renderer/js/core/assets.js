/** Absolute URL of a file under the project's assets folder (served by the app:// protocol). */
export function assetUrl(relativePath) {
  return new URL(`../../../../assets/${relativePath}`, import.meta.url).href;
}
