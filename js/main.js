/*
 * main.js — «склейка» интерфейса с логикой.
 *
 * Здесь мы:
 *   - читаем значения из элементов управления (ползунки, галочки),
 *   - запускаем генерацию карты,
 *   - просим renderer нарисовать результат,
 *   - вешаем обработчики на кнопки.
 *
 * Этот файл подключается последним, когда noise.js, generator.js и
 * renderer.js уже загружены.
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
  showGrid: document.getElementById("showGrid"),
  showContours: document.getElementById("showContours"),
  showRelief: document.getElementById("showRelief"),
  showLabels: document.getElementById("showLabels"),
  generate: document.getElementById("generate"),
  export: document.getElementById("export"),
  // подписи рядом с ползунками
  scaleLabel: document.getElementById("scaleLabel"),
  sizeLabel: document.getElementById("sizeLabel"),
  seaLabel: document.getElementById("seaLabel"),
  forestLabel: document.getElementById("forestLabel"),
  townsLabel: document.getElementById("townsLabel"),
};

const canvas = document.getElementById("map");
const renderer = new MapRenderer(canvas);

// Сюда сохраняем последнюю сгенерированную модель карты,
// чтобы перерисовывать её при смене галочек без повторной генерации.
let currentMap = null;

/* Собирает настройки из интерфейса в обычный объект. */
function readSettings() {
  return {
    seed: parseInt(ui.seed.value, 10) || 0,
    scaleKm: parseInt(ui.scale.value, 10),
    size: parseInt(ui.size.value, 10),
    seaLevel: parseFloat(ui.sea.value),
    forest: parseFloat(ui.forest.value),
    townCount: parseInt(ui.towns.value, 10),
  };
}

/* Что показывать на карте (галочки отображения). */
function readDisplayOptions() {
  return {
    showGrid: ui.showGrid.checked,
    showContours: ui.showContours.checked,
    showRelief: ui.showRelief.checked,
    showLabels: ui.showLabels.checked,
  };
}

/* Полная генерация: строим новую модель и рисуем её. */
function generateAndDraw() {
  const settings = readSettings();
  const generator = new MapGenerator(settings);
  currentMap = generator.generate();
  redraw();
}

/* Только перерисовка уже готовой модели (быстро, без новой генерации). */
function redraw() {
  if (!currentMap) return;
  renderer.render(currentMap, readDisplayOptions());
}

/* Обновляет числовые подписи рядом с ползунками. */
function updateLabels() {
  const km = parseInt(ui.scale.value, 10);
  const area = (km * km).toLocaleString("ru-RU"); // площадь региона, км²
  ui.scaleLabel.textContent = `${km} км · ~${area} км²`;
  ui.sizeLabel.textContent = ui.size.value;
  ui.seaLabel.textContent = parseFloat(ui.sea.value).toFixed(2);
  ui.forestLabel.textContent = parseFloat(ui.forest.value).toFixed(2);
  ui.townsLabel.textContent = ui.towns.value;
}

/* ====== Обработчики событий ====== */

// Кнопка «Сгенерировать»
ui.generate.addEventListener("click", generateAndDraw);

// Случайный сид
ui.randomSeed.addEventListener("click", () => {
  ui.seed.value = Math.floor(Math.random() * 1000000);
  generateAndDraw();
});

// Ползунки: обновляем подписи сразу, карту перегенерируем по отпусканию.
[ui.scale, ui.size, ui.sea, ui.forest, ui.towns].forEach((slider) => {
  slider.addEventListener("input", updateLabels);
  slider.addEventListener("change", generateAndDraw);
});

// Галочки отображения: только перерисовка, без новой генерации.
[ui.showGrid, ui.showContours, ui.showRelief, ui.showLabels].forEach((cb) => {
  cb.addEventListener("change", redraw);
});

// Экспорт карты в PNG-файл
ui.export.addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `topomap_${ui.seed.value}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
});

/* ====== Старт ====== */
updateLabels();
generateAndDraw(); // рисуем первую карту сразу при загрузке страницы
