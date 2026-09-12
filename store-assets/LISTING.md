# Chrome Web Store listing — Monocle

## Name
Monocle | Google Images Fullscreen Viewer

## Short description (132 char max)
Browse Google Images fullscreen, one large image at a time. Filmstrip navigation, shortlist, side-by-side compare. No host sites.

(128 characters)

## Category
Productivity

## Language
English (United States)

---

## Detailed description

Google Images shows you a wall of thumbnails. Monocle turns it into a viewer.

Click any result and it opens fullscreen at full resolution, with a filmstrip
along the bottom for moving through everything the search found. Arrow keys step
image to image; hold an arrow to move faster. You never land on a host site
unless you choose to.

WHAT IT DOES

• Fullscreen viewing — every image scaled to fit, never cropped, never stretched
• Filmstrip navigation — the active image stays centered as you move
• Shortlist — star the ones worth keeping, then filter the filmstrip to just those
• Compare — view four starred images at once in a 2×2 grid
• Resolution and source — always visible, and the domain is a link to the page
• Copy and download — one key each, straight from the viewer
• Zoom and pan — scroll to zoom, Cmd/Ctrl-scroll or Shift-scroll to pan

KEYBOARD

← →  previous / next (hold to accelerate)
Space  star the current image
S  show only starred
G  compare starred images
C  copy      D  download
F  hide the filmstrip
Esc  step back, then close

PRIVACY

Monocle has no accounts, no analytics, and no tracking. Nothing you view or
search is recorded or transmitted anywhere. It runs entirely in your browser.

Images are fetched directly from their source only at the moment you ask to copy
one — and that is optional. By default Copy places the image's URL on your
clipboard, which needs no special access. If you want Copy to place the image
itself on your clipboard, you can turn that on in the extension's settings; it
asks for access then, and you can turn it off again at any time.

---

## Single purpose (required field)

Monocle provides a fullscreen viewer for Google Images search results, letting
users browse results one large image at a time with keyboard navigation, a
shortlist, and side-by-side comparison, without visiting the sites hosting the
images.

---

## Permission justifications

**host permission — https://www.google.com/**
The viewer runs on Google Images search result pages. The extension needs to read
the results on that page to build the filmstrip, and to inject its viewer UI
there. This is the only site the extension runs on by default.

**optional host permission — https://\*/\* (not requested at install)**
Only used for the optional "copy the image itself to the clipboard" feature.
Image results are hosted on arbitrary third-party domains, so reading an image's
bytes requires access to whichever domain serves it — which cannot be narrowed in
advance. This is NOT requested at install. It is requested from the extension's
options page only if the user explicitly enables image copying, and can be
revoked there. Without it, Copy falls back to copying the image URL as text.

**downloads**
Powers the download action in the viewer, saving the currently displayed image.
Used only in response to the user pressing D or clicking the download button.

**activeTab**
Lets the toolbar button open the viewer on the Google Images tab the user is
currently looking at.

**scripting**
Used to inject the viewer's stylesheet and interface into the Google Images page.

**Remote code**: No. All code is contained in the extension package. Nothing is
loaded or executed from a remote source.

---

## Data usage disclosures

- Does the extension collect personally identifiable information? **No**
- Health information? **No**
- Financial and payment information? **No**
- Authentication information? **No**
- Personal communications? **No**
- Location? **No**
- Web history? **No**
- User activity? **No**
- Website content? **No** — page content is read in-memory to build the viewer
  and is never stored or transmitted.

Certifications:
- Does not sell or transfer user data to third parties ✔
- Does not use or transfer user data for purposes unrelated to the single purpose ✔
- Does not use or transfer user data to determine creditworthiness or for lending ✔

Privacy policy URL: required only if data were collected. None is collected.

---

## Screenshots (1280×800)
1. `01-main-viewer.png` — fullscreen viewer with filmstrip
2. `02-shortlist.png` — filmstrip filtered to starred images
3. `03-grid-compare.png` — 2×2 compare of starred images
