chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'fiv-open-toolbar' });
});

// Runs in the background service worker specifically because fetches from
// here, with host_permissions for the target origin, bypass CORS — a content
// script's fetch() is still bound by the page's own CORS rules and silently
// fails on third-party image hosts that don't send CORS headers (which is
// most of them). We only need the bytes here; the actual clipboard write has
// to happen back in the content script, since service workers have no
// clipboard/DOM access.
async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Reading image bytes off arbitrary third-party hosts needs access to those
// hosts, which is a broad grant — so it is OPTIONAL rather than required at
// install. A default install only asks for google.com; the wide grant is
// requested from the options page, and only if the user wants one-click
// copying of the image itself. Downloads don't need it (chrome.downloads
// works cross-origin on the "downloads" permission alone), and copying the
// image URL as text doesn't either — so everything except image-bytes
// copying works without it.
const IMAGE_ORIGINS = { origins: ['https://*/*'] };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fiv-download' && message.url) {
    chrome.downloads.download({ url: message.url });
    return false;
  }
  if (message.type === 'fiv-image-permission') {
    chrome.permissions.contains(IMAGE_ORIGINS).then((granted) => sendResponse({ granted }));
    return true;
  }
  if (message.type === 'fiv-fetch-image' && message.url) {
    chrome.permissions
      .contains(IMAGE_ORIGINS)
      .then((granted) => {
        if (!granted) {
          // Not an error the caller should retry — it's a capability the
          // user hasn't granted, so say so explicitly and let the content
          // script fall back rather than silently failing.
          sendResponse({ ok: false, needsPermission: true });
          return;
        }
        return fetchImageAsDataUrl(message.url)
          .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
  return false;
});
