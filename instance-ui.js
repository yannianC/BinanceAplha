// Use the installed manifest so existing copies retain their own name and ID.
const instanceManifest = chrome.runtime.getManifest();
document.title = instanceManifest.name + (document.querySelector('title').dataset.suffix || '');
document.querySelectorAll('[data-extension-name]').forEach(element => {
  element.textContent = instanceManifest.name;
});
document.querySelectorAll('[data-extension-version]').forEach(element => {
  element.textContent = instanceManifest.version;
});
