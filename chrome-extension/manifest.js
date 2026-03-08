import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));
// Ensure manifest `version` is numeric-only (major.minor.patch).
// package.json may contain build metadata or labels (e.g. 1.0.1-optimized-n8n).
// Extract the leading semver numeric part for the manifest.
const manifestVersionMatch = String(packageJson.version || '').match(/^(\d+\.\d+\.\d+)/);
const manifestVersion = manifestVersionMatch ? manifestVersionMatch[0] : '1.0.0';

/**
 * After changing, please reload the extension at `chrome://extensions`
 * @type {chrome.runtime.ManifestV3}
 */
const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  /**
   * if you want to support multiple languages, you can use the following reference
   * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization
   */
  name: '__MSG_extensionName__',
  version: manifestVersion,
  description: '__MSG_extensionDescription__',
  host_permissions: ['<all_urls>'],
  permissions: ['scripting', 'tabs', 'activeTab', 'debugger', 'nativeMessaging'],
  background: {
    service_worker: 'background.iife.js',
    type: 'module',
  },
  action: {
    default_icon: 'icon-32.png',
    default_popup: 'popup/index.html',
  },
  icons: {
    128: 'icon-128.png',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*', '<all_urls>'],
      js: ['content/index.iife.js'],
      all_frames: true,
      match_about_blank: true,
    },
  ],
  web_accessible_resources: [
    {
      resources: ['*.js', '*.css', '*.svg', 'icon-128.png', 'icon-32.png'],
      matches: ['*://*/*'],
    },
  ],
};

export default manifest;
