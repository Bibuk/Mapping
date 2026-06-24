/*
 * renderer.js — отрисовка модели карты на холсте (canvas).
 *
 * Принимает готовую модель из generator.js и рисует топографическую карту
 * в стиле военных карт (как в ARMA): заливка местности с рельефной тенью,
 * горизонтали высот, реки, дороги (проложенные по рельефу), сетка координат
 * и населённые пункты разного вида.
 *
 * Порядок отрисовки (слоями, снизу вверх):
 *   1. Заливка местности + плавная рельефная тень (hillshade)
 *   2. Горизонтали (изолинии высот)
 *   3. Реки
 *   4. Дороги и мосты
 *   5. Сетка координат
 *   6. Населённые пункты и подписи
 */

// Цветовая палитра в духе топографических карт.
const COLORS = {
  [TERRAIN.WATER]: "#9ec9e8",
  [TERRAIN.SAND]: "#e7dab4",
  [TERRAIN.FIELD]: "#fbf8e3",
  [TERRAIN.FOREST]: "#bcd9a0",
  [TERRAIN.HILL]: "#efe9cf",
  CONTOUR: "#bb8a5e",        // тонкие горизонтали (коричневые)
  CONTOUR_INDEX: "#9c6b3f",  // утолщённые (каждая пятая)
  FOREST_TREE: "rgba(108, 153, 96, 0.55)", // точки-«деревья» для текстуры леса
  PEAK: "#6b4f33",           // отметки высот (вершины)
  ROAD: "#d8674a",           // дороги всех классов (различаются шириной)
  ROAD_CASING: "#ffffff",    // светлая обводка дорог
  BRIDGE: "#5a4632",         // перильца мостов
  GRID: "rgba(60, 70, 90, 0.35)",
  GRID_TEXT: "#3a4256",
  // Застройка населённых пунктов
  BUILTUP: "#ece0cf",        // лёгкая заливка пятна застройки
  SQUARE: "#f4eede",         // центральная площадь (открытое место)
  STREET: "#cfc8b8",         // улицы внутри пункта
  HOUSE: "#4d4d4d",          // жилые дома
  CIVIC: "#5a4c3f",          // гражданские здания (центр)
  INDUSTRIAL: "#737373",     // промзона
  BUILDING_EDGE: "rgba(0,0,0,0.35)",
  TOWN_TEXT: "#1a1a1a",
  TOWN_KIND: "#5a5145",      // подпись вида пункта (мелкая)
  TOWN_HALO: "#ffffff",
  TOWN_MARKER: "#33291f",    // точка-отметка для мелких пунктов
};

// Та же палитра местности, но числами [r,g,b] — для быстрой заливки через ImageData.
const TERRAIN_RGB = {
  [TERRAIN.WATER]: [158, 201, 232],
  [TERRAIN.SAND]: [231, 218, 180],
  [TERRAIN.FIELD]: [251, 248, 227],
  [TERRAIN.FOREST]: [188, 217, 160],
  [TERRAIN.HILL]: [239, 233, 207],
};

class MapRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.options = {};
  }

  /*
   * Главный метод отрисовки.
   * map     — модель из MapGenerator.generate()
   * options — что показывать: { showGrid, showContours, showLabels, showRelief }
   */
  render(map, options) {
    this.options = options || {};
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // во сколько пикселей превращается одна клетка сетки
    this.scale = W / map.size;

    ctx.clearRect(0, 0, W, H);

    this._drawTerrain(map);
    this._drawForest(map);
    if (this.options.showContours) this._drawContours(map);
    this._drawRivers(map);
    this._drawRoads(map);
    if (this.options.showGrid) this._drawGrid(map);
    this._drawTowns(map, this.options.showLabels);
    if (this.options.showContours) this._drawPeaks(map);
    this._drawScaleBar(map);
    this._drawBorder();
  }

  /* Готовит вспомогательные холсты под размер сетки (создаём один раз). */
  _ensureBuffers(size) {
    if (this._bufSize === size) return;
    this._bufSize = size;

    this._colorCanvas = document.createElement("canvas");
    this._colorCanvas.width = size;
    this._colorCanvas.height = size;
    this._colorCtx = this._colorCanvas.getContext("2d");
    this._colorImg = this._colorCtx.createImageData(size, size);

    this._shadeCanvas = document.createElement("canvas");
    this._shadeCanvas.width = size;
    this._shadeCanvas.height = size;
    this._shadeCtx = this._shadeCanvas.getContext("2d");
    this._shadeImg = this._shadeCtx.createImageData(size, size);
  }

  /*
   * 1. Заливка местности.
   * Цвета рисуем чёткими клетками (через ImageData — это быстро даже при высоком
   * разрешении), а поверх — плавную «рельефную тень» (hillshade) умножением.
   * Тень имитирует освещение рельефа солнцем с северо-запада и резко добавляет
   * карте объёма и реализма. Воду не затеняем — она остаётся чистой.
   */
  _drawTerrain(map) {
    const ctx = this.ctx;
    const size = map.size;
    this._ensureBuffers(size);

    // --- цвета местности ---
    const cdata = this._colorImg.data;
    for (let i = 0; i < size * size; i++) {
      const c = TERRAIN_RGB[map.type[i]];
      const o = i * 4;
      cdata[o] = c[0];
      cdata[o + 1] = c[1];
      cdata[o + 2] = c[2];
      cdata[o + 3] = 255;
    }
    this._colorCtx.putImageData(this._colorImg, 0, 0);
    ctx.imageSmoothingEnabled = false; // чёткие границы местности
    ctx.drawImage(this._colorCanvas, 0, 0, this.canvas.width, this.canvas.height);

    // --- рельефная тень (можно отключить галочкой) ---
    if (this.options.showRelief !== false) {
      const hdata = this._shadeImg.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const g = map.type[i] === TERRAIN.WATER ? 255 : this._hillshade(map, x, y, size);
          const o = i * 4;
          hdata[o] = g;
          hdata[o + 1] = g;
          hdata[o + 2] = g;
          hdata[o + 3] = 255;
        }
      }
      this._shadeCtx.putImageData(this._shadeImg, 0, 0);
      ctx.imageSmoothingEnabled = true; // тень — плавная
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(this._shadeCanvas, 0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.imageSmoothingEnabled = true;
  }

  /*
   * Яркость рельефной тени в клетке (0..255). Считаем нормаль поверхности из
   * градиента высот и сравниваем с направлением света (северо-запад, приподнят).
   * Возвращаем множитель освещённости: ровные/освещённые участки — почти без
   * затемнения, склоны «в тень» — заметно темнее.
   */
  _hillshade(map, x, y, size) {
    const h = map.height;
    const xl = x > 0 ? x - 1 : x;
    const xr = x < size - 1 ? x + 1 : x;
    const yt = y > 0 ? y - 1 : y;
    const yb = y < size - 1 ? y + 1 : y;
    const dzdx = h[y * size + xr] - h[y * size + xl];
    const dzdy = h[yb * size + x] - h[yt * size + x];

    const k = 14; // вертикальное преувеличение (контраст рельефа)
    let nx = -dzdx * k;
    let ny = -dzdy * k;
    let nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    // направление на источник света (северо-запад), уже почти нормированное
    const lx = -0.55;
    const ly = -0.55;
    const lz = 0.63;
    let dot = nx * lx + ny * ly + nz * lz;
    if (dot < 0) dot = 0;

    // ровная земля → множитель ≈1 (без изменений); склон в тень → темнее
    const f = Math.min(1, 0.62 + dot * 0.6);
    const g = Math.round(f * 255);
    return g < 150 ? 150 : g;
  }

  /*
   * Текстура леса: поверх зелёной заливки набрасываем редкие точки-«деревья».
   * Так лес читается как на топокартах, а не как сплошное пятно. Точки берём
   * по огрублённой решётке с детерминированным сдвигом (зависит от клетки),
   * поэтому при перерисовке картинка стабильна.
   */
  _drawForest(map) {
    const ctx = this.ctx;
    const size = map.size;
    const s = this.scale;
    // шаг решётки в клетках: чем мельче клетка на экране, тем реже точки
    const stepCells = Math.max(3, Math.round(3.2 / s) + 3);
    const r = Math.max(0.8, s * 0.32);
    ctx.fillStyle = COLORS.FOREST_TREE;
    for (let y = 1; y < size - 1; y += stepCells) {
      for (let x = 1; x < size - 1; x += stepCells) {
        if (map.type[y * size + x] !== TERRAIN.FOREST) continue;
        // детерминированный «дребезг» позиции, чтобы не было ровных рядов
        const hsh = (x * 374761393 + y * 668265263) >>> 0;
        const jx = ((hsh & 255) / 255 - 0.5) * stepCells;
        const jy = (((hsh >> 8) & 255) / 255 - 0.5) * stepCells;
        const px = (x + jx) * s;
        const py = (y + jy) * s;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /*
   * Отметки высот на заметных вершинах: маленький треугольник и число метров
   * над уровнем моря рядом. Классический элемент топографической карты.
   */
  _drawPeaks(map) {
    if (!map.peaks || map.peaks.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale;
    for (const p of map.peaks) {
      const px = p.x * s;
      const py = p.y * s;

      // треугольник-вершина
      ctx.fillStyle = COLORS.PEAK;
      ctx.beginPath();
      ctx.moveTo(px, py - 4);
      ctx.lineTo(px - 3.5, py + 2.5);
      ctx.lineTo(px + 3.5, py + 2.5);
      ctx.closePath();
      ctx.fill();

      // подпись высоты с белым ореолом для читаемости
      const text = `${p.elevM}`;
      ctx.font = "bold 10px 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = COLORS.TOWN_HALO;
      ctx.strokeText(text, px + 6, py + 1);
      ctx.fillStyle = COLORS.PEAK;
      ctx.fillText(text, px + 6, py + 1);
    }
  }

  /*
   * 2. Горизонтали (изолинии) — линии равной высоты.
   * Классический алгоритм «марширующих квадратов» (marching squares).
   */
  _drawContours(map) {
    const ctx = this.ctx;
    const size = map.size;
    const h = map.height;

    const interval = 0.06;
    let levelIndex = 0;

    for (let iso = map.seaLevel + interval; iso < 1; iso += interval) {
      const isIndex = levelIndex % 5 === 0;
      ctx.strokeStyle = isIndex ? COLORS.CONTOUR_INDEX : COLORS.CONTOUR;
      ctx.lineWidth = isIndex ? 1.4 : 0.7;
      ctx.beginPath();
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          this._marchingSquareCell(ctx, h, size, x, y, iso);
        }
      }
      ctx.stroke();
      levelIndex++;
    }
  }

  /* Обработка одной ячейки для «марширующих квадратов». */
  _marchingSquareCell(ctx, h, size, x, y, iso) {
    const s = this.scale;
    const a = h[y * size + x];
    const b = h[y * size + x + 1];
    const c = h[(y + 1) * size + x + 1];
    const d = h[(y + 1) * size + x];

    let code = 0;
    if (a > iso) code |= 1;
    if (b > iso) code |= 2;
    if (c > iso) code |= 4;
    if (d > iso) code |= 8;
    if (code === 0 || code === 15) return;

    const x0 = x * s;
    const y0 = y * s;
    const top = () => [x0 + s * (iso - a) / (b - a), y0];
    const right = () => [x0 + s, y0 + s * (iso - b) / (c - b)];
    const bottom = () => [x0 + s * (iso - d) / (c - d), y0 + s];
    const left = () => [x0, y0 + s * (iso - a) / (d - a)];

    const seg = (p, q) => {
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
    };

    switch (code) {
      case 1: case 14: seg(left(), top()); break;
      case 2: case 13: seg(top(), right()); break;
      case 3: case 12: seg(left(), right()); break;
      case 4: case 11: seg(right(), bottom()); break;
      case 6: case 9: seg(top(), bottom()); break;
      case 7: case 8: seg(left(), bottom()); break;
      case 5: seg(left(), top()); seg(right(), bottom()); break;
      case 10: seg(top(), right()); seg(left(), bottom()); break;
    }
  }

  /*
   * 3. Реки — рисуем русла плавными синими линиями поверх местности.
   * (Клетки русла уже залиты водой, но тонкая линия читается чётко на любом
   * масштабе и слегка расширяется к устью.)
   */
  _drawRivers(map) {
    if (!map.rivers || map.rivers.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.strokeStyle = COLORS[TERRAIN.WATER];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const river of map.rivers) {
      if (river.length < 2) continue;

      // «Полноводность» реки определяем по её длине: крупная река чуть шире.
      let spatial = 0;
      for (let i = 0; i < river.length - 1; i++) {
        spatial += Math.hypot(river[i + 1][0] - river[i][0], river[i + 1][1] - river[i][1]);
      }
      const sizeFactor = Math.min(1, spatial / (map.size * 0.45));

      // Рисуем русло ОДНОЙ плавной линией (а не по сегментам) — без «стрелок» на
      // стыках. Ширина не меньше клетки, чтобы перекрыть прорезанный канал и
      // убрать «лесенку», и плавно растёт к крупным рекам.
      ctx.lineWidth = Math.max(1.4, s * (0.85 + sizeFactor * 0.7));
      ctx.beginPath();
      ctx.moveTo(river[0][0] * s, river[0][1] * s);
      for (let i = 1; i < river.length; i++) ctx.lineTo(river[i][0] * s, river[i][1] * s);
      ctx.stroke();
    }
  }

  /*
   * 4. Дороги. Каждая дорога — это полилиния, проложенная по рельефу
   * (см. generator). Рисуем в два прохода: сначала светлая «подложка» (casing),
   * затем сама дорога. Ширина и цвет зависят от класса (магистраль/дорога/местная).
   * Магистрали рисуем последними, чтобы они были «главнее» на развязках.
   */
  _drawRoads(map) {
    const ctx = this.ctx;
    const s = this.scale;
    if (!map.roads || map.roads.length === 0) return;

    const rank = { local: 0, main: 1, highway: 2 };
    const sorted = map.roads.slice().sort((a, b) => (rank[a.klass] || 0) - (rank[b.klass] || 0));
    const dims = (k) =>
      k === "highway" ? { cas: 7.5, road: 4 } :
      k === "main" ? { cas: 5.5, road: 2.8 } :
      { cas: 4, road: 1.8 };

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // подложка
    ctx.strokeStyle = COLORS.ROAD_CASING;
    for (const road of sorted) {
      if (!road.path || road.path.length < 2) continue;
      ctx.lineWidth = dims(road.klass).cas;
      this._strokePath(road.path, s);
    }
    // полотно: все дороги одного «дорожного» цвета (красного), чтобы их нельзя
    // было спутать с коричневыми горизонталями; класс различается шириной.
    for (const road of sorted) {
      if (!road.path || road.path.length < 2) continue;
      ctx.strokeStyle = COLORS.ROAD;
      ctx.lineWidth = dims(road.klass).road;
      this._strokePath(road.path, s);
    }

    this._drawBridges(map, sorted, dims);
  }

  /* Вспомогательное: обвести полилинию (координаты в клетках → пиксели). */
  _strokePath(path, s) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(path[0][0] * s, path[0][1] * s);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0] * s, path[i][1] * s);
    ctx.stroke();
  }

  /*
   * Мосты — там, где дорога проходит над водой (рекой/протокой), рисуем
   * поперечные «перильца». Сразу видно, что это переправа, а не дорога по воде.
   */
  _drawBridges(map, sorted, dims) {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.strokeStyle = COLORS.BRIDGE;
    ctx.lineCap = "round";
    for (const road of sorted) {
      const p = road.path;
      if (!p || p.length < 2) continue;
      const half = dims(road.klass).cas * 0.6;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i];
        const b = p[i + 1];
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const cx = Math.round(mx);
        const cy = Math.round(my);
        if (cx < 0 || cy < 0 || cx >= map.size || cy >= map.size) continue;
        if (map.type[cy * map.size + cx] !== TERRAIN.WATER) continue;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L;
        const ny = dx / L;
        const pmx = mx * s;
        const pmy = my * s;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pmx + nx * half, pmy + ny * half);
        ctx.lineTo(pmx - nx * half, pmy - ny * half);
        ctx.stroke();
      }
    }
  }

  /* 5. Сетка координат с подписями по краям. */
  _drawGrid(map) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // Сторона квадрата сетки — «круглое» число км, подобранное так, чтобы
    // делений было около десятка. Так сетка отражает реальный масштаб карты.
    const gridKm = this._niceStep(map.scaleKm / 9);
    const pxPerKm = W / map.scaleKm;
    const step = gridKm * pxPerKm;
    const divisions = Math.ceil(map.scaleKm / gridKm);

    ctx.strokeStyle = COLORS.GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.GRID_TEXT;
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";

    for (let i = 0; i <= divisions; i++) {
      const p = i * step;
      if (p > W + 0.5) break;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, H);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(W, p);
      ctx.stroke();

      if (i < divisions) {
        const label = String(i + 1).padStart(2, "0");
        ctx.textAlign = "left";
        ctx.fillText(label, p + 3, 3);
        ctx.fillText(label, p + 3, H - 14);
        ctx.fillText(label, 3, p + 3);
      }
    }
  }

  /* Подбирает «круглый» шаг (1/2/5×10ⁿ км), не меньший target. */
  _niceStep(target) {
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    for (const s of steps) if (s >= target) return s;
    return steps[steps.length - 1];
  }

  /*
   * Масштабная линейка в левом нижнем углу: чёрно-белый отрезок, длина которого
   * равна круглому числу километров. Сразу понятен реальный масштаб карты.
   */
  _drawScaleBar(map) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const pxPerKm = W / map.scaleKm;

    const barKm = this._niceStep(map.scaleKm / 6); // ~1/6 ширины карты
    const barPx = barKm * pxPerKm;
    const segments = barKm % 4 === 0 ? 4 : barKm % 3 === 0 ? 3 : 2;
    const segPx = barPx / segments;

    const x0 = 18;
    const y0 = H - 30;
    const h = 7;

    // полупрозрачная подложка для читаемости
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.fillRect(x0 - 8, y0 - 16, barPx + 64, 34);

    // чередующиеся чёрно-белые сегменты
    for (let i = 0; i < segments; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#1a1a1a" : "#ffffff";
      ctx.fillRect(x0 + i * segPx, y0, segPx, h);
    }
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, barPx, h);

    // подписи: 0 слева, число км справа
    ctx.fillStyle = COLORS.GRID_TEXT;
    ctx.font = "bold 11px 'Segoe UI', sans-serif";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText("0", x0 - 2, y0 - 2);
    ctx.textAlign = "center";
    ctx.fillText(`${barKm} км`, x0 + barPx, y0 - 2);
  }

  /*
   * 6. Населённые пункты: пятно застройки, улицы, дома; затем отметки и подписи.
   * Сначала рисуем все «тела», потом поверх — подписи, чтобы текст не
   * перекрывался зданиями соседнего пункта.
   */
  _drawTowns(map, showLabels) {
    for (const town of map.towns) {
      this._drawBuiltUp(town);
      this._drawTownSquare(town);
      this._drawTownStreets(town);
      this._drawTownBuildings(town);
    }
    // Точка-отметка для мелких пунктов (деревня/село): на крупном регионе их
    // застройка — всего пара блоков, и отметка помогает их не потерять.
    for (const town of map.towns) this._drawTownMarker(town);
    if (showLabels) {
      for (const town of map.towns) this._drawTownLabel(town);
    }
  }

  /* Пятно застройки — лёгкая заливка под домами (сливается в «тело» пункта). */
  _drawBuiltUp(town) {
    if (!town.buildings) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.fillStyle = COLORS.BUILTUP;
    for (const b of town.buildings) {
      const r = (Math.max(b.w, b.h) * 0.6 + 1.3) * s;
      ctx.beginPath();
      ctx.arc(b.x * s, b.y * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* Центральная площадь — открытое светлое пятно в середине посёлков/городов. */
  _drawTownSquare(town) {
    if (!town.squareR) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.fillStyle = COLORS.SQUARE;
    ctx.beginPath();
    ctx.arc(town.x * s, town.y * s, town.squareR * s, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Сеть улиц внутри пункта — изогнутые полилинии. */
  _drawTownStreets(town) {
    if (!town.streets || town.streets.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.strokeStyle = COLORS.STREET;
    ctx.lineWidth = 1.3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const line of town.streets) {
      if (line.length < 2) continue;
      ctx.moveTo(line[0][0] * s, line[0][1] * s);
      for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0] * s, line[i][1] * s);
    }
    ctx.stroke();
  }

  /* Здания — повёрнутые прямоугольники; цвет зависит от типа и слегка варьируется. */
  _drawTownBuildings(town) {
    if (!town.buildings) return;
    const ctx = this.ctx;
    const s = this.scale;
    for (const b of town.buildings) {
      const w = b.w * s;
      const h = b.h * s;
      ctx.save();
      ctx.translate(b.x * s, b.y * s);
      ctx.rotate(b.angle);
      ctx.fillStyle = this._buildingColor(b);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.lineWidth = 0.4;
      ctx.strokeStyle = COLORS.BUILDING_EDGE;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }

  /* Цвет здания: базовый по типу + лёгкий разброс яркости (tone) для текстуры. */
  _buildingColor(b) {
    if (b.kind === "industrial") return COLORS.INDUSTRIAL;
    if (b.kind === "civic") return COLORS.CIVIC;
    const g = Math.round(63 + (b.tone || 0) * 25); // 63..88
    return `rgb(${g}, ${g}, ${g})`;
  }

  /* Отметка-точка в центре мелких пунктов (деревня/село), чтобы их было видно. */
  _drawTownMarker(town) {
    if ((town.tier || 0) > 1) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.fillStyle = COLORS.TOWN_MARKER;
    ctx.beginPath();
    ctx.arc(town.x * s, town.y * s, town.tier === 1 ? 2.2 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  /*
   * Подпись пункта: размер шрифта зависит от вида (деревня — мелко, мегаполис —
   * крупно), города и мегаполисы — ЗАГЛАВНЫМИ. Под названием у посёлков и
   * крупнее — мелкая подпись вида («город», «мегаполис»…).
   */
  _drawTownLabel(town) {
    const ctx = this.ctx;
    const s = this.scale;
    const def = SETTLEMENT_TIERS[town.tier || 1] || SETTLEMENT_TIERS[1];
    const tier = town.tier || 0;
    const cx = town.x * s;
    const cy = town.y * s - (town.radius || 4) * s - 4;

    const fs = Math.max(9, Math.round(12 * (def.labelScale || 1)));
    let text = town.name;
    if (tier >= 3) text = text.toUpperCase();

    // мелкая подпись вида — над названием
    if (tier >= 2) {
      const fs2 = Math.max(8, Math.round(fs * 0.6));
      ctx.font = `${fs2}px 'Segoe UI', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = COLORS.TOWN_HALO;
      ctx.strokeText(town.kindLabel, cx, cy - fs - 1);
      ctx.fillStyle = COLORS.TOWN_KIND;
      ctx.fillText(town.kindLabel, cx, cy - fs - 1);
    }

    ctx.font = `bold ${fs}px 'Segoe UI', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.TOWN_HALO;
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = COLORS.TOWN_TEXT;
    ctx.fillText(text, cx, cy);
  }

  /* Аккуратная рамка вокруг всей карты. */
  _drawBorder() {
    const ctx = this.ctx;
    ctx.strokeStyle = "#3a4256";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.canvas.width - 2, this.canvas.height - 2);
  }
}
