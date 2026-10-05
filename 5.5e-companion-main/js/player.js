// --- Dialog helper (mirrors the DM-side showDialog/dialogAlert API
//     so both pages behave the same on ESC, focus return, etc.) ---
function dialogAlert(message, title, type = 'info') {
  return new Promise(resolve => {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const btnsEl = document.getElementById('dialog-buttons');

    titleEl.textContent = title || (type === 'error' ? 'Error' : 'Notice');
    msgEl.textContent = message || '';
    btnsEl.innerHTML = '<button class="btn btn-primary btn-small">OK</button>';

    const done = () => {
      overlay.removeEventListener('cancel', onCancel);
      overlay.close();
      resolve();
    };
    const onCancel = (e) => { e.preventDefault(); done(); };

    btnsEl.querySelector('button').addEventListener('click', done);
    overlay.addEventListener('cancel', onCancel);
    overlay.showModal();
  });
}

// SKILL_ABILITIES is defined in constants.js

function calcProfBonus(level) {
  return Math.ceil(level / 4) + 1;
}

// Extract roomId from URL query param: player.html?room=<roomId>
const roomId = new URLSearchParams(window.location.search).get('room');
let sessionPin = '';
let activeCharacterId = null;
let playerPeer = null;
let currentCharacter = null; // cached character data from DM
let currentHPState = null;   // cached HP state from DM
let joinTimeout = null;
let _autoReclaiming = false; // true while auto-reclaiming after reconnect

// Player-local session state (preserved across DM updates)
let playerState = {
  slotChecks: {}   // { "1-0": true, "2-1": false, ... }
};

// --- Disconnect banner helpers ---
function showBanner(text, isError = false) {
  const banner = document.getElementById('disconnect-banner');
  if (!banner) return;
  banner.textContent = text;
  banner.className = isError
    ? 'alert alert-error fixed top-0 left-0 right-0 z-[1000] rounded-none justify-center py-2 text-sm'
    : 'alert alert-warning fixed top-0 left-0 right-0 z-[1000] rounded-none justify-center py-2 text-sm';
  banner.style.display = 'flex';
}

function hideBanner() {
  const banner = document.getElementById('disconnect-banner');
  if (banner) { banner.style.display = 'none'; }
}

document.addEventListener('DOMContentLoaded', () => {
  // If ?shared=<base64UTF8-encoded JSON> is provided, render that character without joining a session.
  const sharedData = new URLSearchParams(window.location.search).get('shared');
  if (sharedData) {
    try {
      const json = decodeURIComponent(escape(atob(decodeURIComponent(sharedData))));
      const character = JSON.parse(json);
      currentCharacter = character;
      currentHPState = { currentHP: character.HP || 0, tempHP: 0 };
      activeCharacterId = character._id || 'shared-character';
      document.getElementById('step-join').style.display = 'none';
      document.getElementById('step-pick').style.display = 'none';
      document.getElementById('step-sheet').style.display = '';
      renderCharacterSheet(character, currentHPState);
    } catch (err) {
      console.error('Unable to decode shared character payload:', err);
      // Fall back to normal join flow
    }
  }

  document.getElementById('btn-join').addEventListener('click', joinSession);
  document.getElementById('player-pin').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinSession();
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('tab-active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('tab-active');
      tab.setAttribute('aria-selected', 'true');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });

  // Re-attempt connection when the user returns to the tab (handles mobile backgrounding)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playerPeer && !playerPeer.isConnected() && sessionPin) {
      playerPeer.reconnectNow();
    }
  });

  // Re-attempt connection when the network comes back online
  window.addEventListener('online', () => {
    if (playerPeer && !playerPeer.isConnected() && sessionPin) {
      playerPeer.reconnectNow();
    }
  });
});

async function joinSession() {
  sessionPin = document.getElementById('player-pin').value.trim();
  const errorEl = document.getElementById('join-error');
  errorEl.style.display = 'none';

  if (!sessionPin) { errorEl.textContent = 'Please enter the PIN'; errorEl.style.display = 'block'; return; }

  activeCharacterId = null;

  try {
    await _initPlayerPeer();
  } catch (err) {
    console.error('[Player] Connection failed:', err);
    errorEl.textContent = 'Could not connect to DM. Make sure the session is active.';
    errorEl.style.display = 'block';
  }
}

async function _initPlayerPeer() {
  // Tear down any previous peer cleanly
  if (playerPeer) {
    playerPeer.cancelReconnect();
    playerPeer.destroy();
    playerPeer = null;
  }

  playerPeer = peerManager.createPlayerPeer(roomId);

  playerPeer.onMessage(handleDMMessage);
  playerPeer.onDisconnect(handleDisconnect);
  playerPeer.onReconnecting(handleReconnecting);
  playerPeer.onConnect(handleConnected);

  // Show loading state
  document.getElementById('btn-join').disabled = true;
  document.getElementById('btn-join').textContent = 'Connecting...';

  await playerPeer.connect();

  // Connected — send join request
  playerPeer.sendToDM({ type: 'join', pin: sessionPin });

  // Timeout if DM never responds
  joinTimeout = setTimeout(() => {
    document.getElementById('btn-join').disabled = false;
    document.getElementById('btn-join').textContent = 'Join';
    const errorEl = document.getElementById('join-error');
    errorEl.textContent = 'No response from DM. Check the PIN and try again.';
    errorEl.style.display = 'block';
  }, 8000);
}

// Called every time the WebRTC connection to DM opens (initial connect AND after auto-reconnect)
function handleConnected() {
  hideBanner();
  document.getElementById('btn-join').disabled = false;
  document.getElementById('btn-join').textContent = 'Join';

  // After auto-reconnect, re-join the session so the DM recognises us again.
  // If we already had a character claimed, we'll auto-reclaim it in handleDMMessage.
  if (sessionPin && activeCharacterId) {
    playerPeer.sendToDM({ type: 'join', pin: sessionPin });
  }
}

function handleDisconnect() {
  showBanner('Connection lost. Reconnecting...', false);
}

function handleReconnecting(attempt, delay) {
  const secs = Math.round(delay / 1000);
  showBanner(`Reconnecting… (attempt ${attempt}, retrying in ${secs}s)`, false);
}

function handleDMMessage(msg) {
  switch (msg.type) {
    case 'join-ok':
      clearTimeout(joinTimeout);
      document.getElementById('btn-join').disabled = false;
      document.getElementById('btn-join').textContent = 'Join';
      // If we previously had a character, auto-reclaim it (reconnect scenario).
      // Always attempt reclaim regardless of claimed status — the DM will allow it
      // if the old connection is stale (e.g. phone was backgrounded).
      if (activeCharacterId) {
        const prev = msg.characters.find(c => c._id === activeCharacterId);
        if (prev) {
          _autoReclaiming = true;
          playerPeer.sendToDM({ type: 'claim', characterId: activeCharacterId, playerName: 'player-' + Date.now() });
          break;
        }
        // Character no longer in session — fall through to picker
        activeCharacterId = null;
        currentCharacter = null;
        currentHPState = null;
      }
      document.getElementById('step-join').style.display = 'none';
      document.getElementById('step-pick').style.display = '';
      document.getElementById('step-sheet').style.display = 'none';
      renderCharacterPicker(msg.characters);
      break;

    case 'join-error':
      clearTimeout(joinTimeout);
      document.getElementById('btn-join').disabled = false;
      document.getElementById('btn-join').textContent = 'Join';
      const errorEl = document.getElementById('join-error');
      errorEl.textContent = msg.error;
      errorEl.style.display = 'block';
      break;

    case 'claim-ok':
      clearTimeout(joinTimeout);
      _autoReclaiming = false;
      activeCharacterId = msg.characterId;
      currentCharacter = msg.character;
      currentHPState = msg.hpState;
      hideBanner();
      renderCharacterSheet(currentCharacter, currentHPState);
      break;

    case 'claim-error':
      if (_autoReclaiming) {
        // Auto-reclaim after reconnect failed (someone else truly has it).
        // Fall back to the character picker gracefully.
        _autoReclaiming = false;
        activeCharacterId = null;
        currentCharacter = null;
        currentHPState = null;
        // Re-send join to get a fresh character list for the picker.
        playerPeer.sendToDM({ type: 'join', pin: sessionPin });
      } else {
        dialogAlert(msg.error || 'Could not select character', 'Error', 'error');
      }
      break;

    case 'character-update':
      if (msg.characterId === activeCharacterId) {
        currentCharacter = msg.character;
        currentHPState = msg.hpState;
        renderCharacterSheet(currentCharacter, currentHPState);
      }
      break;

    case 'character-list':
      // DM may re-send character list (e.g. after adding characters to session)
      if (!activeCharacterId) {
        renderCharacterPicker(msg.characters);
      }
      break;

    case 'pong':
      // Heartbeat response — connection is confirmed alive, nothing else needed
      break;
  }
}

function renderCharacterPicker(characters) {
  const container = document.getElementById('pick-list');

  container.innerHTML = characters.map(c => {
    if (c.claimed) {
      return `
        <div class="char-item" style="opacity:0.5;cursor:default;">
          <div class="char-info">
            <span class="char-name">${esc(c.name)}</span>
            <span class="char-meta">Level ${c.level} ${esc(c.species || '')} ${esc(c.class)}</span>
          </div>
          <span style="color:var(--text-muted);font-size:0.85rem;">Claimed</span>
        </div>
      `;
    }
    return `
      <div class="char-item" onclick="claimCharacter('${c._id}')">
        <div class="char-info">
          <span class="char-name">${esc(c.name)}</span>
          <span class="char-meta">Level ${c.level} ${esc(c.species || '')} ${esc(c.class)}</span>
        </div>
        <span style="color:var(--gold);">Select</span>
      </div>
    `;
  }).join('');

  if (characters.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">No characters available yet. Wait for your DM to add characters to the session.</p>';
  }
}

function claimCharacter(characterId) {
  playerPeer.sendToDM({
    type: 'claim',
    characterId,
    playerName: 'player-' + Date.now()
  });
}

function renderCharacterSheet(c, hpState) {
  const isFirstLoad = !document.getElementById('step-sheet').style.display || document.getElementById('step-sheet').style.display === 'none';

  document.getElementById('step-join').style.display = 'none';
  document.getElementById('step-pick').style.display = 'none';
  document.getElementById('step-sheet').style.display = '';

  const bg = c.background ? ` - ${c.background}` : '';
  const h1 = document.querySelector('h1');
  h1.textContent = `${c.name} ${c.species || ''} ${c.class} lvl ${c.level}${bg}`;
  h1.classList.add('char-title');

  const profBonus = calcProfBonus(c.level);
  const maxHP = c.HP || 0;
  const currentHP = hpState ? hpState.currentHP : maxHP;
  const tempHP = hpState ? (hpState.tempHP || 0) : 0;

  if (isFirstLoad) {
    playerState.slotChecks = {};
  }

  const hpPercent = maxHP > 0 ? Math.max(0, (currentHP / maxHP) * 100) : 0;
  let hpColor = 'var(--hp-high, #4caf50)';
  if (hpPercent <= 25) hpColor = 'var(--hp-low, #e53935)';
  else if (hpPercent <= 50) hpColor = 'var(--hp-mid, #ff9800)';

  document.getElementById('combat-stats').innerHTML = `
    <div class="combat-stat">
      <div class="label">Hit Points</div>
      <div class="hp-tracker">
        <div class="bf-hp-bar-container" style="margin:4px 0;">
          <div class="bf-hp-bar" style="width:${hpPercent}%;background:${hpColor};"></div>
        </div>
        <div class="value" style="font-size:1.2rem;">${currentHP} / ${maxHP}</div>
        ${tempHP > 0 ? `<div style="color:var(--text-muted);font-size:0.85rem;">Temp HP: ${tempHP}</div>` : ''}
      </div>
    </div>
    <div class="combat-stat">
      <div class="label">Armor Class</div>
      <div class="value">${c.AC}</div>
    </div>
  `;

  document.getElementById('save-prof-bonus-label').textContent = `(Proficiency Bonus: +${profBonus})`;
  document.getElementById('prof-bonus-label').textContent = `(Proficiency Bonus: +${profBonus})`;

  document.getElementById('ability-grid').innerHTML = ABILITIES.map(a => {
    const score = c[a] || 10;
    const mod = Math.floor((score - 10) / 2);
    const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
    return `
      <div class="stat-box">
        <div class="stat-label">${a}</div>
        <div class="stat-mod">${modStr}</div>
        <div class="stat-value">${score}</div>
      </div>
    `;
  }).join('');

  const classSaves = CLASS_SAVING_THROWS[c.class] || [];
  document.getElementById('saving-throws-grid').innerHTML = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map(a => {
    const abilityScore = c[a] || 10;
    const abilityMod = Math.floor((abilityScore - 10) / 2);
    const proficient = classSaves.includes(a);
    const total = abilityMod + (proficient ? profBonus : 0);
    const modStr = total >= 0 ? `+${total}` : `${total}`;
    return `
      <div class="skill-item">
        <span>${proficient ? '<strong style="color:var(--accent);">*</strong> ' : ''}${a}</span>
        <span class="skill-mod">${modStr}</span>
      </div>
    `;
  }).join('');

  document.getElementById('skills-grid').innerHTML = SKILL_ABILITIES.map((s, i) => {
    const abilityScore = c[s.ability] || 10;
    const abilityMod = Math.floor((abilityScore - 10) / 2);
    const proficient = c.skills && c.skills[i];
    const total = abilityMod + (proficient ? profBonus : 0);
    const modStr = total >= 0 ? `+${total}` : `${total}`;
    return `
      <div class="skill-item">
        <span>${proficient ? '<strong style="color:var(--accent);">*</strong> ' : ''}${s.name} <span style="color:var(--text-muted);font-size:0.75rem;">(${s.ability})</span></span>
        <span class="skill-mod">${modStr}</span>
      </div>
    `;
  }).join('');

  const features = c.features || [];
  document.getElementById('features-list').innerHTML = features.length === 0
    ? '<p style="color:var(--text-muted)">No features.</p>'
    : `<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;">${
        features.map(f => {
          const name = typeof f === 'string' ? f : f.name;
          const sourceDetail = typeof f === 'string' ? '' : (f.sourceDetail || '');
          const description = typeof f === 'string' ? '' : (f.description || '');
          return `<div class="list-item" style="flex-wrap:wrap;">
            <div style="flex:1;">
              <strong>${esc(name)}</strong>
              ${sourceDetail ? `<span class="badge badge-sm badge-ghost" style="margin-left:6px;">${esc(sourceDetail)}</span>` : ''}
              ${description ? `<div style="font-size:0.85rem;color:var(--text-muted);margin-top:2px;">${esc(description)}</div>` : ''}
            </div>
          </div>`;
        }).join('')
      }</div>`;

  // --- Currency (read-only, managed by DM) ---
  const cur = c.currency || {};
  const coinDefs = [
    { key: 'CP', cls: 'cp', name: 'Copper' },
    { key: 'SP', cls: 'sp', name: 'Silver' },
    { key: 'EP', cls: 'ep', name: 'Electrum' },
    { key: 'GP', cls: 'gp', name: 'Gold' },
    { key: 'PP', cls: 'pp', name: 'Platinum' },
  ];

  const currencyHtml = `
    <h3>Purse</h3>
    <div class="purse-grid">
      ${coinDefs.map(({ key }) => {
        const amount = cur[key] || 0;
        return `
        <div class="purse-item${amount === 0 ? ' zero' : ''}">
          <span class="purse-amount-val">${amount}</span>
          <span class="purse-abbr">${key}</span>
        </div>`;
      }).join('')}
    </div>
  `;

  const equipment = c.equipment || [];
  const equipHtml = equipment.length === 0
    ? '<p style="color:var(--text-muted)">No equipment.</p>'
    : equipment.map(eq => `
      <div class="item-card">
        <h4>${esc(eq.name)} ${eq.quantity > 1 ? `(x${eq.quantity})` : ''}</h4>
        <div class="meta">${esc(eq.type)}</div>
        <div class="desc">${esc(eq.description)}</div>
      </div>
    `).join('');

  document.getElementById('equipment-display').innerHTML = currencyHtml + '<h3>Equipment</h3>' + equipHtml;

  // --- Spellcasting Info ---
  const spellcastingAbility = SPELLCASTING_ABILITY[c.class] || null;
  const spellcastingInfoEl = document.getElementById('spellcasting-info');
  const spellSlotsEl = document.getElementById('spell-slots-display');

  if (spellcastingAbility) {
    const abilityScore = c[spellcastingAbility] || 10;
    const abilityMod = Math.floor((abilityScore - 10) / 2);
    const spellSaveDC = 8 + profBonus + abilityMod;
    const spellAttack = profBonus + abilityMod;
    const attackStr = spellAttack >= 0 ? `+${spellAttack}` : `${spellAttack}`;

    const known = getSpellsKnown(c.class, c.level);
    spellcastingInfoEl.innerHTML = `
      <div class="combat-stats" style="margin-bottom:16px;">
        <div class="combat-stat">
          <div class="label">Spellcasting Ability</div>
          <div class="value" style="font-size:1.4rem;">${spellcastingAbility}</div>
        </div>
        <div class="combat-stat">
          <div class="label">Spell Save DC</div>
          <div class="value">${spellSaveDC}</div>
        </div>
        <div class="combat-stat">
          <div class="label">Spell Attack</div>
          <div class="value">${attackStr}</div>
        </div>
        ${known.cantrips > 0 ? `<div class="combat-stat">
          <div class="label">Cantrips Known</div>
          <div class="value">${known.cantrips}</div>
        </div>` : ''}
        <div class="combat-stat">
          <div class="label">Prepared Spells</div>
          <div class="value">${known.prepared}</div>
        </div>
      </div>
    `;

    // Spell slots
    const slotInfo = getSpellSlots(c.class, c.level);
    if (slotInfo.type === 'pact') {
      const slotSummary = `Pact Magic: ${slotInfo.slots} slot${slotInfo.slots > 1 ? 's' : ''} at level ${slotInfo.slotLevel}`;
      spellSlotsEl.innerHTML = `
        <div class="item-card" style="margin-bottom:16px;">
          <h4>Pact Magic <span style="font-size:0.8rem;font-weight:normal;color:var(--text-muted);">(recharge on short rest)</span></h4>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:6px;">${slotSummary}</div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:8px;">
            <span class="stat-label" style="margin:0;">Level ${slotInfo.slotLevel}</span>
            ${Array.from({length: slotInfo.slots}, (_, j) => {
              const key = `pact-${j}`;
              const checked = playerState.slotChecks[key] ? 'checked' : '';
              return `
              <label class="slot-bubble">
                <input type="checkbox" data-slot="${key}" ${checked}>
                <span class="slot-circle"></span>
              </label>`;
            }).join('')}
          </div>
        </div>
      `;
    } else if (slotInfo.slots.length > 0) {
      const slotSummary = 'Spell slots: ' + slotInfo.slots.map((n, i) => `L${i + 1}: ${n}`).join(' · ');
      spellSlotsEl.innerHTML = `
        <div style="margin-bottom:16px;">
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px;">${slotSummary}</div>
          ${slotInfo.slots.map((count, i) => `
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
              <span class="stat-label" style="min-width:32px;margin:0;">${i + 1}${ordinal(i + 1)}</span>
              ${Array.from({length: count}, (_, j) => {
                const key = `${i + 1}-${j}`;
                const checked = playerState.slotChecks[key] ? 'checked' : '';
                return `
                <label class="slot-bubble">
                  <input type="checkbox" data-slot="${key}" ${checked}>
                  <span class="slot-circle"></span>
                </label>`;
              }).join('')}
            </div>
          `).join('')}
        </div>
      `;
    } else {
      spellSlotsEl.innerHTML = '';
    }

    // Persist slot check state on change
    spellSlotsEl.querySelectorAll('input[data-slot]').forEach(cb => {
      cb.addEventListener('change', () => {
        playerState.slotChecks[cb.dataset.slot] = cb.checked;
      });
    });
  } else {
    spellcastingInfoEl.innerHTML = '';
    spellSlotsEl.innerHTML = '';
  }

  // --- Spell list ---
  const spells = c.spells || [];
  const spellsByLevel = {};
  spells.forEach(sp => {
    const key = sp.level === 0 ? 0 : sp.level;
    if (!spellsByLevel[key]) spellsByLevel[key] = [];
    spellsByLevel[key].push(sp);
  });

  if (spells.length === 0) {
    document.getElementById('spells-display').innerHTML = spellcastingAbility
      ? '<p style="color:var(--text-muted)">No spells prepared.</p>'
      : '<p style="color:var(--text-muted)">This class does not use spells.</p>';
  } else {
    let spellHtml = '';
    for (const level of Object.keys(spellsByLevel).sort((a, b) => a - b)) {
      const label = level === '0' ? 'Cantrips' : `Level ${level}`;
      spellHtml += `<h3 style="margin:16px 0 8px;">${label}</h3>`;
      spellHtml += spellsByLevel[level].map(sp => {
        const tags = [];
        if (sp.concentration) tags.push('Concentration');
        if (sp.ritual) tags.push('Ritual');
        return `
          <div class="item-card">
            <h4>${esc(sp.name)} ${tags.length ? '<span style="color:var(--accent);font-size:0.8rem;font-weight:normal;">(' + tags.join(', ') + ')</span>' : ''}</h4>
            <div class="meta">
              ${esc(sp.school)} |
              Cast: ${esc(sp.castingTime)} |
              Range: ${esc(sp.range)} |
              Duration: ${esc(sp.duration || 'Instantaneous')} |
              Components: ${esc(sp.components)}
            </div>
            <div class="desc">${esc(sp.description)}</div>
          </div>
        `;
      }).join('');
    }
    document.getElementById('spells-display').innerHTML = spellHtml;
  }
}

function ordinal(n) {
  if (n === 1) return 'st';
  if (n === 2) return 'nd';
  if (n === 3) return 'rd';
  return 'th';
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
