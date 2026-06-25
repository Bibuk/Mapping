/*
 * main.js — «склейка» интерфейса с логикой.
 *
 * Здесь мы:
 *   - читаем значения из элементов управления (ползунки, галочки),
 *   - запускаем генерацию карты (ландшафт + ресурсы + СИМУЛЯЦИЯ развития),
 *   - проигрываем развитие как анимацию (или сразу прыгаем к финалу),
 *   - просим renderer нарисовать нужный «год» истории.
 *
 * Подключается последним, когда noise/generator/town/simulation/renderer готовы.
 */

// Находим элементы на странице один раз и складываем в объект для удобства.
const ui = {
  seed: document.getElementById("seed"),
  randomSeed: document.getElementById("randomSeed"),
  scale: document.getElementById("scale"),
  size: document.getElementById("size"),
  sea: document.getElementById("sea"),
  forest: document.getElementById("forest"),
  towns: document.getElementById("towns"),
  resources: document.getElementById("resources"),
  showGrid: document.getElementById("showGrid"),
  showContours: document.getElementById("showContours"),
  showRelief: document.getElementById("showRelief"),
  showLabels: document.getElementById("showLabels"),
  play: document.getElementById("play"),
  toFinal: document.getElementById("toFinal"),
  year: document.getElementById("year"),
  speed: document.getElementById("speed"),
  generate: document.getElementById("generate"),
  export: document.getElementById("export"),
  // подписи рядом с ползунками
  scaleLabel: document.getElementById("scaleLabel"),
  sizeLabel: document.getElementById("sizeLabel"),
  seaLabel: document.getElementById("seaLabel"),
  forestLabel: document.getElementById("forestLabel"),
  townsLabel: document.getElementById("townsLabel"),
  resLabel: document.getElementById("resLabel"),
  yearLabel: document.getElementById("yearLabel"),
  speedLabel: document.getElementById("speedLabel"),
};

const canvas = document.getElementById("map");
const renderer = new MapRenderer(canvas);

// Текущая модель карты и состояние проигрывателя развития.
let currentMap = null;
let currentTick = 0;
let playing = false;
let playTimer = null;

/* Собирает настройки генерации из интерфейса. */
function readSettings() {
  return {
    seed: parseInt(ui.seed.value, 10) || 0,
    scaleKm: parseInt(ui.scale.value, 10),
    size: parseInt(ui.size.value, 10),
    seaLevel: parseFloat(ui.sea.value),
    forest: parseFloat(ui.forest.value),
    townCount: parseInt(ui.towns.value, 10),
    resourceCount: parseInt(ui.resources.value, 10),
  };
}

/* Что показывать на карте (галочки + текущий «год» истории). */
function readDisplayOptions() {
  return {
    showGrid: ui.showGrid.checked,
    showContours: ui.showContours.checked,
    showRelief: ui.showRelief.checked,
    showLabels: ui.showLabels.checked,
    tick: currentTick,
  };
}

/* Полная генерация: строим модель и проигрываем развитие с начала. */
function generateAndDraw() {
  stopPlay();
  currentMap = new MapGenerator(readSettings()).generate();
  const ticks = currentMap.ticks || 1;
  ui.year.max = String(ticks - 1);
  currentTick = 0;
  drawTick();
  play(); // авто-проигрывание развития (поэтапная генерация)
}

/* Рисует карту на текущем «году» и обновляет подписи проигрывателя. */
function drawTick() {
  if (!currentMap) return;
  renderer.render(currentMap, readDisplayOptions());
  const ticks = currentMap.ticks || 1;
  ui.year.value = String(currentTick);
  ui.yearLabel.textContent = "год " + (currentTick + 1) + " / " + ticks;
}

/* Перерисовка того же года (для галочек отображения — без новой генерации). */
function redraw() {
  drawTick();
}

/* ====== Проигрыватель ====== */

function startTimer() {
  clearInterval(playTimer);
  const fps = Math.max(1, parseInt(ui.speed.value, 10));
  playTimer = setInterval(() => {
    const ticks = currentMap ? currentMap.ticks || 1 : 1;
    if (currentTick < ticks - 1) {
      currentTick++;
      drawTick();
    } else {
      stopPlay();
    }
  }, 1000 / fps);
}

function play() {
  if (!currentMap) return;
  const ticks = currentMap.ticks || 1;
  if (currentTick >= ticks - 1) currentTick = 0; // с конца — начинаем заново
  playing = true;
  ui.play.textContent = "⏸";
  startTimer();
}

function stopPlay() {
  playing = false;
  ui.play.textContent = "▶";
  clearInterval(playTimer);
  playTimer = null;
}

function togglePlay() {
  if (playing) stopPlay();
  else play();
}

/* Обновляет числовые подписи рядом с ползунками. */
function updateLabels() {
  const km = parseInt(ui.scale.value, 10);
  const area = (km * km).toLocaleString("ru-RU");
  ui.scaleLabel.textContent = `${km} км · ~${area} км²`;
  ui.sizeLabel.textContent = ui.size.value;
  ui.seaLabel.textContent = parseFloat(ui.sea.value).toFixed(2);
  ui.forestLabel.textContent = parseFloat(ui.forest.value).toFixed(2);
  ui.townsLabel.textContent = ui.towns.value;
  ui.resLabel.textContent = ui.resources.value;
  ui.speedLabel.textContent = ui.speed.value;
}

/* ====== Обработчики событий ====== */

ui.generate.addEventListener("click", generateAndDraw);

ui.randomSeed.addEventListener("click", () => {
  ui.seed.value = Math.floor(Math.random() * 1000000);
  generateAndDraw();
});

// Ползунки генерации: подписи сразу, перегенерация по отпусканию.
[ui.scale, ui.size, ui.sea, ui.forest, ui.towns, ui.resources].forEach((slider) => {
  slider.addEventListener("input", updateLabels);
  slider.addEventListener("change", generateAndDraw);
});

// Галочки отображения: только перерисовка текущего года.
[ui.showGrid, ui.showContours, ui.showRelief, ui.showLabels].forEach((cb) => {
  cb.addEventListener("change", redraw);
});

// Проигрыватель развития.
ui.play.addEventListener("click", togglePlay);
ui.toFinal.addEventListener("click", () => {
  if (!currentMap) return;
  stopPlay();
  currentTick = (currentMap.ticks || 1) - 1;
  drawTick();
});
ui.year.addEventListener("input", () => {
  stopPlay();
  currentTick = parseInt(ui.year.value, 10) || 0;
  drawTick();
});
ui.speed.addEventListener("input", () => {
  updateLabels();
  if (playing) startTimer(); // подхватываем новую скорость на лету
});

// Экспорт карты в PNG-файл (текущий год).
ui.export.addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `topomap_${ui.seed.value}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
});

/* ====== Старт ====== */
updateLabels();
generateAndDraw(); // первая карта + проигрывание развития сразу при загрузке
