/**
 * Put text on the clipboard, on every origin the app is actually served from.
 *
 * `navigator.clipboard` is a secure-context API: it exists over https, on localhost, and
 * nowhere else. During bring-up the app is served over plain http on a LAN address
 * (`docs/vps-deploy.md`), and a phone on that origin has no `navigator.clipboard` at all.
 * The old call — `await navigator.clipboard.writeText(...)` inside a `try` — threw on the
 * property access, the `catch` treated it as a refused permission, and the button did
 * nothing at all: no copy, no error, no change in the label. Reported from a phone.
 *
 * `document.execCommand('copy')` is deprecated and still the only thing that works there.
 * It needs a selection, so the fallback parks a textarea off-screen, selects it, copies,
 * and puts the reader's own selection back — the prose is selectable and a copy must not
 * cost them the passage they had highlighted.
 *
 * Returns whether the text actually reached the clipboard, because the caller has to be
 * able to say so. A copy that silently fails is the bug this file exists to end.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied, or the document is not focused. Not necessarily the end: the legacy path
      // is allowed in the same contexts and is checked below.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  // Off-screen rather than hidden: `display: none` cannot be selected. `readonly` keeps a
  // soft keyboard from opening on the phone this exists for.
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  document.body.appendChild(area);
  area.select();
  // iOS ignores `select()` on a textarea unless the range is set explicitly.
  area.setSelectionRange(0, area.value.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  area.remove();
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}
