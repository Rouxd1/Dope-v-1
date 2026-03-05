/*
 * Deterministic game state for Dope Farm PvP.
 *
 * ECONOMY MODEL (as requested):
 * - Store purchase is the CASH cost for seeds (adds seed units to inventory).
 * - Planting consumes 1 seed unit and costs ENERGY only (no cash spent).
 * - Harvest produces GOODS into inventory; Store sells GOODS into cash.
 *
 * Marijuana:
 * - Cheap strains decay in market value over time (floor at 10%).
 * - Pests stall growth; Rot destroys cheap weed or reduces premium yield.
 *
 * Determinism:
 * - Hazards use seeded RNG inside endDay().
 */

export class RNG {
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  random() {
    return (this.next() & 0xfffffff) / 0x10000000;
  }
}

export class Cell {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.type = "ground";     // ground, lake, bank, store, farmhouse0, farmhouse1
    this.ownerTeam = null;    // 0 | 1 | null
    this.crop = null;         // { type, stage, growth, skipGrowth, rotPenalty, rotDestroyed }
  }
}

export class Player {
  constructor(id, team, x, y, config) {
    this.id = id;
    this.team = team;
    this.x = x;
    this.y = y;

    this.energy = config.energyMax;
    this.cash = config.startingCash;
    this.bank = 0;

    // Which seed type you will plant when you interact on owned farmland
    this.activeSeed = "wheat";

    // SEED INVENTORY COUNTS (cash is paid when buying these)
    this.seeds = {
      wheat: 0,
      mj_cheap: 0,
      mj_premium: 0
    };

    // GOODS INVENTORY (harvested items to sell)
    // each: { type, qualityMult }
    this.goods = [];
  }
}

export class GameState {
  constructor(seed = 1, config = {}) {
    const defaults = {
      width: 14,
      height: 12,
      energyMax: 10,
      startingCash: 10,
      landCost: 20,
      crops: {},
      market: {},
      hazards: {},
    };
    this.config = Object.assign({}, defaults, config);

    this.rng = new RNG(seed);
    this.day = 1;

    this.width = this.config.width;
    this.height = this.config.height;

    this.grid = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) row.push(new Cell(x, y));
      this.grid.push(row);
    }

    this.setupBoard();

    this.players = [];
    this.setupPlayers();
    this.currentPlayerIndex = 0;

    // Ensure seeds table has keys for all crops
    this._normalizePlayerSeedKeys();
  }

  _normalizePlayerSeedKeys() {
    const cropTypes = Object.keys(this.config.crops || {});
    for (const p of this.players) {
      for (const t of cropTypes) {
        if (!(t in p.seeds)) p.seeds[t] = 0;
      }
    }
  }

  setupBoard() {
    const leftCols = 5;
    const middleCols = 4;
    const lakeColsStart = leftCols + Math.floor((middleCols - 2) / 2);
    const lakeRowsStart = Math.floor((this.height - 2) / 2);

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.grid[y][x];

        if (y === 0) { cell.type = "bank"; cell.ownerTeam = null; continue; }
        if (y === this.height - 1) { cell.type = "store"; cell.ownerTeam = null; continue; }

        if (y === 1 && (x === 1 || x === 2)) { cell.type = "farmhouse0"; cell.ownerTeam = 0; continue; }
        if (y === this.height - 2 && (x === this.width - 2 || x === this.width - 3)) { cell.type = "farmhouse1"; cell.ownerTeam = 1; continue; }

        if (x < leftCols) {
          cell.type = "ground";
          cell.ownerTeam = 0;
        } else if (x >= leftCols + middleCols) {
          cell.type = "ground";
          cell.ownerTeam = 1;
        } else {
          if (x >= lakeColsStart && x < lakeColsStart + 2 && y >= lakeRowsStart && y < lakeRowsStart + 2) {
            cell.type = "lake";
            cell.ownerTeam = null;
          } else {
            cell.type = "ground";
            cell.ownerTeam = null;
          }
        }
      }
    }
  }

  setupPlayers() {
    const cfg = this.config;
    this.players.push(new Player(0, 0, 1, 3, cfg));
    this.players.push(new Player(1, 0, 3, 4, cfg));
    this.players.push(new Player(2, 1, this.width - 2, this.height - 4, cfg));
    this.players.push(new Player(3, 1, this.width - 4, this.height - 5, cfg));
  }

  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }
  getCell(x, y) {
    if (!this.inBounds(x, y)) return null;
    return this.grid[y][x];
  }

  isPassable(x, y) {
    const cell = this.getCell(x, y);
    if (!cell) return false;
    if (cell.type === "lake") return false;
    for (const p of this.players) if (p.x === x && p.y === y) return false;
    return true;
  }

  movePlayer(player, dx, dy) {
    if (player.energy <= 0) return { success: false };
    const nx = player.x + dx;
    const ny = player.y + dy;
    if (!this.isPassable(nx, ny)) return { success: false };
    player.x = nx;
    player.y = ny;
    player.energy -= 1;
    return { success: true };
  }

  interact(player) {
    const cell = this.getCell(player.x, player.y);
    if (!cell) return { type: "none" };

    if (cell.type === "bank") return { type: "bank" };
    if (cell.type === "store") return { type: "store" };
    if (cell.type === "farmhouse0" || cell.type === "farmhouse1") return { type: "farmhouse" };
    if (cell.type === "lake") return { type: "lake" };

    if (cell.type === "ground") {
      if (cell.crop && this.isCropMature(cell.crop)) {
        const ok = this.harvestCropToGoods(player, cell);
        return { type: ok ? "harvest" : "none" };
      }
      if (!cell.crop && cell.ownerTeam === player.team) {
        const ok = this.plantCrop(player, cell);
        return { type: ok ? "plant" : "none" };
      }
    }

    return { type: "none" };
  }

  isCropMature(crop) {
    const cfg = this.config.crops[crop.type];
    if (!cfg) return false;
    return crop.stage >= (cfg.growthStages - 1);
  }

  // BUY seeds at store: adds seed units (cash cost happens here)
  buySeed(player, seedType, qty = 1) {
    const cfg = this.config.crops[seedType];
    if (!cfg) return false;
    const cost = cfg.seedCost * qty;
    if (player.cash < cost) return false;
    player.cash -= cost;
    player.seeds[seedType] = (player.seeds[seedType] || 0) + qty;
    return true;
  }

  // Planting consumes 1 seed unit + energy only (NO cash cost)
  plantCrop(player, cell) {
    const type = player.activeSeed || "wheat";
    const cfg = this.config.crops[type];
    if (!cfg) return false;

    if (player.energy < cfg.plantEnergy) return false;

    const available = player.seeds[type] || 0;
    if (available <= 0) return false;

    player.seeds[type] = available - 1;
    player.energy -= cfg.plantEnergy;

    cell.crop = {
      type,
      stage: 0,
      growth: 0,
      skipGrowth: false,
      rotPenalty: 0,
      rotDestroyed: false,
    };
    return true;
  }

  harvestCropToGoods(player, cell) {
    const crop = cell.crop;
    const cfg = this.config.crops[crop.type];
    if (!cfg) return false;

    if (player.energy < cfg.harvestEnergy) return false;
    player.energy -= cfg.harvestEnergy;

    let qualityMult = 1;
    if (crop.type.startsWith("mj")) {
      if (crop.rotDestroyed) qualityMult = 0;
      else if (crop.rotPenalty > 0) qualityMult = 0.5;
    }

    player.goods.push({ type: crop.type, qualityMult });
    cell.crop = null;
    return true;
  }

  getMarketMultiplier(cropType) {
    if (!cropType.startsWith("mj")) return 1;
    const m = this.config.market[cropType];
    if (!m) return 1;
    const mult = 1 - m.decayPerDay * (this.day - 1);
    return Math.max(m.floor, mult);
  }

  sellGoods(player, cropType, qty) {
    const cfg = this.config.crops[cropType];
    if (!cfg) return 0;

    const goods = player.goods || [];
    const idxs = [];
    for (let i = 0; i < goods.length; i++) if (goods[i].type === cropType) idxs.push(i);

    const sellCount = Math.min(qty, idxs.length);
    if (sellCount <= 0) return 0;

    const mult = this.getMarketMultiplier(cropType);
    let payout = 0;

    for (let k = 0; k < sellCount; k++) {
      const idx = idxs[idxs.length - 1 - k];
      const g = goods[idx];
      const unit = Math.max(0, Math.round(cfg.baseValue * mult * g.qualityMult));
      payout += unit;
      goods.splice(idx, 1);
    }

    player.cash += payout;
    return payout;
  }

  endTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    if (this.currentPlayerIndex === 0) this.endDay();
  }

  endDay() {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.grid[y][x];
        const crop = cell.crop;
        if (!crop) continue;

        const cfg = this.config.crops[crop.type];
        if (!cfg) continue;

        if (crop.type.startsWith("mj")) {
          const hz = this.config.hazards[crop.type];
          if (hz && !crop.rotDestroyed) {
            if (this.rng.random() < hz.pestChance) crop.skipGrowth = true;

            if (this.rng.random() < hz.rotChance) {
              if (hz.rotEffect === "destroy") crop.rotDestroyed = true;
              else if (hz.rotEffect === "reduce") if (crop.rotPenalty === 0) crop.rotPenalty = 0.5;
            }
          }
        }

        if (!crop.rotDestroyed) {
          if (crop.skipGrowth) {
            crop.skipGrowth = false;
          } else {
            crop.growth += 1;
            if (crop.growth >= cfg.growthRate) {
              crop.growth = 0;
              crop.stage += 1;
            }
          }
        }
      }
    }

    for (const p of this.players) p.energy = this.config.energyMax;
    this.day += 1;
  }
}
