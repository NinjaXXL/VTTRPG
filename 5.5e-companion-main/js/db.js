// IndexedDB abstraction layer for DnD Companion
// Replaces PostgreSQL — all data lives in the DM's browser

(function() {
  const DB_NAME = 'dnd-companion';
  const DB_VERSION = 1;

  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('characters')) {
          db.createObjectStore('characters', { keyPath: '_id' });
        }
        if (!db.objectStoreNames.contains('dmState')) {
          db.createObjectStore('dmState', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => {
        _db = e.target.result;
        _db.onclose = () => { _db = null; };
        resolve(_db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // --- Characters ---

  async function getAllCharacters() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readonly');
      const store = tx.objectStore('characters');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      req.onerror = () => reject(req.error);
    });
  }

  async function getCharacter(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readonly');
      const store = tx.objectStore('characters');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function putCharacter(char) {
    const err = validateCharacter(char);
    if (err) throw new Error(err);
    sanitizeCharacter(char);
    if (!char._id) char._id = (crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
    char.updatedAt = new Date().toISOString();
    if (!char.createdAt) char.createdAt = char.updatedAt;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readwrite');
      const store = tx.objectStore('characters');
      const req = store.put(char);
      req.onsuccess = () => resolve(char);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteCharacter(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('characters', 'readwrite');
      const store = tx.objectStore('characters');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- DM State (key-value) ---

  async function getState(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('dmState', 'readonly');
      const store = tx.objectStore('dmState');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function putState(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('dmState', 'readwrite');
      const store = tx.objectStore('dmState');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Convenience wrappers ---

  const getBattlefield = () => getState('battlefield').then(v => v || []);
  const saveBattlefield = (monsters) => putState('battlefield', monsters);
  const getCharacterHP = () => getState('characterHP').then(v => v || {});
  const saveCharacterHP = (data) => putState('characterHP', data);
  const getTreasures = () => getState('treasures').then(v => v || []);
  const saveTreasures = (items) => putState('treasures', items);
  const getShops = () => getState('shops').then(v => v || []);
  const saveShops = (shops) => putState('shops', shops);
  const getNotes = () => getState('notes').then(v => v || '');
  const saveNotes = (text) => putState('notes', text);
  const getRoomId = () => getState('roomId');
  const getPin = () => getState('pin');
  const savePin = (pin) => putState('pin', pin);

  async function ensureRoomId() {
    let roomId = await getRoomId();
    if (!roomId) {
      roomId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await putState('roomId', roomId);
    }
    return roomId;
  }

  // --- Backup / Restore ---

  async function exportAll() {
    const characters = await getAllCharacters();
    const battlefield = await getBattlefield();
    const characterHP = await getCharacterHP();
    const treasures = await getTreasures();
    const shops = await getShops();
    const notes = await getNotes();
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      characters,
      battlefield,
      characterHP,
      treasures,
      shops,
      notes
    }, null, 2);
  }

  async function importAll(jsonString) {
    const data = JSON.parse(jsonString);
    if (!data.version) throw new Error('Invalid backup file');

    const db = await openDB();

    // Clear existing data
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['characters', 'dmState'], 'readwrite');
      tx.objectStore('characters').clear();
      tx.objectStore('dmState').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Import characters
    if (data.characters && data.characters.length > 0) {
      const dbRef = await openDB();
      const tx = dbRef.transaction('characters', 'readwrite');
      const store = tx.objectStore('characters');
      for (const char of data.characters) {
        store.put(char);
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // Import state
    if (data.battlefield) await saveBattlefield(data.battlefield);
    if (data.characterHP) await saveCharacterHP(data.characterHP);
    if (data.treasures) await saveTreasures(data.treasures);
    if (data.shops) await saveShops(data.shops);
    if (data.notes) await saveNotes(data.notes);
  }

  // --- Validation (moved from server.js) ---

  const LIMITS = { equipment: 50, spells: 50, features: 50 };
  const STR_LIMITS = { name: 100, class: 50, species: 50, background: 100 };

  function sanitizeString(str, maxLen) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
  }

  function validateCharacter(c) {
    if (!c.name || typeof c.name !== 'string' || c.name.trim().length === 0) return 'Name is required';
    if (c.name.length > STR_LIMITS.name) return `Name too long (max ${STR_LIMITS.name} chars)`;
    if (c.class && c.class.length > STR_LIMITS.class) return 'Invalid class';
    if (c.species && c.species.length > STR_LIMITS.species) return 'Invalid species';
    if (c.background && c.background.length > STR_LIMITS.background) return 'Background too long';
    if (c.level != null && (c.level < 1 || c.level > 20)) return 'Level must be 1-20';
    if (c.HP != null && (c.HP < 0 || c.HP > 9999)) return 'Invalid HP';
    if (c.AC != null && (c.AC < 0 || c.AC > 99)) return 'Invalid AC';
    for (const a of ['STR','DEX','CON','INT','WIS','CHA']) {
      if (c[a] != null && (c[a] < 1 || c[a] > 30)) return `Invalid ${a} score`;
    }
    if (c.equipment && c.equipment.length > LIMITS.equipment) return `Equipment limit reached (max ${LIMITS.equipment})`;
    if (c.spells && c.spells.length > LIMITS.spells) return `Spells limit reached (max ${LIMITS.spells})`;
    if (c.features && c.features.length > LIMITS.features) return `Features limit reached (max ${LIMITS.features})`;
    return null;
  }

  function sanitizeCharacter(c) {
    c.name = sanitizeString(c.name, STR_LIMITS.name);
    c.class = sanitizeString(c.class, STR_LIMITS.class);
    c.species = sanitizeString(c.species, STR_LIMITS.species);
    c.background = sanitizeString(c.background, STR_LIMITS.background);
    c.level = Math.max(1, Math.min(20, parseInt(c.level) || 1));
    c.HP = Math.max(0, Math.min(9999, parseInt(c.HP) || 0));
    c.AC = Math.max(0, Math.min(99, parseInt(c.AC) || 0));
    for (const a of ['STR','DEX','CON','INT','WIS','CHA']) {
      c[a] = Math.max(1, Math.min(30, parseInt(c[a]) || 10));
    }
    if (c.equipment) {
      c.equipment = c.equipment.slice(0, LIMITS.equipment).map(e => ({
        name: sanitizeString(e.name, 100),
        type: sanitizeString(e.type, 50),
        description: sanitizeString(e.description, 500),
        quantity: Math.max(0, Math.min(9999, parseInt(e.quantity) || 1))
      }));
    }
    return c;
  }

  // Expose as global
  window.db = {
    openDB,
    getAllCharacters, getCharacter, putCharacter, deleteCharacter,
    getState, putState,
    getBattlefield, saveBattlefield,
    getCharacterHP, saveCharacterHP,
    getTreasures, saveTreasures,
    getShops, saveShops,
    getNotes, saveNotes,
    getRoomId, ensureRoomId, getPin, savePin,
    exportAll, importAll,
    validateCharacter, sanitizeCharacter
  };
})();
