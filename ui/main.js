// ui/main.js
import { GameState } from "../sim/GameState.js";
import { createInputRouter } from "./InputRouter.js";

let uiConfig = { turnTime: 45 };

let game;
let timerId = null;
let remainingTime;
let inputRouter = null;

let inputEnabled = false; // gated by overlay + menus

// DOM references
const gridEl = document.getElementById("grid");
const hudContentEl = document.getElementById("hud-content");
const actionTrayEl = document.getElementById("action-tray");
const overlayEl = document.getElementById("overlay");
const overlayMsgEl = document.getElementById("overlay-message");
const overlayBtn = document.getElementById("overlay-continue");
const storeUiEl = document.getElementById("store-ui");
const storeContentEl = document.getElementById("store-content");
const closeStoreBtn = document.getElementById("close-store");
const bankUiEl = document.getElementById("bank-ui");
const bankContentEl = document.getElementById("bank-content");
const closeBankBtn = document.getElementById("close-bank");

async function init() {
  let configData = {};
  try {
    const resp = await fetch(new URL("../data/balance_defaults.json", import.meta.url));
    configData = await resp.json();
  } catch (err) {
    console.error("Failed to load balance_defaults.json:", err);
  }

  uiConfig.turnTime = configData.turnTime || 45;

  const seed = Date.now() & 0xffffffff;
  game = new GameState(seed, configData);

  remainingTime = uiConfig.turnTime;

  buildGrid();
  setupInputRouter();

  showOverlayForPlayer(game.currentPlayerIndex);
}

function setupInputRouter() {
  if (inputRouter) inputRouter.destroy();

  inputRouter = createInputRouter({
    gridEl,
    onMove: (dx, dy) => performMove(dx, dy),
    onInteract: () => performInteract(),
    onSwap: () => performSwap(),
    onEndTurn: () => endCurrentPlayerTurn(),
    isInputEnabled: () => inputEnabled,
  });
}

function setInputEnabled(v) {
  inputEnabled = v;
}

function buildGrid() {
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateColumns = `repeat(${game.width}, 32px)`;
  gridEl.style.gridTemplateRows = `repeat(${game.height}, 32px)`;

  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) {
      const cellDiv = document.createElement("div");
      cellDiv.className = "cell";
      cellDiv.dataset.x = x;
      cellDiv.dataset.y = y;
      gridEl.appendChild(cellDiv);
    }
  }
}

function render() {
  const cells = gridEl.children;

  for (const cellDiv of cells) {
    cellDiv.className = "cell";
    cellDiv.innerHTML = "";
  }

  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) {
      const cell = game.getCell(x, y);
      const index = y * game.width + x;
      const cellDiv = cells[index];

      switch (cell.type) {
        case "ground":
          if (cell.ownerTeam === 0) cellDiv.classList.add("farmland0");
          else if (cell.ownerTeam === 1) cellDiv.classList.add("farmland1");
          else cellDiv.classList.add("neutral");
          break;
        case "lake": cellDiv.classList.add("lake"); break;
        case "bank": cellDiv.classList.add("bank"); break;
        case "store": cellDiv.classList.add("store"); break;
        case "farmhouse0": cellDiv.classList.add("farmhouse0"); break;
        case "farmhouse1": cellDiv.classList.add("farmhouse1"); break;
        case "thorns": cellDiv.classList.add("thorns"); break;
      }

      if (cell.crop) {
        const crop = cell.crop;
        const cropDiv = document.createElement("div");
        cropDiv.classList.add("crop");

        let letter = "?";
        if (crop.type === "wheat") { cropDiv.classList.add("wheat"); letter = "W"; }
        else if (crop.type === "mj_cheap") { cropDiv.classList.add("mjcheap"); letter = "C"; }
        else if (crop.type === "mj_premium") { cropDiv.classList.add("mjpremium"); letter = "P"; }

        if (crop.rotDestroyed) {
          cropDiv.classList.add("destroyed");
          cropDiv.textContent = "✖";
        } else {
          cropDiv.textContent = `${letter}${crop.stage + 1}`;
          if (crop.rotPenalty > 0) cropDiv.classList.add("rot");
        }
        cellDiv.appendChild(cropDiv);
      }
    }
  }

  for (const p of game.players) {
    const idx = p.y * game.width + p.x;
    const cellDiv = cells[idx];
    const playerDiv = document.createElement("div");
    playerDiv.className = `player team${p.team}`;
    playerDiv.textContent = `P${p.id}`;
    cellDiv.appendChild(playerDiv);
  }

  updateHUD();
}

function updateHUD() {
  const current = game.players[game.currentPlayerIndex];

  const bag = {};
  for (const g of (current.goods || [])) bag[g.type] = (bag[g.type] || 0) + 1;

  const seeds = current.seeds || {};
  const seedCounts = `Seeds: W${seeds.wheat||0} C${seeds.mj_cheap||0} P${seeds.mj_premium||0}`;

  const hudList = [];
  hudList.push(`Day: ${game.day}`);
  hudList.push(`Player ${current.id} (Team ${current.team})`);
  hudList.push(`Energy: ${current.energy}`);
  hudList.push(`Cash: $${current.cash.toFixed(0)}`);
  hudList.push(`Bank: $${current.bank.toFixed(0)}`);
  hudList.push(`SeedSel: ${current.activeSeed}`);
  hudList.push(seedCounts);
  hudList.push(`Bag: W${bag.wheat || 0} C${bag.mj_cheap || 0} P${bag.mj_premium || 0}`);
  hudList.push(`Time: ${remainingTime.toFixed(0)}s`);

  hudContentEl.textContent = hudList.join(" | ");
}

function showOverlayForPlayer(playerIndex) {
  const p = game.players[playerIndex];
  overlayMsgEl.textContent = `Player ${p.id} (Team ${p.team}) - Pass device and start your turn.`;
  overlayEl.classList.remove("hidden");
  actionTrayEl.classList.add("hidden");

  setInputEnabled(false);

  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function startTurn() {
  overlayEl.classList.add("hidden");
  remainingTime = uiConfig.turnTime;
  startTimer();
  renderActionTray();
  render();
  setInputEnabled(true);
}

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(() => {
    remainingTime -= 1;
    if (remainingTime <= 0) {
      remainingTime = 0;
      updateHUD();
      endCurrentPlayerTurn();
    } else {
      updateHUD();
    }
  }, 1000);
}

function renderActionTray() {
  actionTrayEl.innerHTML = "";

  function createButton(label, onClick) {
    const btn = document.createElement("button");
    btn.className = "action-button";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  // Mobile-first minimal tray
  const swapBtn = createButton("Swap", () => performSwap());
  const interactBtn = createButton("Interact", () => performInteract());
  const endBtn = createButton("End Turn", () => endCurrentPlayerTurn());

  actionTrayEl.append(swapBtn, interactBtn, endBtn);
  actionTrayEl.classList.remove("hidden");
  updateActionButtons();
}

function updateActionButtons() {
  const p = game.players[game.currentPlayerIndex];
  const buttons = actionTrayEl.querySelectorAll("button");
  buttons.forEach((btn) => (btn.disabled = false));

  // If no energy: disable swap/interact, keep end turn
  if (p.energy <= 0) {
    buttons.forEach((btn) => {
      if (btn.textContent !== "End Turn") btn.disabled = true;
    });
  }
}

function performMove(dx, dy) {
  if (!inputEnabled) return;

  const p = game.players[game.currentPlayerIndex];
  const result = game.movePlayer(p, dx, dy);
  if (result.success) render();

  updateActionButtons();
  if (p.energy <= 0) endCurrentPlayerTurn();
}

function performInteract() {
  if (!inputEnabled) return;

  const p = game.players[game.currentPlayerIndex];
  const result = game.interact(p);

  render();
  updateActionButtons();

  if (result.type === "bank") openBank();
  else if (result.type === "store") openStore();

  if (p.energy <= 0) endCurrentPlayerTurn();
}

function performSwap() {
  if (!inputEnabled) return;

  // Stub for upcoming “two hands” system:
  // For now, swap just cycles activeSeed between wheat -> mj_cheap -> mj_premium
  const p = game.players[game.currentPlayerIndex];
  const order = ["wheat", "mj_cheap", "mj_premium"];
  const idx = order.indexOf(p.activeSeed);
  p.activeSeed = order[(idx + 1 + order.length) % order.length];
  render();
}

function endCurrentPlayerTurn() {
  closeStore();
  closeBank();

  setInputEnabled(false);

  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }

  actionTrayEl.classList.add("hidden");
  game.endTurn();
  render();
  showOverlayForPlayer(game.currentPlayerIndex);
}

/* ---------------- Store UI (Buy Seeds + Sell Goods) ---------------- */

function openStore() {
  setInputEnabled(false); // prevent swipes moving while in menus

  const p = game.players[game.currentPlayerIndex];
  storeContentEl.innerHTML = "";

  const buyHeader = document.createElement("h4");
  buyHeader.textContent = "Buy Seeds";
  storeContentEl.appendChild(buyHeader);

  const crops = game.config.crops || {};
  const cropTypes = Object.keys(crops);

  cropTypes.forEach((type) => {
    const cfg = crops[type];

    const row = document.createElement("div");
    const name = document.createElement("span");

    const displayName =
      type === "wheat" ? "Wheat" :
      type === "mj_cheap" ? "Cheap MJ" :
      type === "mj_premium" ? "Premium MJ" :
      type;

    name.textContent = `${displayName} (Seed $${cfg.seedCost}) `;
    row.appendChild(name);

    const buy1 = document.createElement("button");
    buy1.textContent = "Buy 1";
    buy1.disabled = p.cash < cfg.seedCost;
    buy1.addEventListener("click", () => {
      game.buySeed(p, type, 1);
      render();
      openStore();
    });

    const buy5 = document.createElement("button");
    buy5.textContent = "Buy 5";
    buy5.disabled = p.cash < (cfg.seedCost * 5);
    buy5.addEventListener("click", () => {
      game.buySeed(p, type, 5);
      render();
      openStore();
    });

    const select = document.createElement("button");
    select.textContent = (p.activeSeed === type) ? "Selected" : "Select";
    select.disabled = (p.activeSeed === type);
    select.addEventListener("click", () => {
      p.activeSeed = type;
      render();
      openStore();
    });

    row.appendChild(buy1);
    row.appendChild(buy5);
    row.appendChild(select);
    storeContentEl.appendChild(row);
  });

  const sellHeader = document.createElement("h4");
  sellHeader.style.marginTop = "10px";
  sellHeader.textContent = "Sell";
  storeContentEl.appendChild(sellHeader);

  const counts = {};
  for (const g of (p.goods || [])) counts[g.type] = (counts[g.type] || 0) + 1;

  const types = Object.keys(counts);
  if (types.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "Nothing to sell.";
    storeContentEl.appendChild(empty);
  } else {
    types.forEach((type) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${type} x${counts[type]} `;
      row.appendChild(label);

      const sell1 = document.createElement("button");
      sell1.textContent = "Sell 1";
      sell1.addEventListener("click", () => {
        game.sellGoods(p, type, 1);
        render();
        openStore();
      });

      const sellAll = document.createElement("button");
      sellAll.textContent = "Sell All";
      sellAll.addEventListener("click", () => {
        game.sellGoods(p, type, counts[type]);
        render();
        openStore();
      });

      row.appendChild(sell1);
      row.appendChild(sellAll);
      storeContentEl.appendChild(row);
    });
  }

  storeUiEl.classList.remove("hidden");

  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function closeStore() {
  if (!storeUiEl.classList.contains("hidden")) {
    storeUiEl.classList.add("hidden");
    startTimer();
    setInputEnabled(true);
  }
}
closeStoreBtn.addEventListener("click", closeStore);

/* ---------------- Bank UI ---------------- */

function openBank() {
  setInputEnabled(false);

  const p = game.players[game.currentPlayerIndex];
  bankContentEl.innerHTML = "";

  const depositContainer = document.createElement("div");
  depositContainer.textContent = "Deposit:";

  const depositInput = document.createElement("input");
  depositInput.type = "number";
  depositInput.min = 0;
  depositInput.max = p.cash;
  depositInput.value = 0;

  const depositBtn = document.createElement("button");
  depositBtn.textContent = "Deposit";
  depositBtn.addEventListener("click", () => {
    const amount = parseInt(depositInput.value, 10);
    if (!isNaN(amount) && amount > 0 && amount <= p.cash) {
      p.cash -= amount;
      p.bank += amount;
      render();
      openBank();
    }
  });

  depositContainer.append(depositInput, depositBtn);
  bankContentEl.appendChild(depositContainer);

  const balances = document.createElement("p");
  balances.textContent = `Cash: $${p.cash.toFixed(0)} | Bank: $${p.bank.toFixed(0)}`;
  bankContentEl.appendChild(balances);

  bankUiEl.classList.remove("hidden");

  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function closeBank() {
  if (!bankUiEl.classList.contains("hidden")) {
    bankUiEl.classList.add("hidden");
    startTimer();
    setInputEnabled(true);
  }
}
closeBankBtn.addEventListener("click", closeBank);

// Events
overlayBtn.addEventListener("click", startTurn);
window.addEventListener("DOMContentLoaded", init);
