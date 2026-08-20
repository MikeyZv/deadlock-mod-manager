/**
 * Naming for downloads that arrive without a name of their own.
 *
 * A 1-click install hands the app a bare URL whose path carries only an opaque
 * download id, so the creator's own file name has to be recovered from elsewhere —
 * the published file list where possible, the response headers otherwise. These
 * helpers live apart from the deep-link hook so they can be tested without loading
 * the Tauri runtime.
 */

/** Matches the numeric download id in a GameBanana `/mmdl/<id>` URL. */
export const GAMEBANANA_MMDL_REGEX = /\/mmdl\/(\d+)/;

const CONTENT_DISPOSITION_ENCODED = /filename\*=(?:UTF-8'')?([^;]+)/i;
const CONTENT_DISPOSITION_PLAIN = /filename="?([^";]+)"?/i;

/** Whether a published file and a 1-click URL point at the same download. */
export const isSameDownload = (
  candidateUrl: string,
  clickedUrl: string,
): boolean => {
  if (candidateUrl === clickedUrl) {
    return true;
  }
  const candidateId = candidateUrl.match(GAMEBANANA_MMDL_REGEX)?.[1];
  const clickedId = clickedUrl.match(GAMEBANANA_MMDL_REGEX)?.[1];
  return candidateId !== undefined && candidateId === clickedId;
};

/**
 * The file name a URL ends in, or null when it names no file.
 *
 * A GameBanana 1-click link (`/mmdl/<id>`) redirects to the creator's uploaded file
 * and sends no `Content-Disposition`, so the URL landed on after redirects is the
 * only place the real name appears. A path segment with no extension is treated as
 * a route rather than a name, which is what keeps `/mmdl/1513401` from being read
 * as a file called `1513401`.
 */
export const fileNameFromUrl = (url: string): string | null => {
  if (!url) {
    return null;
  }

  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an absolute URL; drop any query and fragment by hand.
    path = url.split(/[?#]/)[0] ?? "";
  }

  let base = path.split("/").pop() ?? "";
  try {
    base = decodeURIComponent(base);
  } catch {
    // A malformed escape is not worth discarding an otherwise usable name over.
  }

  base = base.trim();
  return base.length > 0 && base.includes(".") ? base : null;
};

/**
 * The creator's own file name as the server reports it, or null when it reports
 * none. Prefers the RFC 5987 `filename*` form when both are present.
 */
export const parseContentDisposition = (
  header: string | null,
): string | null => {
  if (!header) {
    return null;
  }

  const raw =
    header.match(CONTENT_DISPOSITION_ENCODED)?.[1] ??
    header.match(CONTENT_DISPOSITION_PLAIN)?.[1];
  if (!raw) {
    return null;
  }

  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed escape is not worth discarding an otherwise usable name over.
  }

  // A served name is remote input, so keep only the base name; it ends up used as a
  // file name and must never carry a path.
  const base = decoded.split(/[\\/]/).pop()?.trim() ?? "";
  return base.length > 0 ? base : null;
};
