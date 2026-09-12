// chrome.permissions.request() is only callable from an extension page in
// response to a user gesture — it is not exposed to content scripts at all,
// which is why this page exists rather than the viewer asking inline.
const IMAGE_ORIGINS = { origins: ['https://*/*'] };

const statusEl = document.getElementById('status');
const grantBtn = document.getElementById('grant');
const revokeBtn = document.getElementById('revoke');

async function render() {
  const granted = await chrome.permissions.contains(IMAGE_ORIGINS);
  statusEl.textContent = granted
    ? 'Enabled — Copy puts the image itself on your clipboard.'
    : 'Off — Copy puts the image URL on your clipboard.';
  statusEl.classList.toggle('on', granted);
  grantBtn.hidden = granted;
  revokeBtn.hidden = !granted;
}

grantBtn.addEventListener('click', async () => {
  // Chrome shows its own consent prompt here; a denial just resolves false.
  const granted = await chrome.permissions.request(IMAGE_ORIGINS);
  if (!granted) statusEl.textContent = 'Permission declined — Copy will use the image URL.';
  render();
});

revokeBtn.addEventListener('click', async () => {
  await chrome.permissions.remove(IMAGE_ORIGINS);
  render();
});

render();
