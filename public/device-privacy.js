const button = document.getElementById('clear-device');
const result = document.getElementById('device-result');
button.addEventListener('click', async () => {
  if (!confirm('Lokale Daten wirklich entfernen? Noch nicht übertragene Fotos und Entwürfe gehen unwiederbringlich verloren. Cloud-Daten bleiben erhalten.')) return;
  button.disabled = true;
  try {
    if (typeof indexedDB.databases !== 'function') throw new Error('Bitte die Website-Daten über die Datenschutzeinstellungen deines Browsers entfernen.');
    const databases = await indexedDB.databases();
    for (const database of databases) {
      if (!database.name) continue;
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(database.name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Gerätedaten konnten nicht vollständig entfernt werden.'));
        request.onblocked = () => reject(new Error('Bitte alle anderen Tabs dieser App schließen und erneut versuchen.'));
      });
    }
    if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
    localStorage.clear(); sessionStorage.clear();
    window.location.assign('/');
  } catch (error) { result.textContent = error instanceof Error ? error.message : 'Die Gerätedaten konnten nicht vollständig entfernt werden.'; button.disabled = false; }
});
