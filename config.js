// Paste your Apps Script Web app URL here (it ends in /exec). See SETUP.md, step 5.
window.QR_CONFIG = {
  API_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE',
  // Your Google OAuth Client ID (README: "Google sign-in"). Same value as GOOGLE_CLIENT_ID in Code.gs.
  GOOGLE_CLIENT_ID: 'PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com',
  // How often the lists refresh while a list tab is open (milliseconds).
  LIVE_REFRESH_MS: 12000,
  // How often queued changes are retried when sync is failing (milliseconds).
  RETRY_MS: 15000
};
