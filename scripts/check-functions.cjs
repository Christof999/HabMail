const assert = require('node:assert/strict');

process.env.GCLOUD_PROJECT = 'demo-werkbank-audit';
process.env.POST_DATABASE_URL = 'http://127.0.0.1:9000/?ns=demo-werkbank-audit';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-werkbank-audit', databaseURL: process.env.POST_DATABASE_URL });
const functions = require('../functions/index.js');
for (const name of ['countOlderMails', 'importOlderMails', 'pollMailboxes', 'pollNow', 'retryAccountingHandoffs', 'sendTestNotification', 'stopOlderImport', 'syncAccounting', 'whoAmI']) {
  assert.equal(typeof functions[name], 'function', `Die veröffentlichte Funktion ${name} lässt sich nicht laden.`);
}
console.log('Die neun Werkbank-Functions lassen sich mit dem installierten SDK laden.');
