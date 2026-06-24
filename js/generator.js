/*
 * generator.js — процедурная генерация местности.
 *
 * Здесь мы не рисуем карту, а строим её «модель» — данные о том, что где находится:
 *   - массив высот (рельеф),
 *   - тип поверхности в каждой клетке (вода / песок / поле / лес / возвышенность),
 *   - список городов,
 *   - сеть дорог между городами.
 *
 * Отрисовкой займётся отдельный модуль renderer.js. Такое разделение
 * («данные» отдельно, «картинка» отдельно) — важный приём в программировании:
 * одну и ту же модель можно нарисовать по-разному.
 */

// Типы поверхности. Используем константы, чтобы не путаться в «магических числах».
const TERRAIN = {
  WATER: 0,  // вода (реки, озёра, море)
  SAND: 1,   // песок / отмель у воды
  FIELD: 2,  // открытое поле / луг
  FOREST: 3, // лес
  HILL: 4,   // возвышенность / горы
};

class MapGenerator {
  /*
   * options:
   *   seed     — зерно генерации
   *   size     — размер сетки (size x size клеток)
   *   seaLevel — уровень воды (0..1): всё ниже считается водой
   *   forest   — лесистость (0..1)
   *   townCount — желаемое число городов
   */
  constructor(options) {
    this.size = options.size;
    this.seed = options.seed >>> 0;
    this.seaLevel = options.seaLevel;
    this.forestAmount = options.forest;
    this.townCount = options.townCount;

    // Два независимых шума: один для высот, другой для влажности (распределение леса).
    this.heightNoise = new Noise(options.seed);
    this.moistNoise = new Noise(options.seed + 9999);

    // Свой генератор случайных чисел для размещения городов (тоже от сида),
    // чтобы результат был воспроизводим.
    this._rngState = (options.seed + 1) >>> 0;
  }

  /* Простой детерминированный ГПСЧ (генератор псевдослучайных чисел) в [0,1). */
  _rand() {
    // алгоритм mulberry32 — короткий и качественный
    this._rngState |= 0;
    this._rngState = (this._rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(this._rngState ^ (this._rngState >>> 15), 1 | this._rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* Индекс в одномерном массиве по координатам (x, y) сетки. */
  _idx(x, y) {
    return y * this.size + x;
  }

  /*
   * Растягивает значения массива на весь диапазон [0,1] по факту:
   * находим минимум и максимум и линейно переносим в [0,1].
   * Меняет массив на месте.
   */
  _normalize(arr) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
    const range = max - min;
    if (range === 0) return; // все значения одинаковы — делить не на что
    for (let i = 0; i < arr.length; i++) {
      arr[i] = (arr[i] - min) / range;
    }
  }

  /*
   * Главный метод: генерирует и возвращает готовую модель карты.
   */
  generate() {
    const size = this.size;
    const height = new Float32Array(size * size);
    const moisture = new Float32Array(size * size);
    const type = new Uint8Array(size * size);

    // 1) Высоты и влажность через фрактальный шум
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // нормируем координаты в [0,1] и масштабируем под крупные формы рельефа
        const nx = x / size;
        const ny = y / size;

        let h = this.heightNoise.fractal(nx * 4, ny * 4, 6, 1);

        // «Островной» эффект: к краям карты понижаем высоту, чтобы по периметру
        // была вода/побережье, а суша собиралась к центру. Это придаёт картам
        // законченный вид. Чем дальше от центра — тем сильнее понижение.
        const dx = nx - 0.5;
        const dy = ny - 0.5;
        // Искажаем расстояние низкочастотным шумом (domain warping), чтобы
        // береговая линия была неровной, а не идеально круглой.
        const warp = (this.heightNoise.value(nx * 3 + 50, ny * 3 + 50) - 0.5) * 0.35;
        const dist = (Math.sqrt(dx * dx + dy * dy) + warp) * 2; // 0 в центре, ~1.4 в углах
        const falloff = Math.max(0, 1 - dist * dist * 0.9);
        h = h * 0.6 + falloff * 0.4;

        height[this._idx(x, y)] = h;
        moisture[this._idx(x, y)] = this.moistNoise.fractal(nx * 5, ny * 5, 4, 1);
      }
    }

    // Нормализация в диапазон [0,1].
    // ВАЖНО: фрактальный шум кучкуется около 0.5 с малым разбросом, поэтому
    // абсолютные пороги (например «влажность > 0.45») почти не срабатывают.
    // Растягиваем фактические значения на весь диапазон [0,1] — тогда уровни
    // воды и лесистости работают предсказуемо при любом сиде.
    this._normalize(height);
    this._normalize(moisture);

    // 2) Классификация: по высоте и влажности определяем тип поверхности
    const sea = this.seaLevel;
    for (let i = 0; i < height.length; i++) {
      const h = height[i];
      const m = moisture[i];

      if (h < sea) {
        type[i] = TERRAIN.WATER;
      } else if (h < sea + 0.025) {
        type[i] = TERRAIN.SAND; // узкая полоса побережья
      } else if (h > 0.82) {
        type[i] = TERRAIN.HILL; // высоко — возвышенности
      } else {
        // Лес или поле — зависит от влажности и общей лесистости.
        // Чем выше ползунок «лесистость», тем ниже порог для появления леса.
        const forestThreshold = 1 - this.forestAmount;
        type[i] = m > forestThreshold ? TERRAIN.FOREST : TERRAIN.FIELD;
      }
    }

    // 3) Города и дороги
    const towns = this._placeTowns(height, type);
    const roads = this._buildRoads(towns, height);

    // 4) Детальная застройка каждого города (дома, улицы, кварталы)
    const builder = new TownBuilder(this.seed);
    for (const town of towns) {
      builder.build(town, { type, size });
    }

    return {
      size,
      seaLevel: sea,
      height,
      moisture,
      type,
      towns,
      roads,
    };
  }

  /*
   * Размещение городов.
   * Правила: город ставим на суше (не в воде и не высоко в горах),
   * на достаточно ровном месте и не слишком близко к другим городам.
   */
  _placeTowns(height, type) {
    const size = this.size;
    const towns = [];
    const minDist = size / (this.townCount + 1); // минимальное расстояние между городами
    let attempts = 0;
    const maxAttempts = this.townCount * 200;

    while (towns.length < this.townCount && attempts < maxAttempts) {
      attempts++;
      const x = Math.floor(this._rand() * size);
      const y = Math.floor(this._rand() * size);
      const i = this._idx(x, y);
      const t = type[i];

      // Город ставим только на поле, в лесу или на песке (не в воде/горах)
      if (t === TERRAIN.WATER || t === TERRAIN.HILL) continue;

      // Проверяем минимальную дистанцию до уже размещённых городов
      let tooClose = false;
      for (const town of towns) {
        const dx = town.x - x;
        const dy = town.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < minDist) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      towns.push({
        x,
        y,
        name: this._townName(towns.length),
        // Размер города влияет на отрисовку (кружок крупнее/мельче)
        size: 0.5 + this._rand() * 0.5,
      });
    }

    return towns;
  }

  /*
   * Дороги: соединяем города в единую сеть.
   * Используем простой подход — «жадное» дерево: каждый новый город
   * присоединяем к ближайшему из уже соединённых. Так все города
   * оказываются связаны, а дорог не слишком много.
   */
  _buildRoads(towns, height) {
    if (towns.length < 2) return [];

    const roads = [];
    const connected = [0];          // индексы уже соединённых городов
    const remaining = [];           // ещё не соединённые
    for (let i = 1; i < towns.length; i++) remaining.push(i);

    while (remaining.length > 0) {
      let bestDist = Infinity;
      let bestFrom = -1;
      let bestRemIdx = -1;

      // ищем ближайшую пару (соединённый ↔ несоединённый)
      for (const c of connected) {
        for (let r = 0; r < remaining.length; r++) {
          const a = towns[c];
          const b = towns[remaining[r]];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            bestFrom = c;
            bestRemIdx = r;
          }
        }
      }

      const newTown = remaining[bestRemIdx];
      roads.push({ from: bestFrom, to: newTown });
      connected.push(newTown);
      remaining.splice(bestRemIdx, 1);
    }

    return roads;
  }

  /* Простая выдача названий городам: Альфа-1, Браво-2 и т.д. (как позывные). */
  _townName(index) {
    const callsigns = [
      "Альфа", "Браво", "Чарли", "Дельта", "Эхо", "Фокстрот",
      "Гольф", "Хотел", "Индия", "Джульетта", "Кило", "Лима",
      "Майк", "Новембер", "Оскар",
    ];
    const name = callsigns[index % callsigns.length];
    return `${name}-${index + 1}`;
  }
}
