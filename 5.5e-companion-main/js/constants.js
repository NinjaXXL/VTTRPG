/* ============================================================
   Modal focus management — shared by DM and player pages.
   Patches HTMLDialogElement.prototype once so every <dialog>
   used as a modal returns focus to its trigger on close, and
   moves focus to the first meaningful field on open (skipping
   the × close button which would otherwise win on source order).
   ============================================================ */
(function setupModalFocus() {
  if (typeof HTMLDialogElement === 'undefined') return;
  const proto = HTMLDialogElement.prototype;
  if (proto.__focusPatched) return;
  proto.__focusPatched = true;

  const FOCUSABLE = [
    'input:not([type="hidden"]):not([disabled]):not([readonly])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    'button:not([disabled]):not(.modal-close)',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const origShow = proto.showModal;
  const origClose = proto.close;

  proto.showModal = function (...args) {
    const active = document.activeElement;
    this._returnFocus = (active instanceof HTMLElement && active !== document.body) ? active : null;
    const result = origShow.apply(this, args);
    requestAnimationFrame(() => {
      if (!this.open) return;
      // Respect explicit autofocus if the browser already honored it.
      if (this.querySelector('[autofocus]') && this.contains(document.activeElement)) return;
      const target = this.querySelector(FOCUSABLE);
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: false }); } catch (_) { target.focus(); }
      }
    });
    return result;
  };

  proto.close = function (...args) {
    const ret = this._returnFocus;
    this._returnFocus = null;
    const result = origClose.apply(this, args);
    if (ret && document.contains(ret) && typeof ret.focus === 'function') {
      requestAnimationFrame(() => {
        try { ret.focus({ preventScroll: true }); } catch (_) {}
      });
    }
    return result;
  };
})();

const CLASSES = [
  'Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter',
  'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer',
  'Warlock', 'Wizard'
];

const SPECIES = [
  'Aasimar', 'Dragonborn', 'Dwarf', 'Elf', 'Gnome',
  'Goliath', 'Halfling', 'Human', 'Orc', 'Tiefling'
];

const BACKGROUNDS = [
  'Acolyte', 'Criminal', 'Sage', 'Soldier'
];

// Hit die per class (max value = level 1 HP before CON modifier)
const HIT_DIE = {
  Barbarian: 12, Bard: 8, Cleric: 8, Druid: 8, Fighter: 10,
  Monk: 8, Paladin: 10, Ranger: 10, Rogue: 8, Sorcerer: 6,
  Warlock: 8, Wizard: 6
};

const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

// Skill → ability score mapping (18 skills, SRD 5.2)
const SKILL_ABILITIES = [
  { name: 'Acrobatics',      ability: 'DEX' },
  { name: 'Animal Handling', ability: 'WIS' },
  { name: 'Arcana',          ability: 'INT' },
  { name: 'Athletics',       ability: 'STR' },
  { name: 'Deception',       ability: 'CHA' },
  { name: 'History',         ability: 'INT' },
  { name: 'Insight',         ability: 'WIS' },
  { name: 'Intimidation',    ability: 'CHA' },
  { name: 'Investigation',   ability: 'INT' },
  { name: 'Medicine',        ability: 'WIS' },
  { name: 'Nature',          ability: 'INT' },
  { name: 'Perception',      ability: 'WIS' },
  { name: 'Performance',     ability: 'CHA' },
  { name: 'Persuasion',      ability: 'CHA' },
  { name: 'Religion',        ability: 'INT' },
  { name: 'Sleight of Hand', ability: 'DEX' },
  { name: 'Stealth',         ability: 'DEX' },
  { name: 'Survival',        ability: 'WIS' }
];

// Saving throw proficiencies per class (SRD 5.2)
const CLASS_SAVING_THROWS = {
  Barbarian: ['STR', 'CON'],
  Bard:      ['DEX', 'CHA'],
  Cleric:    ['WIS', 'CHA'],
  Druid:     ['INT', 'WIS'],
  Fighter:   ['STR', 'CON'],
  Monk:      ['STR', 'DEX'],
  Paladin:   ['WIS', 'CHA'],
  Ranger:    ['STR', 'DEX'],
  Rogue:     ['DEX', 'INT'],
  Sorcerer:  ['CON', 'CHA'],
  Warlock:   ['WIS', 'CHA'],
  Wizard:    ['INT', 'WIS']
};

// Background → Origin Feat mapping (SRD 5.2)
const BACKGROUND_FEATS = {
  Acolyte:  'Magic Initiate',
  Criminal: 'Alert',
  Sage:     'Magic Initiate',
  Soldier:  'Savage Attacker'
};

// Background → Skill proficiencies (SRD 5.2)
const BACKGROUND_SKILLS = {
  Acolyte:  ['Insight', 'Religion'],
  Criminal: ['Sleight of Hand', 'Stealth'],
  Sage:     ['Arcana', 'History'],
  Soldier:  ['Athletics', 'Intimidation']
};

// Class → Skill proficiency choices (SRD 5.2)
// count = number of skills to choose, choices = eligible skills (null = any)
const CLASS_SKILLS = {
  Barbarian: { count: 2, choices: ['Animal Handling', 'Athletics', 'Intimidation', 'Nature', 'Perception', 'Survival'] },
  Bard:      { count: 3, choices: null },
  Cleric:    { count: 2, choices: ['History', 'Insight', 'Medicine', 'Persuasion', 'Religion'] },
  Druid:     { count: 2, choices: ['Arcana', 'Animal Handling', 'Insight', 'Medicine', 'Nature', 'Perception', 'Religion', 'Survival'] },
  Fighter:   { count: 2, choices: ['Acrobatics', 'Animal Handling', 'Athletics', 'History', 'Insight', 'Intimidation', 'Perception', 'Survival'] },
  Monk:      { count: 2, choices: ['Acrobatics', 'Athletics', 'History', 'Insight', 'Religion', 'Stealth'] },
  Paladin:   { count: 2, choices: ['Athletics', 'Insight', 'Intimidation', 'Medicine', 'Persuasion', 'Religion'] },
  Ranger:    { count: 3, choices: ['Animal Handling', 'Athletics', 'Insight', 'Investigation', 'Nature', 'Perception', 'Stealth', 'Survival'] },
  Rogue:     { count: 4, choices: ['Acrobatics', 'Athletics', 'Deception', 'Insight', 'Intimidation', 'Investigation', 'Perception', 'Performance', 'Persuasion', 'Sleight of Hand', 'Stealth'] },
  Sorcerer:  { count: 2, choices: ['Arcana', 'Deception', 'Insight', 'Intimidation', 'Persuasion', 'Religion'] },
  Warlock:   { count: 2, choices: ['Arcana', 'Deception', 'History', 'Intimidation', 'Investigation', 'Nature', 'Religion'] },
  Wizard:    { count: 2, choices: ['Arcana', 'History', 'Insight', 'Investigation', 'Medicine', 'Religion'] }
};

// Spellcasting ability per class
const SPELLCASTING_ABILITY = {
  Bard: 'CHA',
  Cleric: 'WIS',
  Druid: 'WIS',
  Paladin: 'CHA',
  Ranger: 'WIS',
  Sorcerer: 'CHA',
  Warlock: 'CHA',
  Wizard: 'INT'
};

// Full caster slot table (Bard, Cleric, Druid, Sorcerer, Wizard)
const FULL_CASTER_SLOTS = {
  1:  [2],
  2:  [3],
  3:  [4, 2],
  4:  [4, 3],
  5:  [4, 3, 2],
  6:  [4, 3, 3],
  7:  [4, 3, 3, 1],
  8:  [4, 3, 3, 2],
  9:  [4, 3, 3, 3, 1],
  10: [4, 3, 3, 3, 2],
  11: [4, 3, 3, 3, 2, 1],
  12: [4, 3, 3, 3, 2, 1],
  13: [4, 3, 3, 3, 2, 1, 1],
  14: [4, 3, 3, 3, 2, 1, 1],
  15: [4, 3, 3, 3, 2, 1, 1, 1],
  16: [4, 3, 3, 3, 2, 1, 1, 1],
  17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1],
  20: [4, 3, 3, 3, 3, 2, 2, 1, 1]
};

// Half caster slot table (Paladin, Ranger)
const HALF_CASTER_SLOTS = {
  1:  [],
  2:  [2],
  3:  [3],
  4:  [3],
  5:  [4, 2],
  6:  [4, 2],
  7:  [4, 3],
  8:  [4, 3],
  9:  [4, 3, 2],
  10: [4, 3, 2],
  11: [4, 3, 3],
  12: [4, 3, 3],
  13: [4, 3, 3, 1],
  14: [4, 3, 3, 1],
  15: [4, 3, 3, 2],
  16: [4, 3, 3, 2],
  17: [4, 3, 3, 3, 1],
  18: [4, 3, 3, 3, 1],
  19: [4, 3, 3, 3, 2],
  20: [4, 3, 3, 3, 2]
};

// Warlock pact magic (slots per short rest, all same level)
const WARLOCK_SLOTS = {
  1:  { slots: 1, level: 1 },
  2:  { slots: 2, level: 1 },
  3:  { slots: 2, level: 2 },
  4:  { slots: 2, level: 2 },
  5:  { slots: 2, level: 3 },
  6:  { slots: 2, level: 3 },
  7:  { slots: 2, level: 4 },
  8:  { slots: 2, level: 4 },
  9:  { slots: 2, level: 5 },
  10: { slots: 2, level: 5 },
  11: { slots: 3, level: 5 },
  12: { slots: 3, level: 5 },
  13: { slots: 3, level: 5 },
  14: { slots: 3, level: 5 },
  15: { slots: 3, level: 5 },
  16: { slots: 3, level: 5 },
  17: { slots: 4, level: 5 },
  18: { slots: 4, level: 5 },
  19: { slots: 4, level: 5 },
  20: { slots: 4, level: 5 }
};

// Cantrips known per class per level (SRD 5.2)
// Bard: 2 at L1, +1 at L4, +1 at L10
// Cleric: 3 at L1, +1 at L4, +1 at L10
// Druid: 2 at L1, +1 at L4, +1 at L10
// Sorcerer: 4 at L1, +1 at L4, +1 at L10
// Warlock: 2 at L1, +1 at L4, +1 at L10
// Wizard: 3 at L1, +1 at L4, +1 at L10
// Paladin/Ranger: 0 (optional cantrips via Fighting Style)
const CANTRIPS_KNOWN = {
  Bard:     [2,2,2,3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,4,4],
  Cleric:   [3,3,3,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5],
  Druid:    [2,2,2,3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,4,4],
  Sorcerer: [4,4,4,5,5,5,5,5,5,6,6,6,6,6,6,6,6,6,6,6],
  Warlock:  [2,2,2,3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,4,4],
  Wizard:   [3,3,3,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5]
};

// Prepared spells (level 1+) per class per level (SRD 5.2)
// Bard/Cleric/Druid share the same progression
// Sorcerer starts lower (2 at L1, 4 at L2) then matches from L3
// Wizard matches others until L14, then pulls ahead
// Warlock has a slower progression (half-caster-like for prepared count)
// Paladin/Ranger share the same half-caster progression
const PREPARED_SPELLS = {
  Bard:     [4,5,6,7,9,10,11,12,14,15,16,16,17,17,18,18,19,20,21,22],
  Cleric:   [4,5,6,7,9,10,11,12,14,15,16,16,17,17,18,18,19,20,21,22],
  Druid:    [4,5,6,7,9,10,11,12,14,15,16,16,17,17,18,18,19,20,21,22],
  Sorcerer: [2,4,6,7,9,10,11,12,14,15,16,16,17,17,18,18,19,20,21,22],
  Warlock:  [2,3,4,5,6,7,8,9,10,10,11,11,12,12,13,13,14,14,15,15],
  Wizard:   [4,5,6,7,9,10,11,12,14,15,16,16,17,18,19,21,22,23,24,25],
  Paladin:  [2,3,4,5,6,6,7,7,9,9,10,10,11,11,12,12,14,14,15,15],
  Ranger:   [2,3,4,5,6,6,7,7,9,9,10,10,11,11,12,12,14,14,15,15]
};

// Get cantrips known and prepared spells for a class at a given level
function getSpellsKnown(className, level) {
  const lvl = Math.max(1, Math.min(20, level));
  const cantrips = CANTRIPS_KNOWN[className] ? CANTRIPS_KNOWN[className][lvl - 1] : 0;
  const prepared = PREPARED_SPELLS[className] ? PREPARED_SPELLS[className][lvl - 1] : 0;
  return { cantrips, prepared };
}

function getSpellSlots(className, level) {
  const fullCasters = ['Bard', 'Cleric', 'Druid', 'Sorcerer', 'Wizard'];
  const halfCasters = ['Paladin', 'Ranger'];

  if (className === 'Warlock') {
    const w = WARLOCK_SLOTS[level] || { slots: 0, level: 0 };
    return { type: 'pact', slots: w.slots, slotLevel: w.level };
  }
  if (fullCasters.includes(className)) {
    return { type: 'full', slots: FULL_CASTER_SLOTS[level] || [] };
  }
  if (halfCasters.includes(className)) {
    return { type: 'half', slots: HALF_CASTER_SLOTS[level] || [] };
  }
  return { type: 'none', slots: [] };
}
