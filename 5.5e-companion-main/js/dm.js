// SKILL_ABILITIES is defined in constants.js

function calcProfBonus(level) {
  return Math.ceil(level / 4) + 1;
}

function getProficiencyBonus() {
  const level = parseInt(document.getElementById('f-level')?.value) || 1;
  return calcProfBonus(level);
}

function getAbilityMod(ability) {
  const score = parseInt(document.getElementById(`f-${ability}`)?.value) || 10;
  return Math.floor((score - 10) / 2);
}

function updateAbilityModBadges() {
  ABILITIES.forEach(a => {
    const mod = getAbilityMod(a);
    const el = document.getElementById(`mod-${a}`);
    if (el) {
      el.textContent = mod >= 0 ? `+${mod}` : `${mod}`;
      el.className = 'ability-mod-badge' + (mod > 0 ? ' positive' : mod < 0 ? ' negative' : '');
    }
  });
}

let currentSession = null; // { pin, characters: { id: { claimedBy } } }
let dmPeer = null; // PeerJS host instance
let allSpells = [];
let selectedSpells = [];
let allFeatures = [];
let selectedFeatures = [];
let allEquipment = [];
let allMonsters = [];
let battlefieldMonsters = [];
let battlefieldPCIds = [];
let treasurePool = [];
let allCharacters = [];
let shops = [];
let characterHPState = {};
let bfCharactersCache = [];

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // --- Register all event listeners first (synchronous) ---
  populateDropdowns();
  renderSavingThrows();
  renderSkillInputs();
  updateAbilityModBadges();

  document.getElementById('session-toggle').addEventListener('change', handleSessionToggle);
  document.getElementById('btn-show-qr').addEventListener('click', showQR);
  document.getElementById('btn-add-char').addEventListener('click', () => openCharModal());
  document.getElementById('char-form').addEventListener('submit', saveCharacter);

  // Characters import/export
  document.getElementById('btn-export-all-chars').addEventListener('click', showExportCharacterPicker);

  // Workspace
  document.getElementById('btn-save-workspace').addEventListener('click', saveWorkspace);
  document.getElementById('load-workspace-file').addEventListener('change', loadWorkspace);
  document.getElementById('btn-clear-workspace').addEventListener('click', clearWorkspace);

  // Recalculate skills, saving throws, and ability mod badges when abilities or level change
  ['STR','DEX','CON','INT','WIS','CHA'].forEach(a => {
    document.getElementById(`f-${a}`).addEventListener('input', () => {
      updateSkillModifiers();
      updateSavingThrows();
      updateAbilityModBadges();
    });
  });
  document.getElementById('f-level').addEventListener('input', () => {
    updateSkillModifiers();
    updateSavingThrows();
    updateHPBreakdown();
    applySmartSpellFilters();
    // Auto-populate features when level changes (only for new characters)
    if (!document.getElementById('char-edit-id').value) autoPopulateFeatures();
  });

  document.getElementById('f-class').addEventListener('change', () => {
    renderSavingThrows();
    autoSetHP();
    updateHPBreakdown();
    applySmartSpellFilters();
    updateSkillGuidance();
    // Auto-populate features when class changes (only for new characters)
    if (!document.getElementById('char-edit-id').value) autoPopulateFeatures();
  });
  document.getElementById('f-species').addEventListener('change', () => {
    // Auto-populate features when species changes (only for new characters)
    if (!document.getElementById('char-edit-id').value) autoPopulateFeatures();
  });
  document.getElementById('f-background').addEventListener('change', () => {
    if (!document.getElementById('char-edit-id').value) {
      autoPopulateFeatures();
      autoPopulateSkills();
    }
    updateSkillGuidance();
  });
  document.getElementById('f-CON').addEventListener('input', () => {
    autoSetHP();
    updateHPBreakdown();
    if (abilityMethod === 'pointbuy') updatePointBuyDisplay();
    if (abilityMethod === 'standard') renderStandardArrayPool();
  });
  document.getElementById('btn-calc-hp').addEventListener('click', calcFullHP);

  // Ability score method buttons + point buy / standard array tracking
  initAbilityMethods();
  ['STR','DEX','INT','WIS','CHA'].forEach(a => {
    document.getElementById(`f-${a}`).addEventListener('input', () => {
      if (abilityMethod === 'pointbuy') updatePointBuyDisplay();
      if (abilityMethod === 'standard') renderStandardArrayPool();
    });
  });

  // Feature search
  document.getElementById('feature-search').addEventListener('input', filterFeatures);
  document.getElementById('feature-source-filter').addEventListener('change', filterFeatures);
  document.getElementById('f-class').addEventListener('change', filterFeatures);
  document.getElementById('f-species').addEventListener('change', filterFeatures);
  document.getElementById('f-level').addEventListener('input', filterFeatures);

  // DM page tabs
  document.querySelectorAll('.tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach(t => {
        t.classList.remove('tab-active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('tab-active');
      tab.setAttribute('aria-selected', 'true');
      document.getElementById(tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'dm-tab-battlefield') renderBattlefieldCharacters();
    });
  });

  // Battlefield
  document.getElementById('monster-search').addEventListener('input', filterMonsters);
  document.getElementById('monster-type-filter').addEventListener('change', filterMonsters);
  document.getElementById('monster-cr-filter').addEventListener('change', filterMonsters);
  document.getElementById('btn-add-monsters').addEventListener('click', () => {
    document.getElementById('monster-search-modal').showModal();
    document.getElementById('monster-search').focus();
  });

  // Treasures
  document.getElementById('treasure-search').addEventListener('input', filterTreasureSearch);
  document.getElementById('treasure-type-filter').addEventListener('change', filterTreasureSearch);
  document.getElementById('btn-add-items').addEventListener('click', () => {
    document.getElementById('treasure-search-modal').showModal();
    document.getElementById('treasure-search').focus();
  });

  // Shops
  document.getElementById('btn-create-shop').addEventListener('click', createShop);
  document.getElementById('shop-item-search').addEventListener('input', filterShopItems);
  document.getElementById('shop-item-type-filter').addEventListener('change', filterShopItems);

  // Equipment search
  document.getElementById('equip-search').addEventListener('input', filterEquipment);
  document.getElementById('equip-type-filter').addEventListener('change', filterEquipment);

  // Spell search
  document.getElementById('spell-search').addEventListener('input', filterSpells);
  document.getElementById('spell-level-filter').addEventListener('change', filterSpells);
  document.getElementById('spell-class-filter').addEventListener('change', filterSpells);

  // Compendium (top bar search)
  const topBarSearch = document.getElementById('top-bar-search');
  const topBarDropdown = document.getElementById('top-bar-dropdown');
  topBarSearch.addEventListener('focus', () => {
    if (window.matchMedia('(max-width: 768px)').matches) {
      topBarSearch.blur();
      openMobileSearchModal();
    } else {
      openSearchDropdown(); filterCompendium();
    }
  });
  topBarSearch.addEventListener('input', () => { openSearchDropdown(); filterCompendium(); });
  document.getElementById('compendium-category').addEventListener('change', filterCompendium);
  document.getElementById('compendium-spell-level').addEventListener('change', filterCompendium);
  document.getElementById('compendium-spell-class').addEventListener('change', filterCompendium);
  document.getElementById('compendium-monster-type').addEventListener('change', filterCompendium);
  document.getElementById('compendium-monster-cr').addEventListener('change', filterCompendium);
  document.getElementById('compendium-feature-source').addEventListener('change', filterCompendium);
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.top-bar-search-wrap');
    if (wrap && !wrap.contains(e.target)) closeSearchDropdown();
  });
  topBarSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearchDropdown(); topBarSearch.blur(); }
  });

  // Mobile search modal
  const mobileSearchInput = document.getElementById('mobile-search-input');
  mobileSearchInput.addEventListener('input', filterMobileCompendium);
  document.getElementById('mobile-compendium-category').addEventListener('change', filterMobileCompendium);
  document.getElementById('mobile-spell-level').addEventListener('change', filterMobileCompendium);
  document.getElementById('mobile-spell-class').addEventListener('change', filterMobileCompendium);
  document.getElementById('mobile-monster-type').addEventListener('change', filterMobileCompendium);
  document.getElementById('mobile-monster-cr').addEventListener('change', filterMobileCompendium);
  document.getElementById('mobile-feature-source').addEventListener('change', filterMobileCompendium);

  // Notes
  const notesEditor = document.getElementById('notes-editor');
  let notesSaveTimeout = null;
  notesEditor.addEventListener('input', () => {
    document.getElementById('notes-save-status').textContent = 'Unsaved changes...';
    clearTimeout(notesSaveTimeout);
    notesSaveTimeout = setTimeout(saveNotes, 1000);
  });

  // --- Load data asynchronously (errors won't break UI) ---
  try {
    loadCharacters();
    await Promise.all([loadSpellsDB(), loadFeaturesDB(), loadEquipmentDB(), loadMonstersDB()]);
    populateCompendiumMonsterFilters();
    await loadBattlefield();
    await loadCharacterHP();
    await loadTreasures();
    await loadShops();
    loadNotes();

    // Show character preview if link includes preview=<encoded JSON>
    openCharacterPreviewFromUrl();
  } catch (e) {
    console.error('Error loading data:', e);
  }
});

// --- Dialog helpers (replaces alert/confirm) ---
function showDialog({ title, message, type = 'info', buttons = ['OK'] }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const btnsEl = document.getElementById('dialog-buttons');

    titleEl.textContent = title || '';
    msgEl.textContent = message || '';

    btnsEl.innerHTML = buttons.map((label, i) => {
      const isPrimary = i === buttons.length - 1;
      const isDanger = type === 'warn' && isPrimary && buttons.length > 1;
      let cls = 'btn btn-small ';
      if (isDanger) cls += 'btn-danger';
      else if (isPrimary) cls += 'btn-primary';
      else cls += 'btn-secondary';
      return `<button class="${cls}" data-dialog-idx="${i}">${esc(label)}</button>`;
    }).join('');

    const done = (result) => {
      overlay.removeEventListener('cancel', onCancel);
      overlay.close();
      resolve(result);
    };

    const onCancel = (e) => {
      e.preventDefault();
      done(false);
    };

    btnsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        done(btn.dataset.dialogIdx === String(buttons.length - 1));
      });
    });

    overlay.addEventListener('cancel', onCancel);
    overlay.showModal();
  });
}

function dialogAlert(message, title, type = 'info') {
  return showDialog({ title: title || (type === 'error' ? 'Error' : type === 'success' ? 'Success' : 'Notice'), message, type });
}

function dialogConfirm(message, title) {
  return showDialog({ title: title || 'Confirm', message, type: 'warn', buttons: ['Cancel', 'Confirm'] });
}

function dialogPrompt(message, title, defaultValue) {
  return new Promise(resolve => {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const btnsEl = document.getElementById('dialog-buttons');

    titleEl.textContent = title || 'Input';
    msgEl.textContent = message || '';

    btnsEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;width:100%;">
        <input type="text" id="dialog-prompt-input" value="${esc(defaultValue || '')}"
          style="width:100%;box-sizing:border-box;padding:8px 12px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:var(--font-body);font-size:1rem;">
        <div style="display:flex;gap:10px;justify-content:center;">
          <button class="btn btn-secondary btn-small">Cancel</button><button class="btn btn-primary btn-small">Save</button>
        </div>
      </div>`;
    const wrapper = btnsEl.querySelector('div > div');

    const input = document.getElementById('dialog-prompt-input');
    input.select();

    const close = (value) => { overlay.close(); resolve(value); };
    wrapper.children[0].addEventListener('click', () => close(null));
    wrapper.children[1].addEventListener('click', () => close(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim());
      if (e.key === 'Escape') close(null);
    });

    overlay.showModal();
    input.focus();
  });
}

// --- Workspace ---
async function saveWorkspace() {
  const defaultName = `dnd-workspace-${new Date().toISOString().slice(0,10)}`;
  const filename = await dialogPrompt('Enter a filename for the workspace:', 'Save Workspace', defaultName);
  if (!filename) return;

  const json = await db.exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.json') ? filename : filename + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function loadWorkspace(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (!await dialogConfirm('This will replace ALL current data. Are you sure?', 'Load Workspace')) return;
  try {
    const text = await file.text();
    await db.importAll(text);
    await dialogAlert('Workspace loaded successfully. Reloading...', 'Success', 'success');
    window.location.reload();
  } catch (e) {
    await dialogAlert('Failed to load workspace: ' + e.message, 'Error', 'error');
  }
}

async function clearWorkspace() {
  if (!await dialogConfirm('This will delete ALL characters, battlefield, treasures, shops, and notes.', 'Clear Workspace')) return;
  if (!await dialogConfirm('This cannot be undone. Continue?', 'Are you sure?')) return;
  try {
    await db.importAll(JSON.stringify({ version: 1, characters: [] }));
    await dialogAlert('Workspace cleared. Reloading...', 'Success', 'success');
    window.location.reload();
  } catch (e) {
    await dialogAlert('Failed to clear workspace: ' + e.message, 'Error', 'error');
  }
}

// --- Dropdowns ---
function populateDropdowns() {
  const classSelect = document.getElementById('f-class');
  classSelect.innerHTML = '<option value="">Select class...</option>' +
    CLASSES.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__custom__">+ Add Custom</option>';
  classSelect.addEventListener('change', () => {
    const customInput = document.getElementById('f-class-custom');
    if (classSelect.value === '__custom__') {
      customInput.style.display = '';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
      customInput.value = '';
    }
  });

  const speciesSelect = document.getElementById('f-species');
  speciesSelect.innerHTML = '<option value="">Select species...</option>' +
    SPECIES.map(s => `<option value="${s}">${s}</option>`).join('') +
    '<option value="__custom__">+ Add Custom</option>';
  speciesSelect.addEventListener('change', () => {
    const customInput = document.getElementById('f-species-custom');
    if (speciesSelect.value === '__custom__') {
      customInput.style.display = '';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
      customInput.value = '';
    }
  });

  const bgSelect = document.getElementById('f-background');
  bgSelect.innerHTML = '<option value="">Select background...</option>' +
    BACKGROUNDS.map(b => `<option value="${b}">${b}</option>`).join('') +
    '<option value="__custom__">+ Add Custom</option>';
  bgSelect.addEventListener('change', () => {
    const customInput = document.getElementById('f-background-custom');
    if (bgSelect.value === '__custom__') {
      customInput.style.display = '';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
      customInput.value = '';
    }
  });
}

// --- Auto HP calculation ---
function autoSetHP() {
  const level = parseInt(document.getElementById('f-level').value) || 1;
  if (level !== 1) return;
  const cls = document.getElementById('f-class').value;
  if (!cls || !HIT_DIE[cls]) return;
  const conScore = parseInt(document.getElementById('f-CON').value) || 10;
  const conMod = Math.floor((conScore - 10) / 2);
  const hp = Math.max(1, HIT_DIE[cls] + conMod);
  document.getElementById('f-hp').value = hp;
  updateHPBreakdown();
}

function calcFullHP() {
  const cls = document.getElementById('f-class').value;
  const level = parseInt(document.getElementById('f-level').value) || 1;
  if (!cls || !HIT_DIE[cls]) return;
  const conScore = parseInt(document.getElementById('f-CON').value) || 10;
  const conMod = Math.floor((conScore - 10) / 2);
  const hitDie = HIT_DIE[cls];
  // Level 1: max hit die + CON mod. Levels 2+: average (die/2 + 1) + CON mod each
  const avg = Math.floor(hitDie / 2) + 1;
  const hp = Math.max(1, hitDie + conMod + (level - 1) * (avg + conMod));
  document.getElementById('f-hp').value = hp;
  updateHPBreakdown();
}

function updateHPBreakdown() {
  const el = document.getElementById('hp-breakdown');
  if (!el) return;
  const cls = document.getElementById('f-class').value;
  const level = parseInt(document.getElementById('f-level').value) || 1;
  if (!cls || !HIT_DIE[cls]) { el.textContent = ''; return; }
  const conScore = parseInt(document.getElementById('f-CON').value) || 10;
  const conMod = Math.floor((conScore - 10) / 2);
  const hitDie = HIT_DIE[cls];
  const avg = Math.floor(hitDie / 2) + 1;
  const conSign = conMod >= 0 ? '+' : '';
  let text = `L1: ${hitDie}${conSign}${conMod}`;
  if (level > 1) text += ` | L2-${level}: ${level - 1}×(${avg}${conSign}${conMod})`;
  const expected = Math.max(1, hitDie + conMod + (level - 1) * (avg + conMod));
  text += ` = ${expected} (avg)`;
  el.textContent = text;
}

// --- Ability Score Methods ---
let abilityMethod = 'manual';
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_BUY_COSTS = { 8:0, 9:1, 10:2, 11:3, 12:4, 13:5, 14:7, 15:9 };
const POINT_BUY_TOTAL = 27;

function initAbilityMethods() {
  document.querySelectorAll('.ability-method-btn').forEach(btn => {
    btn.addEventListener('click', () => setAbilityMethod(btn.dataset.method));
  });
}

function setAbilityMethod(method) {
  abilityMethod = method;
  document.querySelectorAll('.ability-method-btn').forEach(btn => {
    if (btn.dataset.method === method) {
      btn.style.background = 'hsl(0, 0%, 25%)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'hsl(0, 0%, 18%)';
    } else {
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    }
  });
  const infoEl = document.getElementById('ability-method-info');
  if (method === 'manual') {
    infoEl.style.display = 'none';
  } else if (method === 'standard') {
    infoEl.style.display = '';
    infoEl.innerHTML = `<strong>Standard Array:</strong> Assign 15, 14, 13, 12, 10, 8 to your abilities.<br>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;" id="standard-array-pool"></div>`;
    renderStandardArrayPool();
  } else if (method === 'pointbuy') {
    infoEl.style.display = '';
    updatePointBuyDisplay();
  } else if (method === 'roll') {
    infoEl.style.display = '';
    infoEl.innerHTML = `<strong>Roll 4d6 Drop Lowest:</strong> <button type="button" class="btn btn-primary btn-small" style="font-size:0.72rem;padding:0.2rem 0.6rem;min-height:1.75rem;" onclick="rollAbilityScores()">Roll All</button>
      <span id="roll-results" style="margin-left:8px;"></span>`;
  }
}

function renderStandardArrayPool() {
  const pool = document.getElementById('standard-array-pool');
  if (!pool) return;
  const assigned = {};
  ABILITIES.forEach(a => {
    const val = parseInt(document.getElementById(`f-${a}`).value) || 10;
    if (STANDARD_ARRAY.includes(val)) assigned[a] = val;
  });
  const used = Object.values(assigned);
  const remaining = [...STANDARD_ARRAY];
  used.forEach(v => { const idx = remaining.indexOf(v); if (idx >= 0) remaining.splice(idx, 1); });
  pool.innerHTML = remaining.length > 0
    ? `<span style="color:var(--text-muted);font-size:0.8rem;">Remaining: </span>` + remaining.map(v => `<span style="display:inline-block;padding:2px 8px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;font-weight:600;font-size:0.85rem;">${v}</span>`).join('')
    : `<span style="color:hsl(153,47%,35%);font-size:0.8rem;font-weight:600;">All scores assigned!</span>`;
}

function updatePointBuyDisplay() {
  const infoEl = document.getElementById('ability-method-info');
  let spent = 0;
  ABILITIES.forEach(a => {
    const val = Math.max(8, Math.min(15, parseInt(document.getElementById(`f-${a}`).value) || 8));
    spent += POINT_BUY_COSTS[val] || 0;
  });
  const remaining = POINT_BUY_TOTAL - spent;
  const color = remaining < 0 ? 'hsl(0,60%,40%)' : remaining === 0 ? 'hsl(153,47%,35%)' : 'var(--text)';
  infoEl.style.display = '';
  infoEl.innerHTML = `<strong>Point Buy:</strong> <span style="color:${color};font-weight:700;">${remaining}</span> / ${POINT_BUY_TOTAL} points remaining. Scores: 8–15.
    <button type="button" class="btn btn-secondary btn-small" style="font-size:0.72rem;padding:0.2rem 0.6rem;min-height:1.75rem;margin-left:6px;" onclick="resetPointBuy()">Reset to 8s</button>`;
}

function resetPointBuy() {
  ABILITIES.forEach(a => { document.getElementById(`f-${a}`).value = 8; });
  updateAbilityModBadges();
  updateSkillModifiers();
  updateSavingThrows();
  updatePointBuyDisplay();
  updateHPBreakdown();
}

function rollAbilityScores() {
  const results = [];
  for (let i = 0; i < 6; i++) {
    const dice = [1,2,3,4].map(() => Math.floor(Math.random() * 6) + 1);
    dice.sort((a, b) => b - a);
    results.push(dice[0] + dice[1] + dice[2]);
  }
  results.sort((a, b) => b - a);
  ABILITIES.forEach((a, i) => { document.getElementById(`f-${a}`).value = results[i]; });
  updateAbilityModBadges();
  updateSkillModifiers();
  updateSavingThrows();
  autoSetHP();
  updateHPBreakdown();
  const el = document.getElementById('roll-results');
  if (el) el.textContent = `Rolled: ${results.join(', ')}`;
}

// --- Auto-populate class features & species traits ---
function autoPopulateFeatures() {
  const cls = document.getElementById('f-class').value;
  const species = document.getElementById('f-species').value;
  const level = parseInt(document.getElementById('f-level').value) || 1;
  const bgSelect = document.getElementById('f-background');
  const background = bgSelect.value === '__custom__' ? '' : bgSelect.value;

  // Remove previously auto-added features (class + species + background)
  selectedFeatures = selectedFeatures.filter(f => f.source !== 'class' && f.source !== 'species' && f.source !== 'background');

  // Add class features up to current level
  if (cls) {
    const classFeats = allFeatures.filter(f => f.source === 'class' && f._className === cls && f._level <= level);
    classFeats.forEach(f => {
      if (!selectedFeatures.find(s => s.name === f.name && s.sourceDetail === f.sourceDetail)) {
        selectedFeatures.push({ ...f });
      }
    });
  }

  // Add species traits
  if (species) {
    const speciesTraits = allFeatures.filter(f => f.source === 'species' && f._speciesName === species);
    speciesTraits.forEach(f => {
      if (!selectedFeatures.find(s => s.name === f.name && s.sourceDetail === f.sourceDetail)) {
        selectedFeatures.push({ ...f });
      }
    });
  }

  // Add background origin feat
  const featName = BACKGROUND_FEATS[background];
  if (featName) {
    const feat = allFeatures.find(f => f.source === 'feat' && f.name === featName);
    if (feat && !selectedFeatures.find(s => s.name === feat.name && s.source === 'background')) {
      selectedFeatures.push({ ...feat, source: 'background', sourceDetail: `${background} (Origin Feat)` });
    }
  }

  renderSelectedFeatures();
}

// --- Smart spell pre-filtering ---
function getMaxSpellLevel(cls, level) {
  const slots = getSpellSlots(cls, level);
  if (slots.type === 'none') return -1;
  if (slots.type === 'pact') return slots.slotLevel;
  return slots.slots.length;
}

function applySmartSpellFilters() {
  const cls = document.getElementById('f-class').value;
  const level = parseInt(document.getElementById('f-level').value) || 1;
  const classFilter = document.getElementById('spell-class-filter');
  const levelFilter = document.getElementById('spell-level-filter');

  if (cls && SPELLCASTING_ABILITY[cls]) {
    classFilter.value = cls.toLowerCase();
    // Set max level hint but don't restrict — DM might want higher-level scrolls
  } else {
    classFilter.value = '';
  }
  updateSpellSlotsInfo();
}

function updateSpellSlotsInfo() {
  const el = document.getElementById('spell-slots-info');
  if (!el) return;
  const cls = document.getElementById('f-class').value;
  const level = parseInt(document.getElementById('f-level').value) || 1;
  const slots = getSpellSlots(cls, level);
  const known = getSpellsKnown(cls, level);

  if (slots.type === 'none' || (slots.type !== 'pact' && slots.slots.length === 0 && known.cantrips === 0)) {
    el.innerHTML = '';
    return;
  }

  let parts = [];
  if (known.cantrips > 0) parts.push(`Cantrips: ${known.cantrips}`);
  if (known.prepared > 0) parts.push(`Prepared spells: ${known.prepared}`);

  if (slots.type === 'pact') {
    parts.push(`Pact Magic: ${slots.slots} slot${slots.slots > 1 ? 's' : ''} at level ${slots.slotLevel}`);
  } else if (slots.slots.length > 0) {
    parts.push('Slots: ' + slots.slots.map((n, i) => `L${i + 1}: ${n}`).join(' · '));
  }
  el.innerHTML = parts.join(' · ');
}

// --- Level Up ---
async function openLevelUpModal(charId) {
  const c = await db.getCharacter(charId);
  if (!c) return;
  const oldLevel = c.level;
  const newLevel = oldLevel + 1;
  if (newLevel > 20) { dialogAlert('Character is already at maximum level (20).', 'Level Up', 'info'); return; }

  const cls = c.class;
  const hitDie = HIT_DIE[cls]; // undefined for custom classes
  const conMod = Math.floor(((c.CON || 10) - 10) / 2);
  const profOld = calcProfBonus(oldLevel);
  const profNew = calcProfBonus(newLevel);

  // New class features at this level
  const newFeatures = allFeatures.filter(f => f.source === 'class' && f._className === cls && f._level === newLevel);

  // ASI levels (5.5e: 4, 8, 12, 16, 19)
  const asiLevels = [4, 8, 12, 16, 19];
  const isASI = asiLevels.includes(newLevel);

  // Spell slot changes
  const oldSlots = getSpellSlots(cls, oldLevel);
  const newSlots = getSpellSlots(cls, newLevel);
  let slotsChanged = false;
  if (newSlots.type !== 'none') {
    if (newSlots.type === 'pact') {
      slotsChanged = oldSlots.type !== 'pact' || oldSlots.slots !== newSlots.slots || oldSlots.slotLevel !== newSlots.slotLevel;
    } else {
      slotsChanged = JSON.stringify(oldSlots.slots) !== JSON.stringify(newSlots.slots);
    }
  }

  let html = `<div style="margin-bottom:12px;font-size:1rem;">
    <strong>${esc(c.name)}</strong> — Level ${oldLevel} → <strong style="color:var(--accent);">${newLevel}</strong>
  </div>`;

  // HP section
  if (hitDie) {
    const avg = Math.floor(hitDie / 2) + 1;
    const avgHP = avg + conMod;
    html += `<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px;">
      <strong>Hit Points</strong> (d${hitDie} + ${conMod >= 0 ? '+' : ''}${conMod} CON)
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
        <button type="button" class="btn btn-primary btn-small" onclick="levelUpRollHP('${charId}', ${hitDie}, ${conMod})">Roll d${hitDie}</button>
        <button type="button" class="btn btn-secondary btn-small" onclick="levelUpAvgHP('${charId}', ${avgHP})">Take Average (+${avgHP})</button>
        <span id="levelup-hp-result" style="font-weight:600;"></span>
      </div>
    </div>`;
  } else {
    html += `<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px;">
      <strong>Hit Points</strong> (Custom class — enter HP gain manually)
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
        <input type="number" id="levelup-manual-hp" class="input input-bordered" style="width:80px;" min="1" placeholder="HP">
        <button type="button" class="btn btn-secondary btn-small" onclick="levelUpManualHP('${charId}')">Set HP Gain</button>
        <span id="levelup-hp-result" style="font-weight:600;"></span>
      </div>
    </div>`;
  }

  // Proficiency bonus change
  if (profNew > profOld) {
    html += `<div style="background:hsl(153,30%,93%);border:1px solid hsl(153,30%,80%);border-radius:6px;padding:10px;margin-bottom:12px;">
      Proficiency Bonus: +${profOld} → <strong>+${profNew}</strong>
    </div>`;
  }

  // New features
  if (newFeatures.length > 0) {
    html += `<div style="margin-bottom:12px;">
      <strong>New Class Features:</strong>
      ${newFeatures.map(f => `<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-top:6px;">
        <strong>${esc(f.name)}</strong>
        <div style="font-size:0.85rem;color:var(--text-muted);margin-top:2px;">${esc(f.description).substring(0, 200)}${f.description.length > 200 ? '…' : ''}</div>
      </div>`).join('')}
    </div>`;
  }

  // ASI
  if (isASI) {
    html += `<div style="background:hsl(42,55%,93%);border:1px solid hsl(42,55%,75%);border-radius:6px;padding:10px;margin-bottom:12px;">
      <strong>Ability Score Improvement!</strong> Increase one ability by 2, or two abilities by 1 each, or pick a feat.
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;" id="asi-controls">
        ${ABILITIES.map(a => `<div style="text-align:center;">
          <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);font-family:var(--font-heading);">${a} (${c[a]})</div>
          <div style="display:flex;gap:2px;margin-top:2px;">
            <button type="button" class="hp-btn hp-btn-sm" data-asi="${a}" data-amount="1" onclick="levelUpASI('${charId}','${a}',1)">+1</button>
            <button type="button" class="hp-btn hp-btn-sm" data-asi="${a}" data-amount="2" onclick="levelUpASI('${charId}','${a}',2)">+2</button>
          </div>
        </div>`).join('')}
      </div>
      <div id="asi-pending" style="margin-top:6px;font-size:0.85rem;color:var(--text-muted);display:flex;align-items:center;gap:8px;">
        <span></span>
        <button type="button" class="btn btn-secondary btn-small" onclick="resetASI()" style="display:none;font-size:0.75rem;padding:2px 8px;" id="asi-reset-btn">Reset</button>
      </div>
    </div>`;
  }

  // Spell slots
  if (slotsChanged) {
    let slotText = '';
    if (newSlots.type === 'pact') {
      slotText = `Pact Magic: ${newSlots.slots} slots at level ${newSlots.slotLevel}`;
    } else {
      slotText = newSlots.slots.map((n, i) => `L${i+1}: ${n}`).join(', ');
    }
    html += `<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px;">
      <strong>Spell Slots:</strong> ${slotText}
    </div>`;
  }

  // Apply button
  html += `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
    <button type="button" class="btn btn-secondary" onclick="document.getElementById('levelup-modal').close()">Cancel</button>
    <button type="button" class="btn btn-primary" id="btn-apply-levelup" onclick="applyLevelUp('${charId}')">Apply Level Up</button>
  </div>`;

  // Store pending changes
  window._levelUpPending = { charId, newLevel, hpGain: 0, asiChanges: {} };

  document.getElementById('levelup-title').textContent = `Level Up: ${c.name}`;
  document.getElementById('levelup-body').innerHTML = html;
  document.getElementById('levelup-modal').showModal();
}

function levelUpRollHP(charId, hitDie, conMod) {
  const roll = Math.floor(Math.random() * hitDie) + 1;
  const gain = Math.max(1, roll + conMod);
  window._levelUpPending.hpGain = gain;
  document.getElementById('levelup-hp-result').textContent = `Rolled ${roll} + ${conMod} CON = +${gain} HP`;
  document.getElementById('levelup-hp-result').style.color = roll >= hitDie / 2 ? 'hsl(153,47%,35%)' : 'hsl(0,60%,40%)';
}

function levelUpAvgHP(charId, avgHP) {
  window._levelUpPending.hpGain = Math.max(1, avgHP);
  document.getElementById('levelup-hp-result').textContent = `Average = +${Math.max(1, avgHP)} HP`;
  document.getElementById('levelup-hp-result').style.color = 'var(--text)';
}

function levelUpManualHP(charId) {
  const input = document.getElementById('levelup-manual-hp');
  const val = parseInt(input.value);
  if (!val || val < 1) {
    showToast('Enter a positive HP value');
    return;
  }
  window._levelUpPending.hpGain = val;
  document.getElementById('levelup-hp-result').textContent = `Manual = +${val} HP`;
  document.getElementById('levelup-hp-result').style.color = 'var(--text)';
}

function levelUpASI(charId, ability, amount) {
  const pending = window._levelUpPending;

  // Toggle: clicking the same ability+amount removes it
  if (pending.asiChanges[ability] === amount) {
    delete pending.asiChanges[ability];
  } else {
    // Remove existing assignment for this ability before setting new one
    const currentForAbility = pending.asiChanges[ability] || 0;
    const totalUsed = Object.values(pending.asiChanges).reduce((s, v) => s + v, 0) - currentForAbility;
    if (totalUsed + amount > 2) {
      showToast('ASI limit: 2 points total');
      return;
    }
    pending.asiChanges[ability] = amount;
  }
  updateASIDisplay();
}

function resetASI() {
  if (window._levelUpPending) {
    window._levelUpPending.asiChanges = {};
    updateASIDisplay();
  }
}

function updateASIDisplay() {
  const pending = window._levelUpPending;
  const totalUsed = Object.values(pending.asiChanges).reduce((s, v) => s + v, 0);

  // Update pending text
  const el = document.getElementById('asi-pending');
  if (el) {
    const changes = Object.entries(pending.asiChanges).filter(([,v]) => v > 0).map(([a,v]) => `${a} +${v}`);
    const span = el.querySelector('span');
    if (span) span.textContent = changes.length ? `Pending: ${changes.join(', ')} (${totalUsed}/2 points used)` : '';
    const resetBtn = document.getElementById('asi-reset-btn');
    if (resetBtn) resetBtn.style.display = changes.length ? '' : 'none';
  }

  // Highlight active buttons
  document.querySelectorAll('#asi-controls button[data-asi]').forEach(btn => {
    const btnAbility = btn.dataset.asi;
    const btnAmount = parseInt(btn.dataset.amount);
    const isActive = pending.asiChanges[btnAbility] === btnAmount;
    btn.style.background = isActive ? 'var(--accent)' : '';
    btn.style.color = isActive ? '#fff' : '';
  });
}

async function applyLevelUp(charId) {
  const pending = window._levelUpPending;
  if (!pending || pending.charId !== charId) return;
  if (pending.hpGain === 0) {
    await dialogAlert('Please roll or take average HP first.', 'Level Up', 'info');
    return;
  }

  const c = await db.getCharacter(charId);
  if (!c) return;

  c.level = pending.newLevel;
  c.HP = c.HP + pending.hpGain;

  // Apply ASI
  for (const [ability, amount] of Object.entries(pending.asiChanges)) {
    c[ability] = Math.min(30, (c[ability] || 10) + amount);
  }

  // Auto-add new class features
  const newFeatures = allFeatures.filter(f => f.source === 'class' && f._className === c.class && f._level === pending.newLevel);
  const existingFeatures = c.features || [];
  newFeatures.forEach(f => {
    if (!existingFeatures.find(ef => ef.name === f.name && ef.sourceDetail === f.sourceDetail)) {
      existingFeatures.push({ name: f.name, description: f.description, source: f.source, sourceDetail: f.sourceDetail });
    }
  });
  c.features = existingFeatures;

  try {
    await db.putCharacter(c);
    // Update HP state — increase current HP by the gain (not full heal)
    if (characterHPState[charId]) {
      characterHPState[charId].currentHP = Math.min(c.HP, characterHPState[charId].currentHP + pending.hpGain);
    }
    saveCharacterHP(charId);
    document.getElementById('levelup-modal').close();
    loadCharacters();
    broadcastCharacterToPlayer(charId);
    showToast(`${c.name} leveled up to ${c.level}!`);
  } catch (err) {
    dialogAlert(err.message, 'Level Up Error', 'error');
  }
}

// --- Features DB ---
async function loadFeaturesDB() {
  let featsRes, traitsRes, classRes;
  try {
    [featsRes, traitsRes, classRes] = await Promise.all([
      fetch('data/srd-5.2-feats.json'),
      fetch('data/srd-5.2-species-traits.json'),
      fetch('data/srd-5.2-class-features.json')
    ]);
    if (!featsRes.ok || !traitsRes.ok || !classRes.ok) throw new Error('HTTP error loading features');
  } catch (e) {
    console.error('Failed to load features data:', e);
    return;
  }
  const feats = await featsRes.json();
  const speciesTraits = await traitsRes.json();
  const classFeatures = await classRes.json();

  allFeatures = [];

  feats.forEach(f => {
    allFeatures.push({
      name: f.name, description: f.description, source: 'feat',
      sourceDetail: f.category + (f.prerequisite ? ` (${f.prerequisite})` : '')
    });
  });

  for (const [species, traits] of Object.entries(speciesTraits)) {
    traits.forEach(t => {
      allFeatures.push({ name: t.name, description: t.description, source: 'species', sourceDetail: species });
    });
  }

  for (const [className, features] of Object.entries(classFeatures)) {
    features.forEach(f => {
      allFeatures.push({
        name: f.name, description: f.description, source: 'class',
        sourceDetail: `${className} (lvl ${f.level})`, _className: className, _level: f.level
      });
    });
  }

  allFeatures.forEach(f => {
    if (f.source === 'species') f._speciesName = f.sourceDetail;
  });
}

function filterFeatures() {
  const query = document.getElementById('feature-search').value.toLowerCase().trim();
  const sourceFilter = document.getElementById('feature-source-filter').value;
  const resultsEl = document.getElementById('feature-results');
  const charClass = document.getElementById('f-class').value;
  const charSpecies = document.getElementById('f-species').value;
  const charLevel = parseInt(document.getElementById('f-level').value) || 1;

  if (!query && !sourceFilter && !charClass && !charSpecies) {
    resultsEl.style.display = 'none';
    return;
  }

  let filtered = allFeatures.filter(f => {
    if (selectedFeatures.find(s => s.name === f.name && s.sourceDetail === f.sourceDetail)) return false;
    if (query && !f.name.toLowerCase().includes(query) && !f.description.toLowerCase().includes(query)) return false;
    if (sourceFilter && f.source !== sourceFilter) return false;
    if (!query) {
      if (f.source === 'class') return f._className === charClass && f._level <= charLevel;
      if (f.source === 'species') return f._speciesName === charSpecies;
      return f.source === 'feat';
    }
    return true;
  });

  filtered.sort((a, b) => {
    const aMatch = (a.source === 'class' && a._className === charClass) || (a.source === 'species' && a._speciesName === charSpecies);
    const bMatch = (b.source === 'class' && b._className === charClass) || (b.source === 'species' && b._speciesName === charSpecies);
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    if (a.source === 'class' && b.source === 'class') return (a._level || 0) - (b._level || 0);
    return 0;
  });

  filtered = filtered.slice(0, 50);
  if (filtered.length === 0) {
    resultsEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);">No features found.</div>';
  } else {
    resultsEl.innerHTML = filtered.map((f, i) => `
      <div class="search-menu-item" onclick="selectFeature(${i})" data-idx="${i}">
        <div>
          <strong>${esc(f.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:8px;">${esc(f.sourceDetail)}</span>
        </div>
        <span class="badge badge-sm badge-ghost">${f.source}</span>
      </div>
    `).join('');
    resultsEl._filtered = filtered;
  }
  resultsEl.style.display = '';
}

function selectFeature(idx) {
  const resultsEl = document.getElementById('feature-results');
  const f = resultsEl._filtered[idx];
  if (!f || selectedFeatures.find(s => s.name === f.name && s.sourceDetail === f.sourceDetail)) return;
  selectedFeatures.push(f);
  renderSelectedFeatures();
  filterFeatures();
}

function removeFeature(idx) {
  selectedFeatures.splice(idx, 1);
  renderSelectedFeatures();
  filterFeatures();
}

function updateCustomFeature(idx, input) { selectedFeatures[idx].name = input.value.trim(); }
function updateCustomFeatureDesc(idx, input) { selectedFeatures[idx].description = input.value.trim(); }

function addCustomFeature() {
  selectedFeatures.push({ name: '', description: '', source: 'custom', sourceDetail: 'Custom', _editing: true });
  renderSelectedFeatures();
  const inputs = document.querySelectorAll('#features-selected .feat-name');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function renderSelectedFeatures() {
  const container = document.getElementById('features-selected');
  const countEl = document.getElementById('features-count');
  if (selectedFeatures.length === 0) { container.innerHTML = ''; if (countEl) countEl.style.display = 'none'; return; }
  if (countEl) { countEl.textContent = selectedFeatures.length; countEl.style.display = ''; }
  container.innerHTML = selectedFeatures.map((f, i) => {
    if (f._editing) {
      return `
    <div class="list-item" style="flex-wrap:wrap;padding:8px 12px;">
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>Name</label><input type="text" class="input input-bordered input-sm feat-name" value="${esc(f.name)}" onchange="updateCustomFeature(${i}, this)" placeholder="Feature name"></div>
      <div class="form-group" style="flex:2;margin-bottom:0;"><label>Description</label><input type="text" class="input input-bordered input-sm feat-desc" value="${esc(f.description)}" onchange="updateCustomFeatureDesc(${i}, this)" placeholder="Description (optional)"></div>
      <button type="button" class="remove-item" onclick="removeFeature(${i})">&times;</button>
    </div>`;
    }
    return `
    <div class="list-item" style="flex-wrap:nowrap;align-items:center;padding:8px 12px;">
      <div style="flex:1;">
        <strong>${esc(f.name)}</strong>
        <span class="badge badge-sm badge-ghost" style="margin-left:6px;">${esc(f.sourceDetail)}</span>
        <div style="font-size:0.85rem;color:var(--text-muted);margin-top:2px;">${esc(f.description)}</div>
      </div>
      <button type="button" class="remove-item" onclick="removeFeature(${i})">&times;</button>
    </div>`;
  }).join('');
}

// --- Spells DB ---
async function loadSpellsDB() {
  try {
    const res = await fetch('data/srd-5.2-spells.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allSpells = await res.json();
  } catch (e) {
    console.error('Failed to load spells data:', e);
  }
}

function filterSpells() {
  const query = document.getElementById('spell-search').value.toLowerCase().trim();
  const levelFilter = document.getElementById('spell-level-filter').value;
  const classFilter = document.getElementById('spell-class-filter').value;
  const resultsEl = document.getElementById('spell-results');

  if (!query && !levelFilter && !classFilter) { resultsEl.style.display = 'none'; return; }

  let filtered = allSpells.filter(sp => {
    if (query && !sp.name.toLowerCase().includes(query)) return false;
    if (levelFilter !== '' && sp.level !== parseInt(levelFilter)) return false;
    if (classFilter && !sp.classes.includes(classFilter)) return false;
    if (selectedSpells.find(s => s.name === sp.name)) return false;
    return true;
  }).slice(0, 50);

  if (filtered.length === 0) {
    resultsEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);">No spells found.</div>';
  } else {
    resultsEl.innerHTML = filtered.map(sp => `
      <div class="search-menu-item" onclick="selectSpell('${esc(sp.name)}')">
        <div>
          <strong>${esc(sp.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:8px;">
            ${sp.level === 0 ? 'Cantrip' : 'Level ' + sp.level} ${esc(sp.school)}
          </span>
        </div>
        <span class="spell-classes-badge">${sp.classes.map(c => c.slice(0,3).toUpperCase()).join(' ')}</span>
      </div>
    `).join('');
  }
  resultsEl.style.display = '';
}

function selectSpell(name) {
  const spell = allSpells.find(s => s.name === name);
  if (!spell || selectedSpells.find(s => s.name === name)) return;
  selectedSpells.push(spell);
  renderSelectedSpells();
  filterSpells();
}

function removeSpell(name) {
  selectedSpells = selectedSpells.filter(s => s.name !== name);
  renderSelectedSpells();
  filterSpells();
}

function removeSpellByIndex(idx) {
  selectedSpells.splice(idx, 1);
  renderSelectedSpells();
  filterSpells();
}

function addCustomSpell() {
  selectedSpells.push({
    name: '', level: 0, school: 'Custom', description: '', actionType: '',
    castingTime: '', range: '', components: '', concentration: false, ritual: false, duration: '', _editing: true
  });
  renderSelectedSpells();
  const inputs = document.querySelectorAll('#spells-selected .spell-name');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function updateCustomSpellField(idx, field, input) {
  if (field === 'level') selectedSpells[idx].level = parseInt(input.value) || 0;
  else selectedSpells[idx][field] = input.value.trim();
}

function renderSelectedSpells() {
  const container = document.getElementById('spells-selected');
  const countEl = document.getElementById('spells-count');
  if (selectedSpells.length === 0) { container.innerHTML = ''; if (countEl) countEl.style.display = 'none'; return; }
  if (countEl) { countEl.textContent = selectedSpells.length; countEl.style.display = ''; }
  const byLevel = {};
  selectedSpells.forEach(sp => {
    const key = sp.level === 0 ? 'Cantrips' : `Level ${sp.level}`;
    if (!byLevel[key]) byLevel[key] = [];
    byLevel[key].push(sp);
  });
  let html = '';
  for (const [level, spells] of Object.entries(byLevel)) {
    html += `<div style="font-size:0.8rem;color:var(--text-muted);margin:8px 0 4px;font-weight:600;">${level}</div>`;
    html += spells.map(sp => {
      const idx = selectedSpells.indexOf(sp);
      if (sp._editing) {
        return `
      <div class="list-item" style="flex-wrap:wrap;padding:8px 12px;">
        <div class="form-group" style="flex:2;margin-bottom:0;"><label>Name</label><input type="text" class="input input-bordered input-sm spell-name" value="${esc(sp.name)}" onchange="updateCustomSpellField(${idx}, 'name', this)" placeholder="Spell name"></div>
        <div class="form-group" style="flex:0 0 70px;margin-bottom:0;"><label>Level</label><input type="number" class="input input-bordered input-sm" value="${sp.level}" min="0" max="9" onchange="updateCustomSpellField(${idx}, 'level', this)"></div>
        <div class="form-group" style="flex:2;margin-bottom:0;"><label>Description</label><input type="text" class="input input-bordered input-sm" value="${esc(sp.description)}" onchange="updateCustomSpellField(${idx}, 'description', this)" placeholder="Description (optional)"></div>
        <button type="button" class="remove-item" onclick="removeSpellByIndex(${idx})">&times;</button>
      </div>`;
      }
      return `
      <div class="list-item" style="flex-wrap:nowrap;align-items:center;padding:8px 12px;">
        <div style="flex:1;">
          <strong>${esc(sp.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(sp.school)} | ${esc(sp.actionType)} | ${esc(sp.range)}</span>
        </div>
        <button type="button" class="remove-item" onclick="removeSpell('${esc(sp.name)}')">&times;</button>
      </div>`;
    }).join('');
  }
  container.innerHTML = html;
}

// --- Saving Throws ---
function renderSavingThrows() {
  const container = document.getElementById('saving-throws-inputs');
  const cls = document.getElementById('f-class').value;
  const classSaves = CLASS_SAVING_THROWS[cls] || [];
  container.innerHTML = ABILITIES.map((a, i) => {
    const proficient = classSaves.includes(a);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;min-height:44px;">
        <span style="color:var(--accent);font-weight:600;min-width:14px;">${proficient ? '*' : ''}</span>
        <span style="flex:1;font-size:0.9rem;font-weight:500;">${a}</span>
        <span id="f-save-mod-${i}" class="ability-mod-badge" style="min-width:36px;text-align:center;">+0</span>
      </div>`;
  }).join('');
  updateSavingThrows();
}

function updateSavingThrows() {
  const profBonus = getProficiencyBonus();
  document.getElementById('save-prof-bonus-display').textContent = `(Proficiency Bonus: +${profBonus})`;
  const cls = document.getElementById('f-class').value;
  const classSaves = CLASS_SAVING_THROWS[cls] || [];
  ABILITIES.forEach((a, i) => {
    const abilityMod = getAbilityMod(a);
    const proficient = classSaves.includes(a);
    const total = abilityMod + (proficient ? profBonus : 0);
    const modEl = document.getElementById(`f-save-mod-${i}`);
    if (modEl) {
      modEl.textContent = total >= 0 ? `+${total}` : `${total}`;
      modEl.className = 'ability-mod-badge' + (total > 0 ? ' positive' : total < 0 ? ' negative' : '');
    }
  });
}

// --- Skills form fields ---
let _lastBgSkills = []; // track background-auto-checked skills for swap on change

function renderSkillInputs(proficiencies) {
  const container = document.getElementById('skills-inputs');
  const cls = document.getElementById('f-class').value;
  const bgSelect = document.getElementById('f-background');
  const background = bgSelect.value === '__custom__' ? '' : bgSelect.value;
  const classInfo = CLASS_SKILLS[cls];
  const bgSkills = BACKGROUND_SKILLS[background] || [];

  container.innerHTML = SKILL_ABILITIES.map((s, i) => {
    const checked = proficiencies && proficiencies[i] ? 'checked' : '';
    const isBg = bgSkills.includes(s.name);
    const isClassEligible = classInfo && (classInfo.choices === null || classInfo.choices.includes(s.name));
    const borderStyle = isBg
      ? 'border-left:3px solid var(--accent);'
      : isClassEligible
        ? 'border-left:3px solid #b8860b;'
        : '';
    const tag = isBg ? '<span style="font-size:0.65rem;color:var(--accent);margin-left:4px;font-style:italic;">BG</span>' : '';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;min-height:44px;${borderStyle}">
        <input type="checkbox" id="f-skill-prof-${i}" ${checked} onchange="updateSkillModifiers()">
        <span style="flex:1;font-size:0.9rem;font-weight:500;">${s.name}${tag}</span>
        <span style="color:var(--text-muted);font-size:0.75rem;white-space:nowrap;">${s.ability}</span>
        <span id="f-skill-mod-${i}" class="ability-mod-badge" style="min-width:36px;text-align:center;">+0</span>
      </div>`;
  }).join('');
  updateSkillModifiers();
  updateSkillGuidance();
}

function updateSkillModifiers() {
  const profBonus = getProficiencyBonus();
  document.getElementById('prof-bonus-display').textContent = `(Proficiency Bonus: +${profBonus})`;
  SKILL_ABILITIES.forEach((s, i) => {
    const abilityMod = getAbilityMod(s.ability);
    const proficient = document.getElementById(`f-skill-prof-${i}`)?.checked || false;
    const total = abilityMod + (proficient ? profBonus : 0);
    const modEl = document.getElementById(`f-skill-mod-${i}`);
    if (modEl) {
      modEl.textContent = total >= 0 ? `+${total}` : `${total}`;
      modEl.className = 'ability-mod-badge' + (total > 0 ? ' positive' : total < 0 ? ' negative' : '');
    }
  });
}

function updateSkillGuidance() {
  const infoEl = document.getElementById('skills-info');
  if (!infoEl) return;
  const cls = document.getElementById('f-class').value;
  const bgSelect = document.getElementById('f-background');
  const background = bgSelect.value === '__custom__' ? '' : bgSelect.value;
  const classInfo = CLASS_SKILLS[cls];
  const bgSkills = BACKGROUND_SKILLS[background] || [];
  const parts = [];

  if (bgSkills.length) {
    parts.push(`<span style="color:var(--accent);"><b>${esc(background)}</b> grants: ${bgSkills.join(', ')}</span>`);
  }
  if (classInfo) {
    const choiceText = classInfo.choices === null
      ? 'any skill'
      : classInfo.choices.join(', ');
    parts.push(`<span style="color:#b8860b;"><b>${esc(cls)}</b>: Choose ${classInfo.count} from ${choiceText}</span>`);
  }
  infoEl.innerHTML = parts.length ? parts.join('<br>') : '';
}

function autoPopulateSkills() {
  const bgSelect = document.getElementById('f-background');
  const background = bgSelect.value === '__custom__' ? '' : bgSelect.value;
  const newBgSkills = BACKGROUND_SKILLS[background] || [];

  // Uncheck previously auto-set background skills
  _lastBgSkills.forEach(skillName => {
    const idx = SKILL_ABILITIES.findIndex(s => s.name === skillName);
    if (idx >= 0) {
      const cb = document.getElementById(`f-skill-prof-${idx}`);
      if (cb) cb.checked = false;
    }
  });

  // Check new background skills
  newBgSkills.forEach(skillName => {
    const idx = SKILL_ABILITIES.findIndex(s => s.name === skillName);
    if (idx >= 0) {
      const cb = document.getElementById(`f-skill-prof-${idx}`);
      if (cb) cb.checked = true;
    }
  });

  _lastBgSkills = [...newBgSkills];
  updateSkillModifiers();
  // Re-render to update visual indicators
  const proficiencies = SKILL_ABILITIES.map((_, i) => document.getElementById(`f-skill-prof-${i}`)?.checked || false);
  renderSkillInputs(proficiencies);
}

// --- Characters (IndexedDB) ---
async function loadCharacters() {
  const chars = await db.getAllCharacters();
  allCharacters = chars;
  renderCharacterList(chars);
  renderTreasures();
  renderShops();
}

function renderCharacterList(chars) {
  const container = document.getElementById('char-list');
  if (chars.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">No characters yet. Click &ldquo;+ New Character&rdquo; to create one, or use the menu to import from a TOML file.</p>';
    return;
  }
  container.innerHTML = chars.map(c => `
    <div class="char-item" onclick="openCharacterPreview('${c._id}')">
      <div class="char-info">
        <span class="char-name">${esc(c.name)}</span>
        <span class="char-meta">Level ${c.level} ${esc(c.species || '')} ${esc(c.class)} — HP ${c.HP} / AC ${c.AC}</span>
      </div>
      <div class="char-item-actions" style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" style="font-size:0.72rem;" onclick="event.stopPropagation();openCharModal('${c._id}')" title="Edit character">Edit</button>
        ${c.level < 20 ? `<button class="btn btn-secondary btn-small" style="font-size:0.72rem;padding:0.2rem 0.5rem;min-height:1.6rem;" onclick="event.stopPropagation();openLevelUpModal('${c._id}')" title="Level Up">Lvl Up</button>` : ''}
        <button class="remove-item" onclick="event.stopPropagation();deleteCharacter('${c._id}')" title="Delete">&times;</button>
      </div>
    </div>
  `).join('');
}

let _currentPreviewCharacter = null;

function encodeCharacterForUrl(character) {
  const json = JSON.stringify(character);
  try {
    return encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
  } catch (err) {
    return encodeURIComponent(json);
  }
}

function decodeCharacterFromUrl(encoded) {
  try {
    const decoded = decodeURIComponent(atob(decodeURIComponent(encoded)));
    return JSON.parse(decoded);
  } catch (err) {
    return JSON.parse(decodeURIComponent(encoded));
  }
}

function getCharacterShareUrl(character) {
  const encoded = encodeCharacterForUrl(character);
  const playerUrl = new URL('player.html', window.location.href);
  playerUrl.searchParams.set('shared', encoded);
  return playerUrl.toString();
}

function openCharacterPreview(id) {
  const char = allCharacters.find(c => c._id === id);
  if (!char) {
    dialogAlert('Character not found.', 'Error', 'error');
    return;
  }
  _currentPreviewCharacter = char;
  const shareUrl = getCharacterShareUrl(char);
  const previewModal = document.getElementById('char-preview-modal');
  const iframe = document.getElementById('char-preview-iframe');
  if (!previewModal || !iframe) return;
  iframe.src = shareUrl;
  previewModal.showModal();
}

function copyCharacterShareLink(id) {
  const char = allCharacters.find(c => c._id === id);
  if (!char) {
    dialogAlert('Character not found.', 'Error', 'error');
    return;
  }
  const url = getCharacterShareUrl(char);
  navigator.clipboard.writeText(url).then(() => {
    showToast('Share link copied to clipboard.');
  }).catch(() => {
    dialogAlert('Could not copy link. Please copy manually from the preview link.', 'Error', 'error');
  });
}

function copyCurrentPreviewLink() {
  if (!_currentPreviewCharacter) return;
  const url = getCharacterShareUrl(_currentPreviewCharacter);
  navigator.clipboard.writeText(url).then(() => {
    showToast('Share link copied to clipboard.');
  }).catch(() => {
    dialogAlert('Could not copy link. Please copy manually from the preview link.', 'Error', 'error');
  });
}

function openCharacterPreviewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('preview');
  if (!encoded) return;
  let char;
  try {
    char = decodeCharacterFromUrl(encoded);
  } catch (err) {
    console.error('Invalid preview parameter:', err);
    return;
  }
  _currentPreviewCharacter = char;
  const shareUrl = getCharacterShareUrl(char);
  const previewModal = document.getElementById('char-preview-modal');
  const iframe = document.getElementById('char-preview-iframe');
  if (!previewModal || !iframe) return;
  iframe.src = shareUrl;
  previewModal.showModal();
}

// --- Character Modal ---
async function openCharModal(id) {
  const modal = document.getElementById('char-modal');
  const form = document.getElementById('char-form');
  form.reset();
  document.getElementById('char-edit-id').value = '';
  document.getElementById('equipment-list').innerHTML = '';
  document.getElementById('equip-search').value = '';
  document.getElementById('equip-type-filter').value = '';
  document.getElementById('equip-results').style.display = 'none';
  document.getElementById('f-class-custom').style.display = 'none';
  document.getElementById('f-class-custom').value = '';
  document.getElementById('f-species-custom').style.display = 'none';
  document.getElementById('f-species-custom').value = '';
  document.getElementById('f-background-custom').style.display = 'none';
  document.getElementById('f-background-custom').value = '';
  ['cp','sp','ep','gp','pp'].forEach(k => { document.getElementById(`f-${k}`).value = 0; });
  selectedSpells = [];
  renderSelectedSpells();
  document.getElementById('spell-search').value = '';
  document.getElementById('spell-level-filter').value = '';
  document.getElementById('spell-class-filter').value = '';
  document.getElementById('spell-results').style.display = 'none';
  selectedFeatures = [];
  _lastBgSkills = [];
  renderSelectedFeatures();
  document.getElementById('feature-search').value = '';
  document.getElementById('feature-source-filter').value = '';
  document.getElementById('feature-results').style.display = 'none';
  renderSavingThrows();
  renderSkillInputs();
  updateAbilityModBadges();
  updateEquipmentCount();

  if (id) {
    document.getElementById('char-modal-title').textContent = 'Edit Character';
    const c = await db.getCharacter(id);
    if (!c) return;
    document.getElementById('char-edit-id').value = id;
    document.getElementById('f-name').value = c.name || '';
    const classVal = c.class || '';
    const classSelectEl = document.getElementById('f-class');
    const classCustomEl = document.getElementById('f-class-custom');
    if (classVal && !CLASSES.includes(classVal)) {
      classSelectEl.value = '__custom__';
      classCustomEl.style.display = '';
      classCustomEl.value = classVal;
    } else {
      classSelectEl.value = classVal;
      classCustomEl.style.display = 'none';
      classCustomEl.value = '';
    }
    const speciesVal = c.species || '';
    const speciesSelectEl = document.getElementById('f-species');
    const speciesCustomEl = document.getElementById('f-species-custom');
    if (speciesVal && !SPECIES.includes(speciesVal)) {
      speciesSelectEl.value = '__custom__';
      speciesCustomEl.style.display = '';
      speciesCustomEl.value = speciesVal;
    } else {
      speciesSelectEl.value = speciesVal;
      speciesCustomEl.style.display = 'none';
      speciesCustomEl.value = '';
    }
    document.getElementById('f-level').value = c.level || 1;
    const bgVal = c.background || '';
    const bgSelect = document.getElementById('f-background');
    const bgCustom = document.getElementById('f-background-custom');
    if (bgVal && !BACKGROUNDS.includes(bgVal)) {
      bgSelect.value = '__custom__';
      bgCustom.style.display = '';
      bgCustom.value = bgVal;
    } else {
      bgSelect.value = bgVal;
      bgCustom.style.display = 'none';
      bgCustom.value = '';
    }
    document.getElementById('f-hp').value = c.HP || 10;
    document.getElementById('f-ac').value = c.AC || 10;
    ['STR','DEX','CON','INT','WIS','CHA'].forEach(a => {
      document.getElementById(`f-${a}`).value = c[a] || 10;
    });
    renderSavingThrows();
    renderSkillInputs(c.skills || []);
    updateAbilityModBadges();
    if (c.features) {
      c.features.forEach(f => {
        if (typeof f === 'string') {
          selectedFeatures.push({ name: f, description: '', source: '', sourceDetail: '' });
        } else {
          if (f.source === 'custom') f._editing = true;
          selectedFeatures.push(f);
        }
      });
      renderSelectedFeatures();
    }
    const cur = c.currency || {};
    ['cp','sp','ep','gp','pp'].forEach(k => {
      document.getElementById(`f-${k}`).value = cur[k.toUpperCase()] || 0;
    });
    (c.equipment || []).forEach(eq => addEquipmentRow(eq));
    if (c.spells) {
      c.spells.forEach(sp => {
        const dbSpell = allSpells.find(s => s.name === sp.name);
        const spell = dbSpell || sp;
        if (!dbSpell && sp.school === 'Custom') spell._editing = true;
        selectedSpells.push(spell);
      });
      renderSelectedSpells();
    }
  } else {
    document.getElementById('char-modal-title').textContent = 'New Character';
  }
  setAbilityMethod('manual');
  updateHPBreakdown();
  applySmartSpellFilters();
  modal.showModal();
}

function closeCharModal() {
  document.getElementById('char-modal').close();
}

async function saveCharacter(e) {
  e.preventDefault();
  const id = document.getElementById('char-edit-id').value;
  if (document.getElementById('f-class').value === '__custom__' && !document.getElementById('f-class-custom').value.trim()) {
    showToast('Please enter a custom class name'); return;
  }
  if (document.getElementById('f-species').value === '__custom__' && !document.getElementById('f-species-custom').value.trim()) {
    showToast('Please enter a custom species name'); return;
  }
  const character = {
    name: document.getElementById('f-name').value,
    class: document.getElementById('f-class').value === '__custom__'
      ? document.getElementById('f-class-custom').value
      : document.getElementById('f-class').value,
    species: document.getElementById('f-species').value === '__custom__'
      ? document.getElementById('f-species-custom').value
      : document.getElementById('f-species').value,
    level: parseInt(document.getElementById('f-level').value),
    background: document.getElementById('f-background').value === '__custom__'
      ? document.getElementById('f-background-custom').value
      : document.getElementById('f-background').value,
    HP: parseInt(document.getElementById('f-hp').value),
    AC: parseInt(document.getElementById('f-ac').value),
    STR: parseInt(document.getElementById('f-STR').value),
    DEX: parseInt(document.getElementById('f-DEX').value),
    CON: parseInt(document.getElementById('f-CON').value),
    INT: parseInt(document.getElementById('f-INT').value),
    WIS: parseInt(document.getElementById('f-WIS').value),
    CHA: parseInt(document.getElementById('f-CHA').value),
    skills: SKILL_ABILITIES.map((_, i) => document.getElementById(`f-skill-prof-${i}`).checked),
    features: selectedFeatures.map(f => ({ name: f.name, description: f.description, source: f.source, sourceDetail: f.sourceDetail })),
    currency: {
      CP: parseInt(document.getElementById('f-cp').value) || 0,
      SP: parseInt(document.getElementById('f-sp').value) || 0,
      EP: parseInt(document.getElementById('f-ep').value) || 0,
      GP: parseInt(document.getElementById('f-gp').value) || 0,
      PP: parseInt(document.getElementById('f-pp').value) || 0
    },
    equipment: collectEquipment(),
    spells: selectedSpells.map(sp => ({
      name: sp.name, level: sp.level, school: sp.school, description: sp.description,
      castingTime: sp.actionType || sp.castingTime || '', range: sp.range || '',
      components: Array.isArray(sp.components) ? sp.components.join(', ').toUpperCase() : (sp.components || ''),
      concentration: sp.concentration || false, ritual: sp.ritual || false, duration: sp.duration || ''
    }))
  };

  if (id) character._id = id;

  try {
    const saved = await db.putCharacter(character);
    closeCharModal();
    loadCharacters();
    // Broadcast to player if connected
    broadcastCharacterToPlayer(saved._id);
  } catch (err) {
    dialogAlert(err.message, 'Save Error', 'error');
  }
}

async function deleteCharacter(id) {
  const isClaimed = currentSession && currentSession.characters[id]?.claimedBy;
  const msg = isClaimed
    ? 'This character is currently claimed by a player. Deleting it will remove them from the session. Continue?'
    : 'Delete this character?';
  if (!await dialogConfirm(msg, 'Delete Character')) return;
  await db.deleteCharacter(id);
  if (currentSession && currentSession.characters[id]) {
    delete currentSession.characters[id];
    renderBattlefieldCharacters();
  }
  loadCharacters();
}

// --- Equipment DB & Picker ---
async function loadEquipmentDB() {
  try {
    const res = await fetch('data/srd-5.2-equipment.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allEquipment = await res.json();
  } catch (e) {
    console.error('Failed to load equipment data:', e);
  }
}

function filterEquipment() {
  const query = document.getElementById('equip-search').value.trim().toLowerCase();
  const typeFilter = document.getElementById('equip-type-filter').value;
  const resultsEl = document.getElementById('equip-results');

  if (!query && !typeFilter) { resultsEl.style.display = 'none'; return; }

  let filtered = allEquipment;
  if (typeFilter) filtered = filtered.filter(e => e.type === typeFilter);
  if (query) filtered = filtered.filter(e =>
    e.name.toLowerCase().includes(query) || (e.category && e.category.toLowerCase().includes(query))
  );

  resultsEl.style.display = '';
  resultsEl.innerHTML = filtered.slice(0, 50).map((e, i) => {
    let detail = e.category || '';
    if (e.damage) detail += ` | ${e.damage}`;
    if (e.AC) detail += ` | AC: ${e.AC}`;
    if (e.cost) detail += ` | ${e.cost}`;
    if (e.properties && e.properties !== '—') detail += ` | ${e.properties}`;
    return `
      <div class="search-menu-item" onclick="selectEquipment(${i}, this)">
        <div>
          <strong>${esc(e.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(detail)}</span>
        </div>
      </div>
    `;
  }).join('') || '<div style="padding:8px;color:var(--text-muted);">No items found</div>';
  resultsEl._filtered = filtered;
}

function selectEquipment(idx, el) {
  const resultsEl = document.getElementById('equip-results');
  const e = resultsEl._filtered[idx];
  if (!e) return;
  let desc = '';
  if (e.damage) desc += e.damage;
  if (e.AC) desc += (desc ? ' | ' : '') + 'AC: ' + e.AC;
  if (e.properties && e.properties !== '—') desc += (desc ? ' | ' : '') + e.properties;
  if (e.weight && e.weight !== '—') desc += (desc ? ' | ' : '') + e.weight;
  if (e.cost) desc += (desc ? ' | ' : '') + e.cost;
  addEquipmentRow({ name: e.name, type: e.category || e.type, description: desc, quantity: 1 });
}

function addEquipmentRow(data) {
  const container = document.getElementById('equipment-list');
  const div = document.createElement('div');
  div.className = 'list-item';
  div.style.cssText = 'display:block;padding:10px 12px;';
  div.innerHTML = `
    <div class="eq-item-grid">
      <div class="form-group" style="margin-bottom:0;"><label>Name</label><input type="text" class="input input-bordered input-sm eq-name" value="${esc(data?.name || '')}"></div>
      <div class="form-group" style="margin-bottom:0;"><label>Type</label><input type="text" class="input input-bordered input-sm eq-type" value="${esc(data?.type || '')}"></div>
      <div class="form-group" style="margin-bottom:0;"><label>Qty</label><input type="number" class="input input-bordered input-sm eq-qty" value="${data?.quantity || 1}" min="0"></div>
      <button type="button" class="remove-item" style="margin-top:20px;" onclick="this.closest('.list-item').remove();updateEquipmentCount()">&times;</button>
    </div>
    <div class="form-group" style="margin-bottom:0;"><label>Description</label><input type="text" class="input input-bordered input-sm eq-desc" value="${esc(data?.description || '')}"></div>
  `;
  container.appendChild(div);
  updateEquipmentCount();
}

function updateEquipmentCount() {
  const countEl = document.getElementById('equipment-count');
  const count = document.querySelectorAll('#equipment-list .list-item').length;
  if (countEl) {
    if (count > 0) { countEl.textContent = count; countEl.style.display = ''; }
    else { countEl.style.display = 'none'; }
  }
}

function collectEquipment() {
  const items = [];
  document.querySelectorAll('#equipment-list .list-item').forEach(row => {
    const name = row.querySelector('.eq-name').value.trim();
    if (!name) return;
    items.push({
      name, type: row.querySelector('.eq-type').value.trim(),
      description: row.querySelector('.eq-desc').value.trim(),
      quantity: parseInt(row.querySelector('.eq-qty').value) || 1
    });
  });
  return items;
}

// --- Sessions (PeerJS) ---
async function createSession() {
  const pin = await dialogPrompt('Set a PIN for players to join (min 3 characters, alphanumeric):', 'Start Session');
  if (!pin) return;
  if (pin.length < 3) { dialogAlert('PIN must be at least 3 characters.', 'Invalid PIN', 'error'); return; }
  if (!/^[a-zA-Z0-9]+$/.test(pin)) { dialogAlert('PIN must be alphanumeric.', 'Invalid PIN', 'error'); return; }

  await db.savePin(pin);
  const roomId = await db.ensureRoomId();

  // Build session characters from all characters
  const chars = await db.getAllCharacters();
  const characters = {};
  chars.forEach(c => {
    characters[c._id] = { claimedBy: null, onBattlefield: battlefieldPCIds.includes(c._id) };
  });
  currentSession = { pin, characters };

  // Initialize PeerJS
  try {
    dmPeer = peerManager.createDMPeer(roomId);
    await dmPeer.init();
    setupPeerHandlers();
    showSessionActive();
    showQR();
    updatePeerStatus();
  } catch (err) {
    dialogAlert('Failed to start session: ' + err.message, 'Session Error', 'error');
    currentSession = null;
    document.getElementById('session-toggle').checked = false;
  }
}


function setupPeerHandlers() {
  dmPeer.onPlayerMessage(async (peerId, msg) => {
    if (msg.type === 'join') {
      const storedPin = await db.getPin();
      if (msg.pin !== storedPin) {
        dmPeer.sendToPlayer(peerId, { type: 'join-error', error: 'Invalid PIN' });
        return;
      }
      // Send character list — mark characters as claimed only if the claimer's
      // connection is still alive (handles phone backgrounding / stale WebRTC).
      const chars = await db.getAllCharacters();
      const connectedPeers = dmPeer.getConnectedPlayers();
      const charList = chars.map(c => {
        const entry = currentSession.characters[c._id];
        let claimed = entry?.claimedBy || null;
        // If claimer's connection is dead, report as unclaimed so the picker
        // shows it as available and auto-reclaim can proceed.
        if (claimed) {
          const claimerAlive = connectedPeers.some(
            p => p.characterId === c._id && p.alive && p.peerId !== peerId
          );
          if (!claimerAlive) claimed = null;
        }
        return {
          _id: c._id, name: c.name, class: c.class, species: c.species, level: c.level,
          claimed
        };
      });
      dmPeer.sendToPlayer(peerId, { type: 'join-ok', characters: charList });
    } else if (msg.type === 'claim') {
      const { characterId, playerName } = msg;
      const charEntry = currentSession.characters[characterId];
      if (!charEntry) {
        dmPeer.sendToPlayer(peerId, { type: 'claim-error', error: 'Character not in session' });
        return;
      }
      if (charEntry.claimedBy) {
        // Allow reclaim if the previous claimer is no longer connected or their
        // connection is stale (e.g. phone backgrounded, WebRTC died silently).
        const connectedPeers = dmPeer.getConnectedPlayers();
        const claimerStillConnected = connectedPeers.some(
          p => p.characterId === characterId && p.peerId !== peerId && p.alive
        );
        if (claimerStillConnected) {
          dmPeer.sendToPlayer(peerId, { type: 'claim-error', error: 'Character already claimed' });
          return;
        }
        // Previous claimer disconnected or connection dead — allow reclaim.
      }
      charEntry.claimedBy = playerName;
      charEntry.onBattlefield = true;
      if (!battlefieldPCIds.includes(characterId)) battlefieldPCIds.push(characterId);
      saveBattlefieldPCIds();
      dmPeer.setPlayerInfo(peerId, playerName, characterId);

      // Send full character data
      const c = await db.getCharacter(characterId);
      const hpState = characterHPState[characterId] || { currentHP: c.HP, tempHP: 0 };
      dmPeer.sendToPlayer(peerId, { type: 'claim-ok', characterId, character: c, hpState });

      // Refresh battlefield characters section
      renderBattlefieldCharacters();
      updatePeerStatus();
    } else if (msg.type === 'ping') {
      // pong is sent automatically by peer.js — nothing else to do here
    }
  });

  dmPeer.onPlayerDisconnect((peerId, info) => {
    if (!currentSession) { updatePeerStatus(); return; }
    let changed = false;
    // Unclaim via tracked characterId (fast path).
    if (info && info.characterId) {
      const entry = currentSession.characters[info.characterId];
      if (entry && entry.claimedBy) {
        entry.claimedBy = null;
        changed = true;
      }
    }
    // Also scan all characters for claims by this peer's playerName
    // in case info.characterId was missing (e.g. stale connection cleanup).
    if (info && info.playerName) {
      for (const entry of Object.values(currentSession.characters)) {
        if (entry.claimedBy === info.playerName) {
          entry.claimedBy = null;
          changed = true;
        }
      }
    }
    if (changed) renderBattlefieldCharacters();
    updatePeerStatus();
  });

  dmPeer.onPlayerConnect((peerId) => {
    updatePeerStatus();
  });

  // Show a notice in the session status if the DM loses signaling server connectivity.
  dmPeer.onSignalingDisconnect(() => {
    if (currentSession) setSessionPill('Session active — reconnecting…', true);
  });

  dmPeer.onSignalingReconnect(() => {
    if (currentSession) updatePeerStatus();
  });
}

function updatePeerStatus() {
  if (!currentSession) return;
  const players = dmPeer ? dmPeer.getConnectedPlayers() : [];
  const count = players.length;
  setSessionPill(`Session active · ${count} player${count !== 1 ? 's' : ''}`, true);
}

function setSessionPill(text, active) {
  const el = document.getElementById('session-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('pill-active', active);
  el.classList.toggle('pill-inactive', !active);
}

function showSessionActive() {
  updatePeerStatus();
  document.getElementById('session-toggle').checked = true;
  document.getElementById('btn-show-qr').style.display = '';
  renderBattlefieldCharacters();
}

async function endSession() {
  if (!await dialogConfirm('End the current session? Players will be disconnected.', 'End Session')) {
    document.getElementById('session-toggle').checked = true;
    return;
  }
  if (dmPeer) { dmPeer.destroy(); dmPeer = null; }
  currentSession = null;
  setSessionPill('No active session', false);
  document.getElementById('session-toggle').checked = false;
  document.getElementById('btn-show-qr').style.display = 'none';
  renderBattlefieldCharacters();
}

async function handleSessionToggle() {
  const toggle = document.getElementById('session-toggle');
  if (toggle.checked) {
    toggle.checked = false; // showSessionActive will re-check on success
    await createSession();
  } else {
    toggle.checked = true; // endSession will uncheck if confirmed
    await endSession();
  }
}

async function showQR() {
  if (!currentSession) return;
  const roomId = await db.ensureRoomId();
  const protocol = window.location.protocol;
  const host = window.location.host;
  const url = `${protocol}//${host}${window.location.pathname.replace(/\/[^/]*$/, '')}/player.html?room=${roomId}`;

  QRCode.toCanvas(document.getElementById('qr-canvas'), url, { width: 256, margin: 2 });
  document.getElementById('qr-url').textContent = url;
  document.getElementById('qr-pin').textContent = currentSession.pin;
  document.getElementById('qr-modal').showModal();
}

function copySessionUrl() {
  const url = document.getElementById('qr-url').textContent;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy-url');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    dialogAlert('Could not copy URL. Please copy it manually.', 'Copy Failed', 'warn');
  });
}

// Broadcast character update to connected player
async function broadcastCharacterToPlayer(characterId) {
  if (!dmPeer) return;
  const c = await db.getCharacter(characterId);
  if (!c) return;
  const hpState = characterHPState[characterId] || { currentHP: c.HP, tempHP: 0 };
  dmPeer.broadcastToCharacter(characterId, { type: 'character-update', characterId, character: c, hpState });
}

// --- Monsters & Battlefield ---
let _bfUid = 0;

async function loadMonstersDB() {
  try {
    const res = await fetch('data/srd-5.2-monsters.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allMonsters = await res.json();
  } catch (e) {
    console.error('Failed to load monsters data:', e);
    return;
  }

  const types = [...new Set(allMonsters.map(m => m.type).filter(Boolean))].sort();
  const typeSelect = document.getElementById('monster-type-filter');
  types.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    typeSelect.appendChild(opt);
  });

  const crOrder = ['0','1/8','1/4','1/2','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30'];
  const crs = [...new Set(allMonsters.map(m => String(m.CR)).filter(Boolean))];
  crs.sort((a, b) => crOrder.indexOf(a) - crOrder.indexOf(b));
  const crSelect = document.getElementById('monster-cr-filter');
  crs.forEach(cr => {
    const opt = document.createElement('option');
    opt.value = cr; opt.textContent = `CR ${cr}`;
    crSelect.appendChild(opt);
  });
}

function filterMonsters() {
  const query = document.getElementById('monster-search').value.trim().toLowerCase();
  const typeFilter = document.getElementById('monster-type-filter').value;
  const crFilter = document.getElementById('monster-cr-filter').value;
  const resultsEl = document.getElementById('monster-results');

  if (!query && !typeFilter && !crFilter) { resultsEl.style.display = 'none'; return; }

  let filtered = allMonsters;
  if (typeFilter) filtered = filtered.filter(m => m.type === typeFilter);
  if (crFilter) filtered = filtered.filter(m => String(m.CR) === crFilter);
  if (query) filtered = filtered.filter(m => m.name.toLowerCase().includes(query));

  resultsEl.style.display = '';
  resultsEl.innerHTML = filtered.slice(0, 50).map((m, i) => {
    const meta = [m.size, m.type, `CR ${m.CR}`, `HP ${m.HP}`, `AC ${m.AC}`].filter(Boolean).join(' | ');
    return `
      <div class="list-item" style="cursor:pointer;justify-content:space-between;" onclick="addToBattlefield(${allMonsters.indexOf(m)})">
        <div>
          <strong>${esc(m.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(meta)}</span>
        </div>
        <span style="color:var(--gold);font-size:0.85rem;">+ Add</span>
      </div>
    `;
  }).join('') || '<div style="padding:8px;color:var(--text-muted);">No monsters found</div>';
}

async function loadBattlefield() {
  try {
    const saved = await db.getBattlefield();
    battlefieldPCIds = (await db.getState('battlefieldPCs')) || [];
    battlefieldMonsters = [];
    saved.forEach(entry => {
      if (entry._custom) {
        battlefieldMonsters.push({
          ...entry, _uid: ++_bfUid, _editing: false,
          currentHP: entry.currentHP != null ? entry.currentHP : entry.HP
        });
        return;
      }
      const m = allMonsters.find(m => m.name === entry.name);
      if (!m) return;
      battlefieldMonsters.push({
        ...m, _uid: ++_bfUid, _label: entry._label || m.name,
        currentHP: entry.currentHP != null ? entry.currentHP : m.HP
      });
    });
    relabelBattlefield();
    renderBattlefield();
  } catch (e) { console.error('Error loading battlefield:', e); }
}

function saveBattlefield() {
  const compact = battlefieldMonsters.map(m => {
    if (m._custom) {
      return { name: m.name, _label: m._label, currentHP: m.currentHP, _custom: true,
        size: m.size, type: m.type, AC: m.AC, HP: m.HP, CR: m.CR,
        STR: m.STR, DEX: m.DEX, CON: m.CON, INT: m.INT, WIS: m.WIS, CHA: m.CHA,
        actions: m.actions || [], traits: m.traits || [] };
    }
    return { name: m.name, _label: m._label, currentHP: m.currentHP };
  });
  db.saveBattlefield(compact);
}

function saveBattlefieldPCIds() {
  db.putState('battlefieldPCs', battlefieldPCIds);
}

function openAddPCModal() {
  const available = allCharacters.filter(c => !battlefieldPCIds.includes(c._id));
  if (available.length === 0) { dialogAlert('All characters are already on the battlefield.', 'Info', 'info'); return; }
  const list = document.getElementById('add-pc-list');
  list.innerHTML = available.map(c => `
    <li>
      <button class="btn btn-secondary btn-small" style="width:100%;text-align:left;justify-content:flex-start;"
        onclick="addPCToBattlefield('${esc(c._id)}')">
        ${esc(c.name)} <span style="opacity:0.6;font-size:0.85em;margin-left:0.5rem;">${esc(c.class)} ${c.level}</span>
      </button>
    </li>`).join('');
  document.getElementById('add-pc-modal').showModal();
}

function addPCToBattlefield(characterId) {
  if (!characterId) return;
  if (!battlefieldPCIds.includes(characterId)) battlefieldPCIds.push(characterId);
  if (currentSession) {
    if (!currentSession.characters[characterId]) {
      currentSession.characters[characterId] = { claimedBy: null, onBattlefield: false };
    }
    currentSession.characters[characterId].onBattlefield = true;
  }
  saveBattlefieldPCIds();
  renderBattlefieldCharacters();
  document.getElementById('add-pc-modal').close();
}

function removePCFromBattlefield(characterId) {
  battlefieldPCIds = battlefieldPCIds.filter(id => id !== characterId);
  if (currentSession && currentSession.characters[characterId]) {
    currentSession.characters[characterId].onBattlefield = false;
    currentSession.characters[characterId].claimedBy = null;
  }
  saveBattlefieldPCIds();
  renderBattlefieldCharacters();
}

function relabelBattlefield() {
  const nameCounts = {};
  battlefieldMonsters.forEach(m => { nameCounts[m.name] = (nameCounts[m.name] || 0) + 1; });
  for (const name of Object.keys(nameCounts)) {
    const instances = battlefieldMonsters.filter(b => b.name === name);
    if (instances.length === 1) { instances[0]._label = name; }
    else { instances.forEach((inst, i) => { inst._label = `${name} #${i + 1}`; }); }
  }
}

function addToBattlefield(idx) {
  const m = allMonsters[idx];
  if (!m) return;
  battlefieldMonsters.push({ ...m, _uid: ++_bfUid, _label: m.name, currentHP: m.HP });
  relabelBattlefield();
  renderBattlefield();
  saveBattlefield();
  showToast(`${m.name} added to battlefield`);
}

function addCustomMonster() {
  if (battlefieldMonsters.length >= 50) { dialogAlert('Battlefield limit reached (max 50).', 'Limit Reached', 'error'); return; }
  const m = {
    name: '', size: 'Medium', type: 'Custom', AC: 10, HP: 10, CR: '0',
    STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10,
    actions: [], traits: [], _custom: true, _editing: true,
    _uid: ++_bfUid, _label: '', currentHP: 10
  };
  battlefieldMonsters.push(m);
  renderBattlefield();
  saveBattlefield();
  setTimeout(() => {
    const input = document.querySelector(`.bf-card[data-uid="${m._uid}"] .bf-custom-name`);
    if (input) input.focus();
  }, 50);
}

function editCustomMonster(uid) {
  const m = battlefieldMonsters.find(b => b._uid === uid);
  if (!m || !m._custom) return;
  m._editing = true;
  renderBattlefield();
}

function updateCustomMonster(uid, field, value) {
  const m = battlefieldMonsters.find(b => b._uid === uid);
  if (!m || !m._custom) return;
  if (['AC', 'HP', 'STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].includes(field)) {
    m[field] = Math.max(1, parseInt(value) || 1);
    if (field === 'HP') m.currentHP = m.HP;
  } else {
    m[field] = value;
  }
  if (field === 'name') { m._label = value; relabelBattlefield(); }
  saveBattlefield();
}

function finishCustomMonster(uid) {
  const m = battlefieldMonsters.find(b => b._uid === uid);
  if (!m || !m._custom) return;
  if (!m.name.trim()) { dialogAlert('Please enter a monster name.', 'Custom Monster', 'info'); return; }
  m._editing = false;
  relabelBattlefield();
  renderBattlefield();
  saveBattlefield();
}

function removeFromBattlefield(uid) {
  battlefieldMonsters = battlefieldMonsters.filter(b => b._uid !== uid);
  relabelBattlefield();
  renderBattlefield();
  saveBattlefield();
}

async function clearBattlefield() {
  if (battlefieldMonsters.length === 0) return;
  if (!await dialogConfirm('Remove all monsters from the battlefield?', 'Clear Battlefield')) return;
  battlefieldMonsters = [];
  renderBattlefield();
  saveBattlefield();
}

function renderBattlefield() {
  const container = document.getElementById('battlefield-list');
  const emptyMsg = document.getElementById('battlefield-empty');

  if (battlefieldMonsters.length === 0) { container.innerHTML = ''; if (emptyMsg) emptyMsg.style.display = ''; return; }
  emptyMsg.style.display = 'none';

  container.innerHTML = battlefieldMonsters.map(m => {
    if (m._custom && m._editing) {
      return `
      <div class="bf-card" data-uid="${m._uid}" style="border-left:3px solid var(--gold);">
        <div class="bf-header">
          <strong style="color:var(--gold);font-size:0.8rem;">Custom Monster</strong>
          <button class="remove-item" onclick="removeFromBattlefield(${m._uid})" title="Remove">&times;</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;">
          <div class="form-group" style="flex:2;margin:0;min-width:140px;"><label>Name</label><input type="text" class="bf-custom-name" value="${esc(m.name)}" placeholder="Monster name" onchange="updateCustomMonster(${m._uid},'name',this.value)"></div>
          <div class="form-group" style="flex:1;margin:0;min-width:90px;"><label>Size</label>
            <select onchange="updateCustomMonster(${m._uid},'size',this.value)">
              ${['Tiny','Small','Medium','Large','Huge','Gargantuan'].map(s => `<option ${m.size === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="flex:0 0 60px;margin:0;"><label>AC</label><input type="number" value="${m.AC}" min="1" onchange="updateCustomMonster(${m._uid},'AC',this.value)"></div>
          <div class="form-group" style="flex:0 0 60px;margin:0;"><label>HP</label><input type="number" value="${m.HP}" min="1" onchange="updateCustomMonster(${m._uid},'HP',this.value)"></div>
          <div class="form-group" style="flex:0 0 60px;margin:0;"><label>CR</label><input type="text" value="${esc(m.CR)}" onchange="updateCustomMonster(${m._uid},'CR',this.value)" style="width:100%;"></div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:4px;">
          <button type="button" class="btn btn-primary btn-small" onclick="finishCustomMonster(${m._uid})">Done</button>
        </div>
      </div>`;
    }
    const hpPercent = Math.max(0, (m.currentHP / m.HP) * 100);
    let hpColor = 'var(--hp-high)';
    if (hpPercent <= 25) hpColor = 'var(--hp-low)';
    else if (hpPercent <= 50) hpColor = 'var(--hp-mid)';
    return `
      <div class="bf-card" data-uid="${m._uid}"${m._custom ? ' style="border-left:3px solid var(--gold);"' : ''}>
        <div class="bf-header">
          <strong class="bf-name" onclick="${m._custom ? `editCustomMonster(${m._uid})` : `showMonsterStats(${m._uid})`}" style="cursor:pointer;">${esc(m._label)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;">${esc(m.size || '')} ${esc(m.type || '')} | AC ${m.AC} | CR ${m.CR}</span>
          <button class="remove-item" onclick="removeFromBattlefield(${m._uid})" title="Remove">&times;</button>
        </div>
        <div class="bf-hp-row">
          <button class="hp-btn" onclick="bfHP(${m._uid}, -1)">−</button>
          <button class="hp-btn hp-btn-sm" onclick="bfHP(${m._uid}, -5)" style="font-size:0.7rem;">-5</button>
          <div class="bf-hp-bar-container">
            <div class="bf-hp-bar" style="width:${hpPercent}%;background:${hpColor};"></div>
          </div>
          <span class="bf-hp-text" style="min-width:70px;text-align:center;font-weight:600;">${m.currentHP} / ${m.HP}</span>
          <button class="hp-btn hp-btn-sm" onclick="bfHP(${m._uid}, 5)" style="font-size:0.7rem;">+5</button>
          <button class="hp-btn" onclick="bfHP(${m._uid}, 1)">+</button>
        </div>
        <div class="bf-actions">
          ${(m.actions || []).slice(0, 6).map(a => {
            const attackMatch = a.description.match(/([+-]\d+) to hit.*?Hit: (\d+.*?)\./);
            const shortDesc = attackMatch ? `${attackMatch[1]} to hit, ${attackMatch[2]}` : '';
            return `<span class="bf-action-tag" title="${esc(a.description)}">${esc(a.name)}${shortDesc ? ' (' + esc(shortDesc) + ')' : ''}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function bfHP(uid, delta) {
  const m = battlefieldMonsters.find(b => b._uid === uid);
  if (!m) return;
  m.currentHP = Math.max(0, Math.min(m.HP, m.currentHP + delta));
  renderBattlefield();
  saveBattlefield();
}

function buildMonsterStatBlockHTML(m) {
  const abilityMod = (score) => {
    const mod = Math.floor((score - 10) / 2);
    return mod >= 0 ? `+${mod}` : `${mod}`;
  };
  let html = `
    <div style="color:var(--text-muted);font-size:0.9rem;margin-bottom:12px;">${[m.size, m.type, m.alignment].filter(Boolean).join(', ')}</div>
    <div class="stat-block-divider"></div>
    <div class="stat-block-line"><strong>AC</strong> ${m.AC}</div>
    <div class="stat-block-line"><strong>HP</strong> ${m.HP}${m.hitDice ? ' (' + m.hitDice + ')' : ''}</div>
    <div class="stat-block-line"><strong>Speed</strong> ${m.speed || '30 ft.'}</div>
    <div class="stat-block-divider"></div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:8px 0;">
      ${['STR','DEX','CON','INT','WIS','CHA'].map(a => `
        <div class="stat-box" style="padding:0.5rem 0.15rem;">
          <div class="stat-label">${a}</div>
          <div class="stat-mod" style="font-size:1.1rem;">${abilityMod(m[a] || 10)}</div>
          <div class="stat-value" style="font-size:0.85rem;">${m[a] || 10}</div>
        </div>
      `).join('')}
    </div>
    <div class="stat-block-divider"></div>
  `;
  if (m.savingThrows) html += `<div class="stat-block-line"><strong>Saving Throws</strong> ${esc(m.savingThrows)}</div>`;
  if (m.skills) html += `<div class="stat-block-line"><strong>Skills</strong> ${esc(m.skills)}</div>`;
  if (m.damageResistances) html += `<div class="stat-block-line"><strong>Damage Resistances</strong> ${esc(m.damageResistances)}</div>`;
  if (m.damageImmunities) html += `<div class="stat-block-line"><strong>Damage Immunities</strong> ${esc(m.damageImmunities)}</div>`;
  if (m.conditionImmunities) html += `<div class="stat-block-line"><strong>Condition Immunities</strong> ${esc(m.conditionImmunities)}</div>`;
  if (m.senses) html += `<div class="stat-block-line"><strong>Senses</strong> ${esc(m.senses)}</div>`;
  if (m.languages) html += `<div class="stat-block-line"><strong>Languages</strong> ${esc(m.languages)}</div>`;
  html += `<div class="stat-block-line"><strong>CR</strong> ${m.CR}</div>`;
  if (m.traits && m.traits.length > 0) {
    html += '<div class="stat-block-divider"></div>';
    html += m.traits.map(t => `<div class="stat-block-action"><strong>${esc(t.name)}.</strong> ${esc(t.description)}</div>`).join('');
  }
  if (m.actions && m.actions.length > 0) {
    html += '<div class="stat-block-divider"></div><h3 style="margin:8px 0 4px;">Actions</h3>';
    html += m.actions.map(a => `<div class="stat-block-action"><strong>${esc(a.name)}.</strong> ${esc(a.description)}</div>`).join('');
  }
  if (m.reactions && m.reactions.length > 0) {
    html += '<div class="stat-block-divider"></div><h3 style="margin:8px 0 4px;">Reactions</h3>';
    html += m.reactions.map(r => `<div class="stat-block-action"><strong>${esc(r.name)}.</strong> ${esc(r.description)}</div>`).join('');
  }
  if (m.legendaryActions && m.legendaryActions.length > 0) {
    html += '<div class="stat-block-divider"></div><h3 style="margin:8px 0 4px;">Legendary Actions</h3>';
    html += m.legendaryActions.map(a => `<div class="stat-block-action"><strong>${esc(a.name)}.</strong> ${esc(a.description)}</div>`).join('');
  }
  return html;
}

function showMonsterStats(uid) {
  const m = battlefieldMonsters.find(b => b._uid === uid);
  if (!m) return;
  document.getElementById('monster-modal-title').textContent = m._label;
  document.getElementById('monster-stat-block').innerHTML = buildMonsterStatBlockHTML(m);
  document.getElementById('monster-modal').showModal();
}

// --- Character HP Tracking (Battlefield) ---

async function loadCharacterHP() {
  characterHPState = await db.getCharacterHP();
  renderBattlefieldCharacters();
}

function saveCharacterHP(changedCharId) {
  db.saveCharacterHP(characterHPState);
  // Broadcast HP change to connected player
  if (dmPeer && changedCharId) {
    broadcastCharacterToPlayer(changedCharId);
  }
}

async function renderBattlefieldCharacters() {
  const container = document.getElementById('bf-characters-list');
  const emptyMsg = document.getElementById('bf-characters-empty');

  if (battlefieldPCIds.length === 0) {
    bfCharactersCache = [];
    container.innerHTML = '';
    emptyMsg.style.display = '';
    emptyMsg.textContent = 'No characters on the battlefield yet.';
    return;
  }

  const characters = [];
  for (const id of battlefieldPCIds) {
    const c = await db.getCharacter(id);
    if (c) characters.push(c);
  }

  bfCharactersCache = characters;
  drawBattlefieldCharacters();
}

function drawBattlefieldCharacters() {
  const container = document.getElementById('bf-characters-list');
  const emptyMsg = document.getElementById('bf-characters-empty');
  const characters = bfCharactersCache;

  if (characters.length === 0) {
    container.innerHTML = '';
    emptyMsg.style.display = '';
    emptyMsg.textContent = 'No characters in session.';
    return;
  }
  emptyMsg.style.display = 'none';

  characters.forEach(c => {
    if (!characterHPState[c._id]) characterHPState[c._id] = { currentHP: c.HP, tempHP: 0 };
    if (characterHPState[c._id].currentHP > c.HP) characterHPState[c._id].currentHP = c.HP;
  });

  container.innerHTML = characters.map(c => {
    const state = characterHPState[c._id];
    const hpPercent = Math.max(0, (state.currentHP / c.HP) * 100);
    let hpColor = 'var(--hp-high)';
    if (hpPercent <= 25) hpColor = 'var(--hp-low)';
    else if (hpPercent <= 50) hpColor = 'var(--hp-mid)';
    const sessionEntry = currentSession && currentSession.characters[c._id];
    const playerLabel = sessionEntry?.claimedBy
      ? `<span style="color:var(--accent);font-size:0.75rem;">${esc(sessionEntry.claimedBy)}</span>`
      : currentSession
        ? `<span style="color:var(--text-muted);font-size:0.75rem;">(no player)</span>`
        : '';
    return `
      <div class="bf-card" data-char-hp-id="${c._id}">
        <div class="bf-header">
          <strong>${esc(c.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;">Lvl ${c.level} ${esc(c.species || '')} ${esc(c.class)} | AC ${c.AC}</span>
          ${playerLabel}
          <button class="remove-item" onclick="removePCFromBattlefield('${c._id}')" title="Remove from battlefield">&times;</button>
        </div>
        <div class="bf-hp-row">
          <button class="hp-btn" onclick="charHP('${c._id}', -1, ${c.HP})">−</button>
          <button class="hp-btn hp-btn-sm" onclick="charHP('${c._id}', -5, ${c.HP})" style="font-size:0.7rem;">-5</button>
          <div class="bf-hp-bar-container">
            <div class="bf-hp-bar" style="width:${hpPercent}%;background:${hpColor};"></div>
          </div>
          <span class="bf-hp-text" style="min-width:70px;text-align:center;font-weight:600;">${state.currentHP} / ${c.HP}</span>
          <button class="hp-btn hp-btn-sm" onclick="charHP('${c._id}', 5, ${c.HP})" style="font-size:0.7rem;">+5</button>
          <button class="hp-btn" onclick="charHP('${c._id}', 1, ${c.HP})">+</button>
        </div>
        <div class="bf-hp-row" style="margin-top:4px;">
          <button class="hp-btn hp-btn-sm" onclick="charTempHP('${c._id}', -1)">−</button>
          <span style="color:var(--text-muted);font-size:0.85rem;min-width:80px;text-align:center;">Temp HP: ${state.tempHP}</span>
          <button class="hp-btn hp-btn-sm" onclick="charTempHP('${c._id}', 1)">+</button>
        </div>
      </div>
    `;
  }).join('');
}

function charHP(charId, delta, maxHP) {
  if (!characterHPState[charId]) return;
  characterHPState[charId].currentHP = Math.max(0, Math.min(maxHP, characterHPState[charId].currentHP + delta));
  drawBattlefieldCharacters();
  saveCharacterHP(charId);
}

function charTempHP(charId, delta) {
  if (!characterHPState[charId]) return;
  characterHPState[charId].tempHP = Math.max(0, characterHPState[charId].tempHP + delta);
  drawBattlefieldCharacters();
  saveCharacterHP(charId);
}

// --- Compendium ---

function populateCompendiumMonsterFilters() {
  const types = [...new Set(allMonsters.map(m => m.type).filter(Boolean))].sort();
  const crOrder = ['0','1/8','1/4','1/2','1','2','3','4','5','6','7','8','9','10',
    '11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','30'];
  const crs = [...new Set(allMonsters.map(m => String(m.CR)).filter(Boolean))];
  crs.sort((a, b) => {
    const ai = crOrder.indexOf(a), bi = crOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const [typeId, crId] of [['compendium-monster-type', 'compendium-monster-cr'], ['mobile-monster-type', 'mobile-monster-cr']]) {
    const typeEl = document.getElementById(typeId);
    types.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; typeEl.appendChild(o); });
    const crEl = document.getElementById(crId);
    crs.forEach(cr => { const o = document.createElement('option'); o.value = cr; o.textContent = `CR ${cr}`; crEl.appendChild(o); });
  }
}

function openSearchDropdown() {
  document.getElementById('top-bar-dropdown').classList.add('open');
}
function closeSearchDropdown() {
  document.getElementById('top-bar-dropdown').classList.remove('open');
}

function openMobileSearchModal() {
  document.getElementById('mobile-search-modal').showModal();
}

function closeMobileSearchModal() {
  document.getElementById('mobile-search-modal').close();
  document.getElementById('mobile-search-input').value = '';
  document.getElementById('mobile-compendium-category').value = '';
  document.getElementById('mobile-spell-filters').style.display = 'none';
  document.getElementById('mobile-monster-filters').style.display = 'none';
  document.getElementById('mobile-feature-filters').style.display = 'none';
  document.getElementById('mobile-search-results').innerHTML = '<p class="top-bar-hint">Type to search spells, monsters, equipment, features…</p>';
}

function filterMobileCompendium() {
  const query = document.getElementById('mobile-search-input').value.trim().toLowerCase();
  const category = document.getElementById('mobile-compendium-category').value;
  document.getElementById('mobile-spell-filters').style.display = category === 'spell' ? 'flex' : 'none';
  document.getElementById('mobile-monster-filters').style.display = category === 'monster' ? 'flex' : 'none';
  document.getElementById('mobile-feature-filters').style.display = category === 'feature' ? 'flex' : 'none';
  const resultsEl = document.getElementById('mobile-search-results');

  if (!query && !category) {
    resultsEl.innerHTML = '<p class="top-bar-hint">Type to search spells, monsters, equipment, features…</p>';
    return;
  }

  let candidates = [];
  if (!category || category === 'spell') allSpells.forEach(s => candidates.push({ type: 'spell', item: s }));
  if (!category || category === 'monster') allMonsters.forEach(m => candidates.push({ type: 'monster', item: m }));
  if (!category || category === 'equipment') allEquipment.forEach(e => candidates.push({ type: 'equipment', item: e }));
  if (!category || category === 'feature') allFeatures.forEach(f => candidates.push({ type: 'feature', item: f }));

  if (query) {
    candidates = candidates.filter(({ item }) => {
      const nameMatch = item.name && item.name.toLowerCase().includes(query);
      const descMatch = item.description && item.description.toLowerCase().includes(query);
      return nameMatch || descMatch;
    });
  }

  if (category === 'spell') {
    const lvl = document.getElementById('mobile-spell-level').value;
    const cls = document.getElementById('mobile-spell-class').value;
    if (lvl !== '') candidates = candidates.filter(({ item }) => String(item.level) === lvl);
    if (cls) candidates = candidates.filter(({ item }) => item.classes && item.classes.includes(cls));
  }
  if (category === 'monster') {
    const type = document.getElementById('mobile-monster-type').value;
    const cr = document.getElementById('mobile-monster-cr').value;
    if (type) candidates = candidates.filter(({ item }) => item.type === type);
    if (cr) candidates = candidates.filter(({ item }) => String(item.CR) === cr);
  }
  if (category === 'feature') {
    const src = document.getElementById('mobile-feature-source').value;
    if (src) candidates = candidates.filter(({ item }) => item.source === src);
  }

  const shown = candidates.slice(0, 100);
  if (shown.length === 0) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);">No results found.</div>';
    return;
  }

  window.mobileCompendiumResults = shown;
  resultsEl.innerHTML = shown.map(({ type, item }, idx) => {
    let subtitle = '';
    if (type === 'spell') {
      const lvlLabel = item.level === 0 ? 'Cantrip' : `Level ${item.level}`;
      subtitle = `${lvlLabel}${item.school ? ' ' + item.school.charAt(0).toUpperCase() + item.school.slice(1) : ''}${item.classes?.length ? ' · ' + item.classes.join(', ') : ''}`;
    } else if (type === 'monster') {
      subtitle = [item.size, item.type, `CR ${item.CR}`].filter(Boolean).join(' · ');
    } else if (type === 'equipment') {
      subtitle = [item.type, item.category, item.cost].filter(Boolean).join(' · ');
    } else if (type === 'feature') {
      const srcLabel = item.source === 'class' ? 'Class Feature' : item.source === 'species' ? 'Species Trait' : 'Feat';
      subtitle = `${srcLabel}${item.sourceDetail ? ' · ' + item.sourceDetail : ''}`;
    }
    return `<div class="list-item" style="cursor:pointer;" onclick="closeMobileSearchModal();showCompendiumDetail(mobileCompendiumResults[${idx}].type, mobileCompendiumResults[${idx}].item)">
      <span>${esc(item.name)}</span>
      <span style="color:var(--text-muted);font-size:0.85rem;">${esc(subtitle)}</span>
    </div>`;
  }).join('');
}

function filterCompendium() {
  const query = document.getElementById('top-bar-search').value.trim().toLowerCase();
  const category = document.getElementById('compendium-category').value;
  document.getElementById('compendium-spell-filters').style.display = category === 'spell' ? 'flex' : 'none';
  document.getElementById('compendium-monster-filters').style.display = category === 'monster' ? 'flex' : 'none';
  document.getElementById('compendium-feature-filters').style.display = category === 'feature' ? 'flex' : 'none';
  const resultsEl = document.getElementById('compendium-results');
  const hintEl = document.getElementById('compendium-hint');

  if (!query && !category) { resultsEl.style.display = 'none'; hintEl.style.display = ''; return; }

  let candidates = [];
  if (!category || category === 'spell') allSpells.forEach(s => candidates.push({ type: 'spell', item: s }));
  if (!category || category === 'monster') allMonsters.forEach(m => candidates.push({ type: 'monster', item: m }));
  if (!category || category === 'equipment') allEquipment.forEach(e => candidates.push({ type: 'equipment', item: e }));
  if (!category || category === 'feature') allFeatures.forEach(f => candidates.push({ type: 'feature', item: f }));

  if (query) {
    candidates = candidates.filter(({ item }) => {
      const nameMatch = item.name && item.name.toLowerCase().includes(query);
      const descMatch = item.description && item.description.toLowerCase().includes(query);
      return nameMatch || descMatch;
    });
  }

  if (category === 'spell') {
    const lvl = document.getElementById('compendium-spell-level').value;
    const cls = document.getElementById('compendium-spell-class').value;
    if (lvl !== '') candidates = candidates.filter(({ item }) => String(item.level) === lvl);
    if (cls) candidates = candidates.filter(({ item }) => item.classes && item.classes.includes(cls));
  }
  if (category === 'monster') {
    const type = document.getElementById('compendium-monster-type').value;
    const cr = document.getElementById('compendium-monster-cr').value;
    if (type) candidates = candidates.filter(({ item }) => item.type === type);
    if (cr) candidates = candidates.filter(({ item }) => String(item.CR) === cr);
  }
  if (category === 'feature') {
    const src = document.getElementById('compendium-feature-source').value;
    if (src) candidates = candidates.filter(({ item }) => item.source === src);
  }

  const shown = candidates.slice(0, 100);
  if (shown.length === 0) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);">No results found.</div>';
    resultsEl.style.display = 'block'; hintEl.style.display = 'none'; return;
  }

  resultsEl.innerHTML = shown.map(({ type, item }, idx) => {
    let subtitle = '';
    if (type === 'spell') {
      const lvlLabel = item.level === 0 ? 'Cantrip' : `Level ${item.level}`;
      subtitle = `${lvlLabel}${item.school ? ' ' + item.school.charAt(0).toUpperCase() + item.school.slice(1) : ''}${item.classes?.length ? ' · ' + item.classes.join(', ') : ''}`;
    } else if (type === 'monster') {
      subtitle = [item.size, item.type, `CR ${item.CR}`].filter(Boolean).join(' · ');
    } else if (type === 'equipment') {
      subtitle = [item.type, item.category, item.cost].filter(Boolean).join(' · ');
    } else if (type === 'feature') {
      const srcLabel = item.source === 'class' ? 'Class Feature' : item.source === 'species' ? 'Species Trait' : 'Feat';
      subtitle = `${srcLabel}${item.sourceDetail ? ' · ' + item.sourceDetail : ''}`;
    }
    return `<div class="list-item" style="cursor:pointer;" onclick="showCompendiumDetail(compendiumCurrentResults[${idx}].type, compendiumCurrentResults[${idx}].item)">
      <span>${esc(item.name)}</span>
      <span style="color:var(--text-muted);font-size:0.85rem;">${esc(subtitle)}</span>
    </div>`;
  }).join('');

  window.compendiumCurrentResults = shown;
  resultsEl.style.display = 'block'; hintEl.style.display = 'none';
}

function showCompendiumDetail(type, item) {
  closeSearchDropdown();
  const modal = document.getElementById('compendium-modal');
  document.getElementById('compendium-modal-title').textContent = item.name;
  let html = '';
  if (type === 'spell') {
    const lvlLabel = item.level === 0 ? 'Cantrip' : `Level ${item.level}`;
    html += `<div style="color:var(--text-muted);font-size:0.9rem;margin-bottom:12px;">${esc(lvlLabel + (item.school ? ' ' + item.school.charAt(0).toUpperCase() + item.school.slice(1) : ''))}</div>`;
    html += '<div class="stat-block-divider"></div>';
    if (item.classes?.length) html += `<div class="stat-block-line"><strong>Classes</strong> ${esc(item.classes.join(', '))}</div>`;
    if (item.actionType) html += `<div class="stat-block-line"><strong>Casting Time</strong> ${esc(item.actionType)}</div>`;
    if (item.range) html += `<div class="stat-block-line"><strong>Range</strong> ${esc(item.range)}</div>`;
    if (item.components?.length) html += `<div class="stat-block-line"><strong>Components</strong> ${esc(item.components.map(c => c.toUpperCase()).join(', '))}${item.material ? ' (' + esc(item.material) + ')' : ''}</div>`;
    if (item.duration) html += `<div class="stat-block-line"><strong>Duration</strong> ${item.concentration ? 'Concentration, ' : ''}${esc(item.duration)}</div>`;
    const tags = [];
    if (item.ritual) tags.push('Ritual');
    if (item.concentration) tags.push('Concentration');
    if (tags.length) html += `<div style="margin:6px 0;">${tags.map(t => `<span style="display:inline-block;background:var(--accent);color:#fff;border-radius:4px;padding:1px 7px;font-size:0.78rem;margin-right:4px;">${esc(t)}</span>`).join('')}</div>`;
    html += '<div class="stat-block-divider"></div>';
    html += `<div style="margin-top:8px;line-height:1.6;">${esc(item.description)}</div>`;
    if (item.cantripUpgrade) html += `<div style="margin-top:8px;color:var(--text-muted);font-size:0.9rem;line-height:1.6;"><em>${esc(item.cantripUpgrade)}</em></div>`;
  } else if (type === 'monster') {
    html = buildMonsterStatBlockHTML(item);
  } else if (type === 'equipment') {
    html += '<div class="stat-block-divider"></div>';
    if (item.type) html += `<div class="stat-block-line"><strong>Type</strong> ${esc(item.type)}${item.category ? ' — ' + esc(item.category) : ''}</div>`;
    if (item.damage) html += `<div class="stat-block-line"><strong>Damage</strong> ${esc(item.damage)}</div>`;
    if (item.properties) html += `<div class="stat-block-line"><strong>Properties</strong> ${esc(item.properties)}</div>`;
    if (item.cost) html += `<div class="stat-block-line"><strong>Cost</strong> ${esc(item.cost)}</div>`;
    if (item.weight) html += `<div class="stat-block-line"><strong>Weight</strong> ${esc(item.weight)}</div>`;
  } else if (type === 'feature') {
    const srcLabel = item.source === 'class' ? 'Class Feature' : item.source === 'species' ? 'Species Trait' : 'Feat';
    html += `<div style="color:var(--text-muted);font-size:0.9rem;margin-bottom:12px;">${esc(srcLabel)}${item.sourceDetail ? ' · ' + esc(item.sourceDetail) : ''}${item._level ? ' (Level ' + item._level + ')' : ''}</div>`;
    html += '<div class="stat-block-divider"></div>';
    html += `<div style="margin-top:8px;line-height:1.6;">${esc(item.description)}</div>`;
  }
  document.getElementById('compendium-modal-body').innerHTML = html;
  modal.showModal();
}

// --- Util ---
let _toastTimer;
function showToast(msg) {
  const container = document.getElementById('toast-container');
  const el = document.getElementById('toast');
  if (!el || !container) return;
  clearTimeout(_toastTimer);
  el.textContent = msg;
  // Reparent the toast into the topmost open <dialog> so it renders in the
  // dialog's top layer (visible above the modal). Fall back to <body>.
  const openDialogs = document.querySelectorAll('dialog[open]');
  const targetDialog = openDialogs[openDialogs.length - 1] || null;
  const desiredParent = targetDialog || document.body;
  if (container.parentNode !== desiredParent) {
    desiredParent.appendChild(container);
  }
  container.style.display = '';
  _toastTimer = setTimeout(() => { container.style.display = 'none'; }, 2000);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// --- TOML Export / Import ---

function serializeCharToTOML(c) {
  const lines = [];
  function tomlStr(v) {
    if (v == null) return '""';
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  lines.push(`name       = ${tomlStr(c.name)}`);
  lines.push(`class      = ${tomlStr(c.class)}`);
  lines.push(`species    = ${tomlStr(c.species)}`);
  lines.push(`level      = ${parseInt(c.level) || 1}`);
  lines.push(`background = ${tomlStr(c.background)}`);
  lines.push(`HP         = ${parseInt(c.HP) || 0}`);
  lines.push(`AC         = ${parseInt(c.AC) || 0}`);
  lines.push('');
  lines.push(`STR = ${parseInt(c.STR) || 10}`);
  lines.push(`DEX = ${parseInt(c.DEX) || 10}`);
  lines.push(`CON = ${parseInt(c.CON) || 10}`);
  lines.push(`INT = ${parseInt(c.INT) || 10}`);
  lines.push(`WIS = ${parseInt(c.WIS) || 10}`);
  lines.push(`CHA = ${parseInt(c.CHA) || 10}`);
  lines.push('');
  const skills = Array.isArray(c.skills) ? c.skills : [];
  lines.push('[skills]');
  SKILL_ABILITIES.forEach((s, i) => {
    const key = s.name.includes(' ') ? `"${s.name}"` : s.name;
    lines.push(`${key} = ${skills[i] ? 'true' : 'false'}`);
  });
  lines.push('');
  const cur = c.currency || {};
  lines.push('[currency]');
  lines.push(`CP = ${parseInt(cur.CP) || 0}`);
  lines.push(`SP = ${parseInt(cur.SP) || 0}`);
  lines.push(`EP = ${parseInt(cur.EP) || 0}`);
  lines.push(`GP = ${parseInt(cur.GP) || 0}`);
  lines.push(`PP = ${parseInt(cur.PP) || 0}`);
  lines.push('');
  for (const f of (c.features || [])) {
    lines.push('[[features]]');
    lines.push(`name         = ${tomlStr(f.name)}`);
    lines.push(`description  = ${tomlStr(f.description)}`);
    lines.push(`source       = ${tomlStr(f.source)}`);
    lines.push(`sourceDetail = ${tomlStr(f.sourceDetail)}`);
    lines.push('');
  }
  for (const e of (c.equipment || [])) {
    lines.push('[[equipment]]');
    lines.push(`name        = ${tomlStr(e.name)}`);
    lines.push(`type        = ${tomlStr(e.type)}`);
    lines.push(`description = ${tomlStr(e.description)}`);
    lines.push(`quantity    = ${parseInt(e.quantity) || 1}`);
    lines.push('');
  }
  for (const s of (c.spells || [])) {
    lines.push('[[spells]]');
    lines.push(`name          = ${tomlStr(s.name)}`);
    lines.push(`level         = ${parseInt(s.level) || 0}`);
    lines.push(`school        = ${tomlStr(s.school)}`);
    lines.push(`description   = ${tomlStr(s.description)}`);
    lines.push(`castingTime   = ${tomlStr(s.castingTime)}`);
    lines.push(`range         = ${tomlStr(s.range)}`);
    lines.push(`components    = ${tomlStr(s.components)}`);
    lines.push(`concentration = ${s.concentration ? 'true' : 'false'}`);
    lines.push(`ritual        = ${s.ritual ? 'true' : 'false'}`);
    lines.push(`duration      = ${tomlStr(s.duration)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseCharFromTOML(text) {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  function stripComment(line) {
    let inStr = false, escape = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (ch === '#' && !inStr) return line.slice(0, i).trimEnd();
    }
    return line;
  }
  function unescapeStr(s) {
    return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  function parseValue(raw) {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v.startsWith('"') && v.endsWith('"')) return unescapeStr(v.slice(1, -1));
    const n = Number(v);
    if (!isNaN(n) && v !== '') return Math.round(n);
    throw new Error(`Cannot parse value: ${v}`);
  }
  const c = {
    name: '', class: '', species: '', level: 1, background: '',
    HP: 0, AC: 0, STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10,
    skills: Array(18).fill(false), currency: { CP: 0, SP: 0, EP: 0, GP: 0, PP: 0 },
    features: [], equipment: [], spells: []
  };
  const skillMap = {};
  let section = null;
  let currentItem = null;
  function flushItem() {
    if (currentItem !== null && ['features', 'equipment', 'spells'].includes(section)) c[section].push(currentItem);
    currentItem = null;
  }
  for (const rawLine of rawLines) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;
    const aotMatch = line.match(/^\[\[(\w+)\]\]$/);
    if (aotMatch) { flushItem(); const key = aotMatch[1]; section = ['features', 'equipment', 'spells'].includes(key) ? key : null; if (section) currentItem = {}; continue; }
    const tableMatch = line.match(/^\[(\w+)\]$/);
    if (tableMatch) { flushItem(); section = tableMatch[1]; currentItem = null; continue; }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    const key = rawKey.startsWith('"') && rawKey.endsWith('"') ? rawKey.slice(1, -1) : rawKey;
    let value;
    try { value = parseValue(rawVal); } catch (_) { continue; }
    if (section === null) {
      const intFields = ['level', 'HP', 'AC', 'STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
      if (intFields.includes(key)) c[key] = typeof value === 'number' ? value : parseInt(value) || 0;
      else if (typeof c[key] !== 'undefined' || ['name','class','species','background'].includes(key)) c[key] = value;
    } else if (section === 'skills') {
      if (typeof value === 'boolean') skillMap[key] = value;
    } else if (section === 'currency') {
      if (['CP', 'SP', 'EP', 'GP', 'PP'].includes(key) && typeof value === 'number') c.currency[key] = value;
    } else if (currentItem !== null) {
      currentItem[key] = value;
    }
  }
  flushItem();
  c.skills = SKILL_ABILITIES.map(s => skillMap[s.name] === true);
  return c;
}

async function showExportCharacterPicker() {
  const chars = await db.getAllCharacters();
  if (!chars.length) { dialogAlert('No characters to export.', 'Export', 'info'); return; }
  if (chars.length === 1) { exportCharacter(chars[0]._id); closeSidebar(); return; }
  const overlay = document.getElementById('dialog-overlay');
  const titleEl = document.getElementById('dialog-title');
  const msgEl = document.getElementById('dialog-message');
  const btnsEl = document.getElementById('dialog-buttons');
  titleEl.textContent = 'Export Character';
  msgEl.textContent = 'Select a character to export:';
  btnsEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;">
    ${chars.map(c => `<button class="btn btn-secondary btn-small" data-export-id="${c._id}">${esc(c.name || 'Unnamed')}</button>`).join('')}
    <button class="btn btn-secondary btn-small" data-export-id="__cancel">Cancel</button>
  </div>`;
  overlay.showModal();
  closeSidebar();
  btnsEl.querySelectorAll('[data-export-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.close();
      const id = btn.dataset.exportId;
      if (id !== '__cancel') exportCharacter(id);
    });
  });
}

async function exportCharacter(id) {
  const c = await db.getCharacter(id);
  if (!c) { dialogAlert('Character not found.', 'Error', 'error'); return; }
  const toml = serializeCharToTOML(c);
  const blob = new Blob([toml], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (c.name || 'character').replace(/[^a-z0-9]/gi, '_') + '.toml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

async function importCharacterFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const text = await file.text();
  let c;
  try { c = parseCharFromTOML(text); } catch (e) { dialogAlert('Failed to parse TOML: ' + e.message, 'Import Error', 'error'); return; }
  try {
    await db.putCharacter(c);
    loadCharacters();
  } catch (e) {
    dialogAlert('Import failed: ' + e.message, 'Import Error', 'error');
  }
}

// --- Treasures (IndexedDB) ---
async function loadTreasures() {
  treasurePool = await db.getTreasures();
  renderTreasures();
}

function saveTreasures() {
  db.saveTreasures(treasurePool);
}

function filterTreasureSearch() {
  const query = document.getElementById('treasure-search').value.trim().toLowerCase();
  const typeFilter = document.getElementById('treasure-type-filter').value;
  const resultsEl = document.getElementById('treasure-results');

  if (!query && !typeFilter) { resultsEl.style.display = 'none'; return; }

  let filtered = allEquipment;
  if (typeFilter) filtered = filtered.filter(e => e.type === typeFilter);
  if (query) filtered = filtered.filter(e =>
    e.name.toLowerCase().includes(query) || (e.category && e.category.toLowerCase().includes(query))
  );

  resultsEl.style.display = '';
  resultsEl.innerHTML = filtered.slice(0, 50).map((e, i) => {
    let detail = e.category || '';
    if (e.damage) detail += ` | ${e.damage}`;
    if (e.AC) detail += ` | AC: ${e.AC}`;
    if (e.cost) detail += ` | ${e.cost}`;
    if (e.properties && e.properties !== '—') detail += ` | ${e.properties}`;
    return `
      <div class="list-item" style="cursor:pointer;" onclick="addToTreasures(${i}, this)">
        <div>
          <strong>${esc(e.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(detail)}</span>
        </div>
      </div>`;
  }).join('') || '<div style="padding:8px;color:var(--text-muted);">No items found</div>';
  resultsEl._filtered = filtered;
}

function addCustomTreasure() {
  treasurePool.push({ name: '', type: '', description: '', quantity: 1, _editing: true });
  renderTreasures();
  saveTreasures();
  setTimeout(() => {
    const inputs = document.querySelectorAll('#treasure-list .treasure-custom-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}

function updateCustomTreasure(idx, field, value) {
  const item = treasurePool[idx];
  if (!item) return;
  if (field === 'quantity') item.quantity = Math.max(1, parseInt(value) || 1);
  else item[field] = value;
  saveTreasures();
}

function finishCustomTreasure(idx) {
  const item = treasurePool[idx];
  if (!item) return;
  if (!item.name.trim()) { dialogAlert('Please enter an item name.', 'Custom Item', 'info'); return; }
  item._editing = false;
  renderTreasures();
  saveTreasures();
}

function addToTreasures(idx, el) {
  const resultsEl = document.getElementById('treasure-results');
  const e = resultsEl._filtered[idx];
  if (!e) return;
  let desc = '';
  if (e.damage) desc += e.damage;
  if (e.AC) desc += (desc ? ' | ' : '') + 'AC: ' + e.AC;
  if (e.properties && e.properties !== '—') desc += (desc ? ' | ' : '') + e.properties;
  if (e.weight && e.weight !== '—') desc += (desc ? ' | ' : '') + e.weight;
  if (e.cost) desc += (desc ? ' | ' : '') + e.cost;
  treasurePool.push({ name: e.name, type: e.category || e.type, description: desc, quantity: 1 });
  renderTreasures();
  saveTreasures();
  showToast(`${e.name} added to treasure`);
}

function removeFromTreasures(idx) { snapshotTreasureSelections(); treasurePool.splice(idx, 1); renderTreasures(); saveTreasures(); }

async function clearTreasures() {
  if (treasurePool.length === 0) return;
  if (!await dialogConfirm('Remove all items from the treasure pool?', 'Clear Treasures')) return;
  treasurePool = [];
  renderTreasures();
  saveTreasures();
}

function snapshotTreasureSelections() {
  treasurePool.forEach((item, i) => {
    const sel = document.getElementById(`treasure-assign-${i}`);
    if (sel) item._assignTo = sel.value || '';
  });
}

function renderTreasures() {
  const container = document.getElementById('treasure-list');
  const emptyMsg = document.getElementById('treasure-empty');
  if (treasurePool.length === 0) { container.innerHTML = ''; emptyMsg.style.display = ''; return; }
  emptyMsg.style.display = 'none';
  const charOptions = allCharacters.map(c => `<option value="${c._id}">${esc(c.name)}</option>`).join('');
  container.innerHTML = treasurePool.map((item, idx) => {
    if (item._editing) {
      return `
      <div class="list-item" style="flex-wrap:wrap;padding:10px 12px;gap:8px;border-left:3px solid var(--gold);">
        <div style="display:flex;flex-wrap:wrap;gap:8px;flex:1;">
          <div class="form-group" style="flex:2;margin:0;min-width:140px;"><label>Name</label><input type="text" class="treasure-custom-name" value="${esc(item.name)}" placeholder="Item name" onchange="updateCustomTreasure(${idx},'name',this.value)"></div>
          <div class="form-group" style="flex:1;margin:0;min-width:100px;"><label>Type</label><input type="text" value="${esc(item.type)}" placeholder="Weapon, Armor, etc." onchange="updateCustomTreasure(${idx},'type',this.value)"></div>
          <div class="form-group" style="flex:0 0 60px;margin:0;"><label>Qty</label><input type="number" value="${item.quantity}" min="1" onchange="updateCustomTreasure(${idx},'quantity',this.value)"></div>
          <div class="form-group" style="flex:1 1 100%;margin:0;"><label>Description</label><input type="text" value="${esc(item.description)}" placeholder="Damage, properties, etc." onchange="updateCustomTreasure(${idx},'description',this.value)"></div>
        </div>
        <div class="item-actions" style="display:flex;align-items:center;gap:6px;">
          <button type="button" class="btn btn-primary btn-small" onclick="finishCustomTreasure(${idx})">Done</button>
          <button type="button" class="remove-item" onclick="removeFromTreasures(${idx})">&times;</button>
        </div>
      </div>`;
    }
    return `
      <div class="list-item" style="flex-wrap:wrap;align-items:center;padding:10px 12px;gap:8px;">
        <div style="flex:1;min-width:150px;">
          <strong>${esc(item.name)}</strong>
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(item.type || '')}</span>
          <div style="font-size:0.85rem;color:var(--text-muted);margin-top:2px;">${esc(item.description || '')}</div>
        </div>
        <div class="item-actions" style="display:flex;align-items:center;gap:6px;">
          <select id="treasure-assign-${idx}" style="padding:4px 8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.85rem;">
            <option value="">Assign to...</option>
            ${charOptions}
          </select>
          <button type="button" class="btn btn-primary btn-small" onclick="assignTreasure(${idx})">Assign</button>
          <button type="button" class="remove-item" onclick="removeFromTreasures(${idx})">&times;</button>
        </div>
      </div>`;
  }).join('');
  treasurePool.forEach((item, i) => {
    if (item._assignTo) { const sel = document.getElementById(`treasure-assign-${i}`); if (sel) sel.value = item._assignTo; }
  });
}

async function assignTreasure(idx) {
  const item = treasurePool[idx];
  if (!item) return;
  const select = document.getElementById(`treasure-assign-${idx}`);
  const characterId = select.value;
  if (!characterId) { dialogAlert('Select a character first.', 'Assign Treasure', 'info'); return; }

  const c = await db.getCharacter(characterId);
  if (!c) { dialogAlert('Character not found.', 'Error', 'error'); return; }
  const equipment = c.equipment || [];
  if (equipment.length >= 50) { dialogAlert('Equipment limit reached (max 50).', 'Limit Reached', 'error'); return; }
  equipment.push({ name: item.name, type: item.type, description: item.description, quantity: item.quantity });
  c.equipment = equipment;
  await db.putCharacter(c);
  broadcastCharacterToPlayer(characterId);

  snapshotTreasureSelections();
  treasurePool.splice(idx, 1);
  renderTreasures();
  saveTreasures();
  loadCharacters();
}

// --- Shops (IndexedDB) ---
async function loadShops() {
  shops = await db.getShops();
  renderShops();
}

function saveShops() {
  const clean = shops.map(s => ({
    id: s.id, name: s.name,
    items: s.items.map(it => ({
      name: it.name, type: it.type, description: it.description,
      price: it.price, denomination: it.denomination, quantity: it.quantity
    }))
  }));
  db.saveShops(clean);
}

async function createShop() {
  if (shops.length >= 20) { dialogAlert('Maximum 20 shops.', 'Limit Reached', 'error'); return; }
  const name = await dialogPrompt('Enter shop name:', 'New Shop');
  if (!name) return;
  shops.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name, items: [] });
  renderShops();
  saveShops();
}

async function deleteShop(shopIdx) {
  if (!await dialogConfirm(`Delete shop "${shops[shopIdx].name}"?`, 'Delete Shop')) return;
  shops.splice(shopIdx, 1);
  renderShops();
  saveShops();
}

function parseCostString(costStr) {
  if (!costStr || costStr === '—') return { price: 0, denomination: 'GP' };
  const match = costStr.match(/^([\d,]+)\s*(CP|SP|EP|GP|PP)/i);
  if (match) return { price: parseInt(match[1].replace(',', '')), denomination: match[2].toUpperCase() };
  return { price: 0, denomination: 'GP' };
}

let _activeShopIdx = -1;

function openShopItemModal(shopIdx) {
  _activeShopIdx = shopIdx;
  document.getElementById('shop-search-modal').showModal();
  const searchInput = document.getElementById('shop-item-search');
  searchInput.value = '';
  document.getElementById('shop-item-type-filter').value = '';
  document.getElementById('shop-item-results').style.display = 'none';
  searchInput.focus();
}

function filterShopItems() {
  const query = document.getElementById('shop-item-search').value.trim().toLowerCase();
  const typeFilter = document.getElementById('shop-item-type-filter').value;
  const resultsEl = document.getElementById('shop-item-results');
  if (!query && !typeFilter) { resultsEl.style.display = 'none'; return; }
  let filtered = allEquipment;
  if (typeFilter) filtered = filtered.filter(e => e.type === typeFilter);
  if (query) filtered = filtered.filter(e =>
    e.name.toLowerCase().includes(query) || (e.category && e.category.toLowerCase().includes(query))
  );
  resultsEl.style.display = '';
  resultsEl.innerHTML = filtered.slice(0, 50).map((e, i) => {
    let detail = e.category || '';
    if (e.damage) detail += ` | ${e.damage}`;
    if (e.AC) detail += ` | AC: ${e.AC}`;
    if (e.cost) detail += ` | ${e.cost}`;
    return `<div class="list-item" style="cursor:pointer;" onclick="addItemToShop(${i})">
        <div><strong>${esc(e.name)}</strong><span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(detail)}</span></div>
      </div>`;
  }).join('') || '<div style="padding:8px;color:var(--text-muted);">No items found</div>';
  resultsEl._filtered = filtered;
}

function addItemToShop(filteredIdx) {
  const resultsEl = document.getElementById('shop-item-results');
  const e = resultsEl._filtered[filteredIdx];
  if (!e || _activeShopIdx < 0 || !shops[_activeShopIdx]) return;
  let desc = '';
  if (e.damage) desc += e.damage;
  if (e.AC) desc += (desc ? ' | ' : '') + 'AC: ' + e.AC;
  if (e.properties && e.properties !== '—') desc += (desc ? ' | ' : '') + e.properties;
  const { price, denomination } = parseCostString(e.cost);
  shops[_activeShopIdx].items.push({ name: e.name, type: e.category || e.type, description: desc, price, denomination, quantity: -1 });
  renderShops();
  saveShops();
  showToast(`${e.name} added to shop`);
}

function addCustomShopItem(shopIdx) {
  shops[shopIdx].items.push({ name: '', type: '', description: '', price: 0, denomination: 'GP', quantity: -1, _editing: true });
  renderShops();
  const inputs = document.querySelectorAll(`#shop-inventory-${shopIdx} .shop-item-name`);
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function addCustomShopItemFromModal() {
  if (_activeShopIdx < 0 || !shops[_activeShopIdx]) return;
  addCustomShopItem(_activeShopIdx);
}

function removeShopItem(shopIdx, itemIdx) { shops[shopIdx].items.splice(itemIdx, 1); renderShops(); saveShops(); }

function updateShopItem(shopIdx, itemIdx, field, value) {
  const item = shops[shopIdx].items[itemIdx];
  if (!item) return;
  if (field === 'price') item.price = Math.max(0, parseInt(value) || 0);
  else if (field === 'quantity') item.quantity = parseInt(value) || -1;
  else item[field] = value;
  saveShops();
}

function finishCustomShopItem(shopIdx, itemIdx) {
  const item = shops[shopIdx]?.items[itemIdx];
  if (!item) return;
  if (!item.name.trim()) { dialogAlert('Please enter an item name.', 'Custom Item', 'info'); return; }
  item._editing = false;
  renderShops();
  saveShops();
}

function renderShops() {
  const container = document.getElementById('shops-list');
  const emptyMsg = document.getElementById('shops-empty');
  const savedSelections = {};
  shops.forEach((shop, si) => {
    shop.items.forEach((_, ii) => {
      const sel = document.getElementById(`shop-sell-${si}-${ii}`);
      if (sel && sel.value) savedSelections[`${si}-${ii}`] = sel.value;
    });
  });
  if (shops.length === 0) { container.innerHTML = ''; emptyMsg.style.display = ''; return; }
  emptyMsg.style.display = 'none';
  const charOptions = allCharacters.map(c => `<option value="${c._id}">${esc(c.name)}</option>`).join('');
  container.innerHTML = shops.map((shop, si) => {
    const itemsHtml = shop.items.map((item, ii) => {
      if (item._editing) {
        return `<div class="list-item shop-item-edit-row" style="border-left:3px solid var(--gold);">
            <div class="form-group shop-edit-name"><label>Name</label><input type="text" class="shop-item-name" value="${esc(item.name)}" placeholder="Item name" onchange="updateShopItem(${si},${ii},'name',this.value)"></div>
            <div class="form-group shop-edit-type"><label>Type</label><input type="text" value="${esc(item.type)}" placeholder="Type" onchange="updateShopItem(${si},${ii},'type',this.value)"></div>
            <div class="form-group shop-edit-price"><label>Price</label><input type="number" value="${item.price}" min="0" onchange="updateShopItem(${si},${ii},'price',this.value)"></div>
            <div class="form-group shop-edit-denom"><label>Denom.</label>
              <select onchange="updateShopItem(${si},${ii},'denomination',this.value)">
                ${['CP','SP','EP','GP','PP'].map(d => `<option value="${d}" ${item.denomination === d ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <div class="form-group shop-edit-desc"><label>Description</label><input type="text" value="${esc(item.description)}" placeholder="Description" onchange="updateShopItem(${si},${ii},'description',this.value)"></div>
            <div class="item-actions shop-edit-actions">
              <button type="button" class="btn btn-primary btn-small" onclick="finishCustomShopItem(${si},${ii})">Done</button>
              <button type="button" class="remove-item" onclick="removeShopItem(${si},${ii})">&times;</button>
            </div>
          </div>`;
      }
      return `<div class="list-item" style="flex-wrap:wrap;align-items:center;padding:8px 12px;gap:6px;">
          <div style="flex:1;min-width:150px;">
            <strong>${esc(item.name)}</strong>
            <span style="color:var(--text-muted);font-size:0.8rem;margin-left:6px;">${esc(item.type || '')}</span>
            <div style="font-size:0.85rem;color:var(--text-muted);margin-top:2px;">${esc(item.description || '')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-weight:600;color:var(--gold);min-width:70px;">
            <input type="number" value="${item.price}" min="0" style="width:50px;padding:2px 4px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;text-align:right;" onchange="updateShopItem(${si},${ii},'price',this.value)">
            <select onchange="updateShopItem(${si},${ii},'denomination',this.value)" style="padding:2px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.85rem;">
              ${['CP','SP','EP','GP','PP'].map(d => `<option value="${d}" ${item.denomination === d ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
          <div class="item-actions" style="display:flex;align-items:center;gap:6px;">
            <select id="shop-sell-${si}-${ii}" style="padding:4px 8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.85rem;">
              <option value="">Sell to...</option>
              ${charOptions}
            </select>
            <button type="button" class="btn btn-primary btn-small" onclick="sellShopItem(${si},${ii})">Sell</button>
            <button type="button" class="remove-item" onclick="removeShopItem(${si},${ii})">&times;</button>
          </div>
        </div>`;
    }).join('');
    return `<div class="card" style="margin-top:12px;border-left:3px solid var(--gold);">
        <div class="header-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="margin:0;">${esc(shop.name)}</h3>
          <button class="remove-item" onclick="deleteShop(${si})" title="Delete Shop">&times;</button>
        </div>
        <div id="shop-inventory-${si}" style="margin-top:8px;">
          ${itemsHtml || '<p style="color:var(--text-muted);margin:4px 0;">No items in this shop yet.</p>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button type="button" class="btn btn-primary btn-small" onclick="openShopItemModal(${si})">+ Add Items</button>
        </div>
      </div>`;
  }).join('');
  for (const [key, val] of Object.entries(savedSelections)) { const sel = document.getElementById(`shop-sell-${key}`); if (sel) sel.value = val; }
}

async function sellShopItem(shopIdx, itemIdx) {
  const shop = shops[shopIdx];
  if (!shop) return;
  const item = shop.items[itemIdx];
  if (!item) return;
  const select = document.getElementById(`shop-sell-${shopIdx}-${itemIdx}`);
  const characterId = select.value;
  if (!characterId) { dialogAlert('Select a character first.', 'Sell Item', 'info'); return; }

  const c = await db.getCharacter(characterId);
  if (!c) { dialogAlert('Character not found.', 'Error', 'error'); return; }
  const currency = c.currency || { CP: 0, SP: 0, EP: 0, GP: 0, PP: 0 };
  const equipment = c.equipment || [];
  const validDenoms = ['CP', 'SP', 'EP', 'GP', 'PP'];
  const denom = validDenoms.includes(item.denomination) ? item.denomination : 'GP';
  const price = Math.max(0, Math.min(999999, parseInt(item.price) || 0));
  if (price > 0 && (currency[denom] || 0) < price) {
    dialogAlert(`Not enough ${denom} (need ${price}, have ${currency[denom] || 0}).`, 'Insufficient Funds', 'error'); return;
  }
  if (equipment.length >= 50) { dialogAlert('Equipment limit reached (max 50).', 'Limit Reached', 'error'); return; }

  if (price > 0) currency[denom] -= price;
  equipment.push({ name: item.name, type: item.type, description: item.description, quantity: 1 });
  c.currency = currency;
  c.equipment = equipment;
  await db.putCharacter(c);
  broadcastCharacterToPlayer(characterId);

  if (item.quantity > 0) {
    item.quantity--;
    if (item.quantity === 0) shop.items.splice(itemIdx, 1);
    saveShops();
  }

  const charName = allCharacters.find(ch => ch._id === characterId)?.name || 'character';
  renderShops();
  loadCharacters();

  const newBtn = document.getElementById(`shop-sell-${shopIdx}-${itemIdx}`)?.parentElement?.querySelector('.btn-primary');
  if (newBtn) {
    const orig = newBtn.textContent;
    newBtn.textContent = `Sold to ${charName}!`;
    newBtn.style.background = 'var(--gold)';
    newBtn.disabled = true;
    setTimeout(() => { newBtn.textContent = orig; newBtn.style.background = ''; newBtn.disabled = false; }, 2000);
  }
}

// --- Notes (IndexedDB) ---
async function loadNotes() {
  const notes = await db.getNotes();
  document.getElementById('notes-editor').value = notes;
}

async function saveNotes() {
  const notes = document.getElementById('notes-editor').value;
  await db.saveNotes(notes);
  document.getElementById('notes-save-status').textContent = 'Saved';
  setTimeout(() => { document.getElementById('notes-save-status').textContent = ''; }, 2000);
}
