const MODULE_ID = "scene-shitposts";
const SOCKET_NAME = `module.${MODULE_ID}`;
const CLONE_PREFIX = "SHITPOST_CLONE::";

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "m4v", "mov", "ogv"]);
const IMAGE_EXTENSIONS = new Set(["gif", "png", "apng", "jpg", "jpeg", "jfif", "webp", "avif", "bmp", "svg"]);
// Расширения, которые точно не бывают анимированными: для них при вставке достаточно битмапа из буфера
const STATIC_EXTENSIONS = new Set(["jpg", "jpeg", "jfif", "bmp", "svg"]);
const ANIMATABLE_MIMES = new Set(["image/gif", "image/webp", "image/png", "image/avif"]);
const MIME_EXTENSIONS = {
  "image/gif": "gif",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm"
};
// Не сохраняем на сервер файлы крупнее этого размера, оставляем внешнюю ссылку
const MAX_CACHE_BYTES = 30 * 1024 * 1024;
// Публичные CORS-прокси, используются по очереди, если хостинг не отдаёт CORS-заголовки
const CORS_PROXIES = [
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
];

/**
 * Обёртки над API, которые переехали между версиями Foundry (v12 — глобалы, v13+ — неймспейс foundry.*)
 */
const Compat = {
  get FilePicker() {
    return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  },
  loadTexture(src) {
    const loader = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
    return loader(src);
  }
};

/**
 * Определяет реальный формат файла по первым байтам, не доверяя расширению и Content-Type
 */
function sniffMedia(buffer) {
  const arr = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64));
  if (arr.length < 12) return null;
  const ascii = (from, to) => String.fromCharCode(...arr.subarray(from, to));

  // GIF87a / GIF89a
  if (ascii(0, 4) === "GIF8") return { mime: "image/gif", type: "image" };
  // PNG (в том числе APNG)
  if (arr[0] === 0x89 && ascii(1, 4) === "PNG") return { mime: "image/png", type: "image" };
  // JPEG
  if (arr[0] === 0xff && arr[1] === 0xd8 && arr[2] === 0xff) return { mime: "image/jpeg", type: "image" };
  // WEBP: RIFF....WEBP
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", type: "image" };
  // BMP
  if (ascii(0, 2) === "BM") return { mime: "image/bmp", type: "image" };
  // ISO BMFF: ....ftyp<brand> — AVIF или MP4/MOV
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", type: "image" };
    return { mime: "video/mp4", type: "video" };
  }
  // WebM / Matroska
  if (arr[0] === 0x1a && arr[1] === 0x45 && arr[2] === 0xdf && arr[3] === 0xa3) {
    return { mime: "video/webm", type: "video" };
  }

  const head = new TextDecoder().decode(arr).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return { mime: "image/svg+xml", type: "image" };
  }
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<!--")) {
    return { mime: "text/html", html: new TextDecoder().decode(buffer) };
  }
  return null;
}

/**
 * Короткий стабильный хеш строки (FNV-1a), чтобы одна и та же ссылка сохранялась в один и тот же файл
 */
function hashString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Утилита для превращения любых ссылок (Discord Attachments, Discord Proxy, Giphy, Tenor, Klipy, Imgur) в прямые рабочие медиа-файлы
 */
class MediaUrlResolver {
  // Недавно скачанные файлы: resolve() и загрузка на холст не качают один и тот же файл дважды
  static _bufferCache = new Map();

  static async resolve(rawUrl) {
    const url = this.normalize(rawUrl);

    const byExtension = this.typeFromExtension(url);
    if (byExtension) return { src: url, type: byExtension };
    if (!this.isRemote(url)) return { src: url, type: "image" };

    // Расширения нет (или оно незнакомое): скачиваем и смотрим, что внутри.
    // Если это HTML-страница (tenor.com/view/..., klipy.com/gifs/..., imgur.com/...), достаём медиа из Open Graph
    try {
      const { buffer } = await this.fetchMediaBuffer(url);
      const sniffed = sniffMedia(buffer);
      if (sniffed?.type) return { src: url, type: sniffed.type };
      if (sniffed?.html) {
        const fromPage = this._extractOpenGraphMedia(sniffed.html, url);
        if (fromPage) return fromPage;
      }
    } catch (e) {
      console.warn("Scene Shitposts | Не удалось определить тип ссылки:", url, e);
    }

    return { src: url, type: "image" };
  }

  /**
   * Приводит ссылку к прямому адресу файла без сетевых запросов
   */
  static normalize(rawUrl) {
    const url = String(rawUrl ?? "").trim().split(/\s+/)[0];

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      // Относительный путь (файл, загруженный в мир) — оставляем как есть
      return url;
    }
    const host = parsed.hostname.toLowerCase();

    // 1. Внешний прокси Дискорда: images-ext-1.discordapp.net/external/<hash>/[%3Fquery/]https/host/path?width=...
    if (/(^|\.)discordapp\.net$/.test(host) && parsed.pathname.startsWith("/external/")) {
      const inner = this._unwrapDiscordExternal(parsed);
      if (inner) return this.normalize(inner);
    }

    // 2. Вложения Discord через media-прокси -> cdn.discordapp.com (оригинал без пережатия, открыт CORS).
    // Параметры подписи ex/is/hm сохраняются, параметры ресайза удаляются — они ломают анимацию
    if (host === "media.discordapp.net" && /^\/(attachments|ephemeral-attachments)\//.test(parsed.pathname)) {
      parsed.hostname = "cdn.discordapp.com";
      for (const key of ["width", "height", "format", "quality", ""]) parsed.searchParams.delete(key);
      return parsed.toString();
    }

    // 3. Imgur .gifv — это HTML-обёртка, сам файл лежит рядом как .mp4
    if (host === "i.imgur.com" && /\.gifv$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\.gifv$/i, ".mp4");
      return parsed.toString();
    }

    // 4. Страницы Giphy: giphy.com/gifs/<slug>-<id>, giphy.com/embed/<id>, giphy.com/stickers/<slug>-<id>
    if ((host === "giphy.com" || host === "www.giphy.com")) {
      const match = parsed.pathname.match(/^\/(gifs|embed|stickers)\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/);
      if (match) {
        // У стикеров прозрачный фон, которого нет в MP4, поэтому для них берём GIF
        const file = match[1] === "stickers" ? "giphy.gif" : "giphy.mp4";
        return `https://media.giphy.com/media/${match[2]}/${file}`;
      }
    }

    return parsed.toString();
  }

  static _unwrapDiscordExternal(parsed) {
    try {
      // ["", "external", "<hash>", ...]
      const segments = parsed.pathname.split("/").slice(3);
      let query = "";
      while (segments.length && !/^https?$/i.test(segments[0])) {
        const segment = decodeURIComponent(segments.shift());
        if (segment.startsWith("?")) query = segment;
      }
      if (segments.length < 2) return null;
      const protocol = segments.shift().toLowerCase();
      return `${protocol}://${segments.join("/")}${query}`;
    } catch {
      return null;
    }
  }

  static _extension(url) {
    let path;
    try {
      path = new URL(url, window.location.href).pathname;
    } catch {
      path = url.split(/[?#]/)[0];
    }
    const dot = path.lastIndexOf(".");
    if (dot === -1 || dot < path.lastIndexOf("/")) return null;
    return path.slice(dot + 1).toLowerCase();
  }

  static typeFromExtension(url) {
    const ext = this._extension(url);
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    return null;
  }

  /**
   * true, если по ссылке может лежать анимация (или неизвестно, что там лежит)
   */
  static mayBeAnimated(url) {
    const ext = this._extension(this.normalize(url));
    return !STATIC_EXTENSIONS.has(ext) && ext !== "png";
  }

  static isRemote(url) {
    try {
      return new URL(url, window.location.href).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  static _extractOpenGraphMedia(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const meta = (...selectors) => {
      for (const selector of selectors) {
        const content = doc.querySelector(selector)?.getAttribute("content");
        if (content) {
          try {
            return new URL(content, pageUrl).toString();
          } catch {
            // Битая ссылка в meta — пробуем следующую
          }
        }
      }
      return null;
    };

    const ogVideo = meta(
      'meta[property="og:video:secure_url"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video"]',
      'meta[name="twitter:player:stream"]'
    );
    const ogVideoType = doc.querySelector('meta[property="og:video:type"]')?.getAttribute("content") || "";
    // og:video бывает ссылкой на HTML-плеер (YouTube и т. п.), берём только прямые файлы
    if (ogVideo && (this.typeFromExtension(ogVideo) === "video" || ogVideoType.startsWith("video/"))) {
      return { src: this.normalize(ogVideo), type: "video" };
    }

    const ogImage = meta(
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]'
    );
    if (ogImage) {
      const src = this.normalize(ogImage);
      return { src, type: this.typeFromExtension(src) || "image" };
    }

    return null;
  }

  /**
   * Скачивает бинарные данные картинки/гифки с умным обходом CORS
   */
  static fetchMediaBuffer(src) {
    const cached = this._bufferCache.get(src);
    if (cached) return cached;

    const promise = this._downloadBuffer(src);
    this._bufferCache.set(src, promise);
    promise.then(
      () => setTimeout(() => this._bufferCache.delete(src), 60_000),
      () => this._bufferCache.delete(src)
    );
    return promise;
  }

  static async _downloadBuffer(src) {
    const read = async (res) => ({
      buffer: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") || ""
    });

    // Попытка 1: Прямой запрос (работает для файлов мира, cdn.discordapp.com, media.giphy.com и других хостингов с CORS)
    try {
      const res = await fetch(src, { mode: "cors", credentials: this.isRemote(src) ? "omit" : "same-origin" });
      if (res.ok) return await read(res);
    } catch {
      // Переходим к запасному прокси
    }

    // Попытка 2: Через резервные CORS-прокси (правильно кодируя URL со всеми амперсандами)
    if (this.isRemote(src)) {
      for (const makeProxyUrl of CORS_PROXIES) {
        try {
          const res = await fetch(makeProxyUrl(src), { credentials: "omit" });
          if (res.ok) return await read(res);
        } catch {
          // Пробуем следующий прокси
        }
      }
    }

    throw new Error(`Не удалось скачать ресурс: ${src}`);
  }
}

/**
 * Интерактивный контейнер отдельного щитпоста с рамкой и 4 ручками трансформации
 */
class ShitpostNode extends PIXI.Container {
  constructor(data, layer) {
    super();
    this.data = foundry.utils.deepClone(data);
    this.layer = layer;
    this.isSelected = false;
    this.isDragging = false;
    this.isResizing = false;
    this.resizeHandle = null;
    this.videoElement = null;
    this.animation = null;
    this.ownedTextures = [];
    this.objectUrl = null;
    this.loadToken = 0;

    this.position.set(this.data.x, this.data.y);
    this.eventMode = "static";
    this.cursor = "pointer";

    this.loadingSpinner = new PIXI.Graphics();
    this._drawLoadingPlaceholder();
    this.addChild(this.loadingSpinner);

    this.mediaSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.mediaSprite.anchor.set(0.5);
    this.mediaSprite.visible = false;
    this.addChild(this.mediaSprite);

    this.border = new PIXI.Graphics();
    this.addChild(this.border);

    this.handles = {};
    this._createHandles();
    this._loadMedia();
    this._bindEvents();
  }

  _drawLoadingPlaceholder() {
    this.loadingSpinner.clear();
    this.loadingSpinner.beginFill(0x222222, 0.6);
    this.loadingSpinner.lineStyle(2, 0x00bcd4, 0.8);
    this.loadingSpinner.drawRoundedRect(-60, -60, 120, 120, 12);
    this.loadingSpinner.endFill();
  }

  _isStale(token) {
    return this.destroyed || token !== this.loadToken;
  }

  async _loadMedia() {
    const token = ++this.loadToken;
    const { src, type } = await MediaUrlResolver.resolve(this.data.src);
    if (this._isStale(token)) return;

    if (type === "video") {
      await this._loadVideoMedia(src, token);
    } else {
      // Сюда же попадают старые посты с type "gif"
      await this._loadImageMedia(src, token);
    }
  }

  async _loadVideoMedia(src, token) {
    try {
      await this._playVideo(src, MediaUrlResolver.isRemote(src), token);
    } catch (err) {
      if (this._isStale(token)) return;
      // Хостинг без CORS: WebGL не может взять кадры такого видео, поэтому скачиваем его целиком и играем из Blob
      try {
        if (!MediaUrlResolver.isRemote(src)) throw err;
        const { buffer, contentType } = await MediaUrlResolver.fetchMediaBuffer(src);
        if (this._isStale(token)) return;
        const mime = sniffMedia(buffer)?.mime || contentType.split(";")[0].trim() || "video/mp4";
        await this._playVideo(this._createObjectUrl(buffer, mime), false, token);
      } catch (fallbackErr) {
        console.error("Scene Shitposts | Ошибка загрузки видео:", src, err, fallbackErr);
        this._showErrorState(token);
      }
    }
  }

  async _playVideo(url, useCors, token) {
    const video = document.createElement("video");
    if (useCors) video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(video.error ?? new Error(`Видео не загрузилось: ${url}`));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("error", onError);
      video.load();
    });

    if (this._isStale(token)) {
      video.removeAttribute("src");
      video.load();
      return;
    }

    this.videoElement = video;
    const tex = PIXI.Texture.from(video, {
      resourceOptions: { autoPlay: true, updateFPS: 0 }
    });
    if (tex.baseTexture?.resource) {
      tex.baseTexture.resource.autoUpdate = true;
    }
    this._showTexture(tex, true);
    this._applyInitialDimensions(video.videoWidth || 300, video.videoHeight || 300);

    // Отказ автозапуска не ошибка загрузки: первый кадр уже на холсте
    video.play().catch(err => console.warn("Scene Shitposts | Браузер не дал запустить видео:", err));
  }

  async _loadImageMedia(src, token) {
    let buffer;
    let mime;
    try {
      const res = await MediaUrlResolver.fetchMediaBuffer(src);
      buffer = res.buffer;
      mime = sniffMedia(buffer)?.mime || res.contentType.split(";")[0].trim() || "image/png";
    } catch {
      // Если совсем не вышло через fetch, пробуем нативный загрузчик Foundry
      await this._loadViaFoundry(src, token);
      return;
    }
    if (this._isStale(token)) return;

    // Ссылка с расширением .gif, внутри которой на самом деле MP4/WebM
    if (mime.startsWith("video/")) {
      try {
        await this._playVideo(this._createObjectUrl(buffer, mime), false, token);
      } catch (err) {
        console.error("Scene Shitposts | Ошибка загрузки видео:", src, err);
        this._showErrorState(token);
      }
      return;
    }

    try {
      if (await this._playAnimated(buffer, mime, token)) return;
    } catch (err) {
      console.warn("Scene Shitposts | ImageDecoder не смог декодировать анимацию, открываем как статику:", src, err);
    }
    if (this._isStale(token)) return;

    try {
      await this._loadFromBuffer(buffer, mime, token);
    } catch {
      await this._loadViaFoundry(src, token);
    }
  }

  /**
   * Проигрывает анимированный GIF / WebP / APNG / AVIF. Кадры декодируются по одному
   * в один и тот же canvas, поэтому длинные гифки не забивают память видеокарты.
   * Возвращает false, если файл не анимирован или браузер не умеет его декодировать.
   */
  async _playAnimated(buffer, mime, token) {
    if (!ANIMATABLE_MIMES.has(mime) || typeof ImageDecoder === "undefined") return false;
    if (!(await ImageDecoder.isTypeSupported(mime))) return false;

    const decoder = new ImageDecoder({ data: buffer, type: mime });
    try {
      await decoder.tracks.ready;
      // Количество кадров окончательное только после разбора всего файла
      await decoder.completed;
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
      if (frameCount < 2 || this._isStale(token)) {
        decoder.close();
        return false;
      }

      const first = (await decoder.decode({ frameIndex: 0 })).image;
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = first.displayWidth;
      frameCanvas.height = first.displayHeight;
      const ctx = frameCanvas.getContext("2d");
      ctx.drawImage(first, 0, 0);
      const firstDelay = this._frameDelay(first);
      first.close();

      if (this._isStale(token)) {
        decoder.close();
        return true;
      }

      const tex = PIXI.Texture.from(frameCanvas);
      this.animation = { decoder, timer: null, closed: false };
      this._showTexture(tex, true);
      this._applyInitialDimensions(frameCanvas.width, frameCanvas.height);

      const animation = this.animation;
      let frameIndex = 0;
      const playNextFrame = async () => {
        if (animation.closed) return;
        const started = performance.now();
        frameIndex = (frameIndex + 1) % frameCount;
        let delay = 100;
        try {
          const frame = (await decoder.decode({ frameIndex })).image;
          if (animation.closed) {
            frame.close();
            return;
          }
          // ImageDecoder отдаёт уже собранные полные кадры, поэтому старый кадр просто затираем
          ctx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
          ctx.drawImage(frame, 0, 0);
          delay = this._frameDelay(frame);
          frame.close();
          tex.baseTexture.update();
        } catch (err) {
          if (animation.closed) return;
          console.warn("Scene Shitposts | Ошибка декодирования кадра:", err);
        }
        animation.timer = setTimeout(playNextFrame, Math.max(0, delay - (performance.now() - started)));
      };
      animation.timer = setTimeout(playNextFrame, firstDelay);
      return true;
    } catch (err) {
      decoder.close();
      throw err;
    }
  }

  _frameDelay(frame) {
    // duration в микросекундах. Браузеры показывают кадры с задержкой <= 10 мс как 100 мс, повторяем это поведение
    const ms = (frame.duration ?? 0) / 1000;
    return ms <= 10 ? 100 : ms;
  }

  _createObjectUrl(buffer, mime) {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
    return this.objectUrl;
  }

  async _loadFromBuffer(buffer, mime, token) {
    const objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = objectUrl;
      });
      await img.decode?.().catch(() => {});
      if (this._isStale(token)) return;
      this._showTexture(PIXI.Texture.from(img), true);
      this._applyInitialDimensions(img.naturalWidth || 300, img.naturalHeight || 300);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async _loadViaFoundry(src, token) {
    try {
      const tex = await Compat.loadTexture(src);
      if (this._isStale(token) || !tex) return;
      // Текстуры из кеша Foundry общие, их не уничтожаем
      this._showTexture(tex, false);
      this._applyInitialDimensions(tex.width || 300, tex.height || 300);
    } catch (err) {
      console.error("Scene Shitposts | Не удалось загрузить изображение:", src, err);
      this._showErrorState(token);
    }
  }

  _showTexture(tex, owned) {
    if (owned) this.ownedTextures.push(tex);
    this.mediaSprite.texture = tex;
    this.mediaSprite.visible = true;
    this.loadingSpinner.visible = false;
  }

  _showErrorState(token) {
    if (this._isStale(token)) return;
    this.loadingSpinner.clear();
    this.loadingSpinner.beginFill(0x550000, 0.7);
    this.loadingSpinner.lineStyle(2, 0xff4444, 1);
    this.loadingSpinner.drawRoundedRect(-60, -60, 120, 120, 12);
    this.loadingSpinner.endFill();
    this.loadingSpinner.visible = true;
  }

  _applyInitialDimensions(natWidth, natHeight) {
    if (!this.data.width || !this.data.height) {
      const maxDim = 350;
      let w = natWidth;
      let h = natHeight;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      this.data.width = Math.max(40, w);
      this.data.height = Math.max(40, h);
      // Размер сохраняет один клиент (автор или активный ГМ), а не каждый, кто загрузил пост
      if (this._isSizeOwner()) {
        ShitpostManager.updatePost({
          id: this.data.id,
          width: this.data.width,
          height: this.data.height
        });
      }
    }
    this.refreshVisuals();
  }

  _isSizeOwner() {
    const author = game.users.get(this.data.authorId);
    if (author?.active) return author.isSelf;
    return game.users.activeGM?.isSelf ?? false;
  }

  _createHandles() {
    const corners = [
      { key: "tl", cursor: "nwse-resize" },
      { key: "tr", cursor: "nesw-resize" },
      { key: "bl", cursor: "nesw-resize" },
      { key: "br", cursor: "nwse-resize" }
    ];

    for (const c of corners) {
      const h = new PIXI.Graphics();
      h.beginFill(0xffffff);
      h.lineStyle(2, 0x00bcd4, 1);
      h.drawRect(-7, -7, 14, 14);
      h.endFill();
      h.eventMode = "static";
      h.cursor = c.cursor;
      h.visible = false;

      h.on("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.layer.selectNode(this);
        this.isResizing = true;
        this.resizeHandle = c.key;
        this.resizeStart = {
          w: this.data.width || 200,
          h: this.data.height || 200,
          x: this.x,
          y: this.y,
          mouse: this.layer.toLocal(e.global)
        };
      });

      this.handles[c.key] = h;
      this.addChild(h);
    }
  }

  refreshVisuals() {
    const w = this.data.width || 120;
    const h = this.data.height || 120;

    this.mediaSprite.width = w;
    this.mediaSprite.height = h;
    this.position.set(this.data.x, this.data.y);

    this.border.clear();
    if (this.isSelected) {
      this.border.lineStyle(2, 0x00e5ff, 0.95);
      this.border.drawRect(-w / 2, -h / 2, w, h);

      this.handles.tl.position.set(-w / 2, -h / 2);
      this.handles.tr.position.set(w / 2, -h / 2);
      this.handles.bl.position.set(-w / 2, h / 2);
      this.handles.br.position.set(w / 2, h / 2);

      Object.values(this.handles).forEach(handle => (handle.visible = true));
    } else {
      Object.values(this.handles).forEach(handle => (handle.visible = false));
    }
  }

  setSelected(selected) {
    this.isSelected = selected;
    this.refreshVisuals();
  }

  _bindEvents() {
    this.on("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.layer.selectNode(this);

      if (!this.isResizing) {
        this.isDragging = true;
        this.alpha = 0.85;
        const localPos = this.layer.toLocal(e.global);
        this.dragOffset = {
          x: this.x - localPos.x,
          y: this.y - localPos.y
        };
      }
    });
  }

  onGlobalMove(e) {
    if (!this.isDragging && !this.isResizing) return;
    const pos = this.layer.toLocal(e.global);

    if (this.isDragging) {
      this.data.x = Math.round(pos.x + this.dragOffset.x);
      this.data.y = Math.round(pos.y + this.dragOffset.y);
      this.position.set(this.data.x, this.data.y);
    } else if (this.isResizing) {
      const dx = pos.x - this.resizeStart.mouse.x;
      const dy = pos.y - this.resizeStart.mouse.y;
      let newW = this.resizeStart.w;
      let newH = this.resizeStart.h;
      let newX = this.resizeStart.x;
      let newY = this.resizeStart.y;

      const minSize = 30;

      if (this.resizeHandle.includes("r")) {
        newW = Math.max(minSize, this.resizeStart.w + dx);
        newX = this.resizeStart.x + (newW - this.resizeStart.w) / 2;
      } else if (this.resizeHandle.includes("l")) {
        newW = Math.max(minSize, this.resizeStart.w - dx);
        newX = this.resizeStart.x - (newW - this.resizeStart.w) / 2;
      }

      if (this.resizeHandle.includes("b")) {
        newH = Math.max(minSize, this.resizeStart.h + dy);
        newY = this.resizeStart.y + (newH - this.resizeStart.h) / 2;
      } else if (this.resizeHandle.includes("t")) {
        newH = Math.max(minSize, this.resizeStart.h - dy);
        newY = this.resizeStart.y - (newH - this.resizeStart.h) / 2;
      }

      if (e.shiftKey) {
        const ratio = this.resizeStart.w / this.resizeStart.h;
        newH = newW / ratio;
      }

      this.data.width = Math.round(newW);
      this.data.height = Math.round(newH);
      this.data.x = Math.round(newX);
      this.data.y = Math.round(newY);
      this.refreshVisuals();
    }
  }

  onGlobalUp() {
    if (!this.isDragging && !this.isResizing) return;

    this.isDragging = false;
    this.isResizing = false;
    this.resizeHandle = null;
    this.alpha = 1.0;

    ShitpostManager.updatePost({
      id: this.data.id,
      x: this.data.x,
      y: this.data.y,
      width: this.data.width,
      height: this.data.height
    });
  }

  updateFromData(newData) {
    const srcChanged = this.data.src !== newData.src;
    this.data = foundry.utils.deepClone(newData);
    if (srcChanged) {
      this._cleanupMedia();
      this._drawLoadingPlaceholder();
      this.loadingSpinner.visible = true;
      this.refreshVisuals();
      this._loadMedia();
    } else if (!this.isDragging && !this.isResizing) {
      this.refreshVisuals();
    }
  }

  _cleanupMedia() {
    // Отменяет загрузки, которые ещё не завершились
    this.loadToken++;

    if (this.animation) {
      this.animation.closed = true;
      clearTimeout(this.animation.timer);
      try {
        this.animation.decoder.close();
      } catch {
        // Декодер уже закрыт
      }
      this.animation = null;
    }
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.removeAttribute("src");
      this.videoElement.load();
      this.videoElement = null;
    }
    if (this.mediaSprite && !this.mediaSprite.destroyed) {
      this.mediaSprite.texture = PIXI.Texture.EMPTY;
      this.mediaSprite.visible = false;
    }
    for (const tex of this.ownedTextures) {
      tex.destroy(true);
    }
    this.ownedTextures = [];
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  destroy(options) {
    this._cleanupMedia();
    super.destroy(options);
  }
}

/**
 * Слой на холсте Foundry для управления всеми щитпостами сцены
 */
class ShitpostLayer extends PIXI.Container {
  constructor() {
    super();
    this.nodes = new Map();
    this.selectedNode = null;
    this.sortableChildren = true;
    this.zIndex = 9999;
    this._bindStageEvents();
  }

  _bindStageEvents() {
    if (!canvas?.app?.stage) return;
    canvas.app.stage.eventMode = "static";

    this._onStageDown = () => {
      if (this.selectedNode) {
        this.selectNode(null);
      }
    };

    this._onStageMove = (e) => {
      if (this.selectedNode) {
        this.selectedNode.onGlobalMove(e);
      }
    };

    this._onStageUp = () => {
      if (this.selectedNode) {
        this.selectedNode.onGlobalUp();
      }
    };

    this._onStagePointerCancel = () => {
      if (this.selectedNode) {
        this.selectedNode.onGlobalUp();
      }
    };

    this._onWindowBlur = () => {
      if (this.selectedNode) {
        this.selectedNode.onGlobalUp();
      }
    };

    canvas.app.stage.on("pointerdown", this._onStageDown);
    canvas.app.stage.on("pointermove", this._onStageMove);
    canvas.app.stage.on("pointerup", this._onStageUp);
    canvas.app.stage.on("pointerupoutside", this._onStageUp);
    canvas.app.stage.on("pointercancel", this._onStagePointerCancel);
    window.addEventListener("blur", this._onWindowBlur);
  }

  selectNode(node) {
    const previous = this.selectedNode;
    if (previous && previous !== node) {
      previous.setSelected(false);
      if (previous.isDragging || previous.isResizing) {
        previous.onGlobalUp();
      }
    }
    this.selectedNode = node;
    if (node) {
      node.setSelected(true);
      this.setChildIndex(node, this.children.length - 1);
    }
  }

  syncPosts() {
    if (!canvas.scene) return;
    const posts = canvas.scene.getFlag(MODULE_ID, "posts") || [];
    const incomingIds = new Set(posts.map(p => p.id));

    for (const [id, node] of this.nodes.entries()) {
      if (!incomingIds.has(id)) {
        if (this.selectedNode === node) this.selectedNode = null;
        node.destroy({ children: true });
        this.nodes.delete(id);
      }
    }

    for (const postData of posts) {
      if (this.nodes.has(postData.id)) {
        this.nodes.get(postData.id).updateFromData(postData);
      } else {
        const node = new ShitpostNode(postData, this);
        this.addChild(node);
        this.nodes.set(postData.id, node);
      }
    }
  }

  clearAllNodes() {
    this.selectedNode = null;
    for (const node of this.nodes.values()) {
      node.destroy({ children: true });
    }
    this.nodes.clear();
  }

  destroy(options) {
    if (canvas?.app?.stage) {
      canvas.app.stage.off("pointerdown", this._onStageDown);
      canvas.app.stage.off("pointermove", this._onStageMove);
      canvas.app.stage.off("pointerup", this._onStageUp);
      canvas.app.stage.off("pointerupoutside", this._onStageUp);
      canvas.app.stage.off("pointercancel", this._onStagePointerCancel);
    }
    if (this._onWindowBlur) {
      window.removeEventListener("blur", this._onWindowBlur);
    }
    this.clearAllNodes();
    super.destroy(options);
  }
}

/**
 * Менеджер синхронизации, буфера обмена и сокетов
 */
class ShitpostManager {
  static copiedPostData = null;
  static isInternalClipboardActive = false;

  static getMouseCanvasPos() {
    if (canvas?.mousePosition) {
      return { x: Math.round(canvas.mousePosition.x), y: Math.round(canvas.mousePosition.y) };
    }
    const center = canvas?.scene?._viewPosition || { x: 1000, y: 1000 };
    return { x: Math.round(center.x), y: Math.round(center.y) };
  }

  static async copyNodeToClipboard(node) {
    if (!node?.data) return;
    this.copiedPostData = foundry.utils.deepClone(node.data);
    this.isInternalClipboardActive = true;

    const payload = CLONE_PREFIX + JSON.stringify({
      src: this.copiedPostData.src,
      type: this.copiedPostData.type,
      width: this.copiedPostData.width,
      height: this.copiedPostData.height
    });

    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Fallback на внутреннюю переменную
    }
  }

  static async addPost(postData) {
    if (!canvas.scene) return;

    const isFreshLink = !postData.type;
    const resolved = isFreshLink
      ? await MediaUrlResolver.resolve(postData.src)
      : { src: postData.src, type: postData.type };

    const newPost = {
      id: foundry.utils.randomID(),
      src: resolved.src,
      type: resolved.type,
      x: postData.x,
      y: postData.y,
      width: postData.width || null,
      height: postData.height || null,
      authorId: game.user.id
    };

    // Новую внешнюю ссылку сохраняем в папку мира: все клиенты грузят её с сервера Foundry,
    // без CORS-прокси, а протухшие ссылки Discord продолжают работать
    if (isFreshLink && this.shouldCacheRemote(newPost.src)) {
      if (this.canUpload()) {
        const cached = await this.cacheRemoteMedia(newPost.src);
        if (cached) Object.assign(newPost, cached);
      } else {
        game.socket.emit(SOCKET_NAME, { action: "CACHE_AND_ADD", sceneId: canvas.scene.id, post: newPost });
        return;
      }
    }

    if (game.user.isGM) {
      await this._gmAddPost(canvas.scene.id, newPost);
    } else {
      game.socket.emit(SOCKET_NAME, { action: "ADD_POST", sceneId: canvas.scene.id, post: newPost });
    }
  }

  static canUpload() {
    return game.user.isGM || game.user.can("FILES_UPLOAD");
  }

  static shouldCacheRemote(src) {
    return game.settings.get(MODULE_ID, "cacheRemoteMedia") && MediaUrlResolver.isRemote(src);
  }

  /**
   * Скачивает внешний файл и загружает его в папку мира.
   * Возвращает { src, type } с локальным путём или null, если сохранить не вышло.
   */
  static async cacheRemoteMedia(src) {
    try {
      const { buffer, contentType } = await MediaUrlResolver.fetchMediaBuffer(src);
      if (buffer.byteLength > MAX_CACHE_BYTES) return null;
      const mime = sniffMedia(buffer)?.mime || contentType.split(";")[0].trim();
      const ext = MIME_EXTENSIONS[mime];
      // Не медиа (например, HTML-страница с ошибкой) — оставляем ссылку как есть
      if (!ext) return null;

      const file = new File([buffer], `url-${hashString(src)}.${ext}`, { type: mime });
      const path = await this.uploadToWorld(file);
      if (!path) return null;
      return { src: path, type: mime.startsWith("video/") ? "video" : "image" };
    } catch (err) {
      console.warn("Scene Shitposts | Не удалось сохранить файл на сервер, остаётся внешняя ссылка:", src, err);
      return null;
    }
  }

  static async uploadToWorld(file) {
    const dirPath = `worlds/${game.world.id}/shitposts`;
    await this._ensureDirectory(dirPath);
    const response = await Compat.FilePicker.upload("data", dirPath, file, {}, { notify: false });
    return response?.path ?? null;
  }

  static async updatePost(partialData) {
    if (!canvas.scene) return;
    if (game.user.isGM) {
      await this._gmUpdatePost(canvas.scene.id, partialData);
    } else {
      game.socket.emit(SOCKET_NAME, { action: "UPDATE_POST", sceneId: canvas.scene.id, update: partialData });
    }
  }

  static async deletePost(postId) {
    if (!canvas.scene) return;
    if (game.user.isGM) {
      await this._gmDeletePost(canvas.scene.id, postId);
    } else {
      game.socket.emit(SOCKET_NAME, { action: "DELETE_POST", sceneId: canvas.scene.id, postId });
    }
  }

  static async _gmAddPost(sceneId, post) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const posts = foundry.utils.deepClone(scene.getFlag(MODULE_ID, "posts") || []);
    posts.push(post);
    await scene.setFlag(MODULE_ID, "posts", posts);
  }

  static async _gmUpdatePost(sceneId, update) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const posts = foundry.utils.deepClone(scene.getFlag(MODULE_ID, "posts") || []);
    const idx = posts.findIndex(p => p.id === update.id);
    if (idx !== -1) {
      posts[idx] = foundry.utils.mergeObject(posts[idx], update);
      await scene.setFlag(MODULE_ID, "posts", posts);
    }
  }

  static async _gmDeletePost(sceneId, postId) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    let posts = foundry.utils.deepClone(scene.getFlag(MODULE_ID, "posts") || []);
    posts = posts.filter(p => p.id !== postId);
    await scene.setFlag(MODULE_ID, "posts", posts);
  }

  static async handleRawImageBlob(blob, spawnPos) {
    try {
      const isGif = blob.type === "image/gif";
      const finalBlob = isGif ? blob : await this._convertToWebP(blob);
      const ext = isGif ? "gif" : "webp";
      const fileName = `shitpost-${Date.now()}-${foundry.utils.randomID(4)}.${ext}`;
      const file = new File([finalBlob], fileName, { type: finalBlob.type });

      if (this.canUpload()) {
        const path = await this.uploadToWorld(file);
        if (path) {
          await this.addPost({ src: path, type: "image", x: spawnPos.x, y: spawnPos.y });
        }
      } else {
        const base64 = await this._blobToBase64(finalBlob);
        game.socket.emit(SOCKET_NAME, {
          action: "UPLOAD_AND_SPAWN",
          sceneId: canvas.scene.id,
          base64,
          fileName,
          mimeType: finalBlob.type,
          x: spawnPos.x,
          y: spawnPos.y,
          authorId: game.user.id
        });
      }
    } catch (err) {
      console.error("Scene Shitposts | Ошибка при обработке скриншота:", err);
      ui.notifications.error("Не удалось вставить изображение из буфера обмена.");
    }
  }

  static async _ensureDirectory(dirPath) {
    try {
      await Compat.FilePicker.createDirectory("data", dirPath, {});
    } catch {
      // Папка уже есть
    }
  }

  static _convertToWebP(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const maxDim = 800;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const offCanvas = document.createElement("canvas");
        offCanvas.width = w;
        offCanvas.height = h;
        const ctx = offCanvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        offCanvas.toBlob(webp => resolve(webp || blob), "image/webp", 0.85);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  static _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

function isTypingInInput() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || active.isContentEditable) return true;
  if (active.closest(".editor-content, .prosemirror, #chat-message")) return true;
  return false;
}

function extractClipboardHtmlUrl(clipboard) {
  const html = clipboard.getData("text/html");
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const src = doc.querySelector("img[src], video[src], video source[src]")?.getAttribute("src");
  return src && /^https?:\/\//i.test(src) ? src : null;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "cacheRemoteMedia", {
    name: "Сохранять внешние картинки на сервер",
    hint: "Вставленные по ссылке картинки и гифки скачиваются в папку мира (worlds/<мир>/shitposts). Все игроки грузят их с сервера Foundry: не нужны CORS-прокси, и ссылки Discord не протухают. Файлы занимают место на диске сервера.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET_NAME, async (payload) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    try {
      if (payload.action === "ADD_POST") {
        await ShitpostManager._gmAddPost(payload.sceneId, payload.post);
      } else if (payload.action === "UPDATE_POST") {
        await ShitpostManager._gmUpdatePost(payload.sceneId, payload.update);
      } else if (payload.action === "DELETE_POST") {
        await ShitpostManager._gmDeletePost(payload.sceneId, payload.postId);
      } else if (payload.action === "CACHE_AND_ADD") {
        // У игрока нет права загружать файлы: ГМ сам скачивает ссылку и сохраняет её в мир
        const post = payload.post;
        const cached = await ShitpostManager.cacheRemoteMedia(post.src);
        if (cached) Object.assign(post, cached);
        await ShitpostManager._gmAddPost(payload.sceneId, post);
      } else if (payload.action === "UPLOAD_AND_SPAWN") {
        const res = await fetch(payload.base64);
        const blob = await res.blob();
        const file = new File([blob], payload.fileName, { type: payload.mimeType || "image/webp" });
        const path = await ShitpostManager.uploadToWorld(file);
        if (path) {
          await ShitpostManager._gmAddPost(payload.sceneId, {
            id: foundry.utils.randomID(),
            src: path,
            type: "image",
            x: payload.x,
            y: payload.y,
            width: null,
            height: null,
            authorId: payload.authorId
          });
        }
      }
    } catch (err) {
      console.error(`Scene Shitposts | Ошибка обработки запроса ${payload.action}:`, err);
    }
  });

  window.addEventListener("keydown", async (e) => {
    if (isTypingInInput() || !canvas?.ready) return;
    const layer = canvas?.shitpostLayer;

    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC") {
      if (layer?.selectedNode) {
        e.preventDefault();
        e.stopPropagation();
        await ShitpostManager.copyNodeToClipboard(layer.selectedNode);
      }
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (layer?.selectedNode) {
        e.preventDefault();
        e.stopPropagation();
        const idToDelete = layer.selectedNode.data.id;
        layer.selectNode(null);
        await ShitpostManager.deletePost(idToDelete);
      }
    }
  }, true);

  window.addEventListener("copy", (e) => {
    if (isTypingInInput() || !canvas?.ready) return;
    const node = canvas?.shitpostLayer?.selectedNode;
    if (node) {
      e.preventDefault();
      e.stopPropagation();
      ShitpostManager.copiedPostData = foundry.utils.deepClone(node.data);
      ShitpostManager.isInternalClipboardActive = true;
      const payload = CLONE_PREFIX + JSON.stringify({
        src: node.data.src,
        type: node.data.type,
        width: node.data.width,
        height: node.data.height
      });
      e.clipboardData?.setData("text/plain", payload);
    }
  }, true);

  window.addEventListener("paste", async (e) => {
    if (isTypingInInput() || !canvas?.ready) return;

    const pos = ShitpostManager.getMouseCanvasPos();
    const clipboard = e.clipboardData;
    const text = clipboard?.getData("text/plain")?.trim() || "";
    if (!clipboard) return;

    if (text.startsWith(CLONE_PREFIX)) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const cloneData = JSON.parse(text.slice(CLONE_PREFIX.length));
        await ShitpostManager.addPost({
          src: cloneData.src,
          type: cloneData.type,
          x: pos.x,
          y: pos.y,
          width: cloneData.width,
          height: cloneData.height
        });
        return;
      } catch (err) {
        console.warn("Scene Shitposts | Ошибка чтения клона из буфера:", err);
      }
    }

    // «Копировать картинку» в браузере и Discord кладёт в буфер только первый кадр гифки (PNG),
    // а рядом — HTML с исходной ссылкой. По ссылке анимация сохраняется
    const htmlUrl = extractClipboardHtmlUrl(clipboard);
    if (htmlUrl && MediaUrlResolver.mayBeAnimated(htmlUrl)) {
      e.preventDefault();
      e.stopPropagation();
      ShitpostManager.isInternalClipboardActive = false;
      await ShitpostManager.addPost({ src: htmlUrl, x: pos.x, y: pos.y });
      return;
    }

    if (clipboard?.items) {
      for (const item of clipboard.items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          ShitpostManager.isInternalClipboardActive = false;
          const blob = item.getAsFile();
          if (blob) {
            await ShitpostManager.handleRawImageBlob(blob, pos);
            return;
          }
        }
      }
    }

    const linkMatch = text.match(/^https?:\/\/\S+/i);
    if (linkMatch) {
      e.preventDefault();
      e.stopPropagation();
      ShitpostManager.isInternalClipboardActive = false;
      await ShitpostManager.addPost({
        src: linkMatch[0],
        x: pos.x,
        y: pos.y
      });
      return;
    }

    if (ShitpostManager.isInternalClipboardActive && ShitpostManager.copiedPostData) {
      e.preventDefault();
      e.stopPropagation();
      const clone = ShitpostManager.copiedPostData;
      await ShitpostManager.addPost({
        src: clone.src,
        type: clone.type,
        x: pos.x,
        y: pos.y,
        width: clone.width,
        height: clone.height
      });
    }
  }, true);
});

Hooks.on("canvasReady", () => {
  if (canvas.shitpostLayer) {
    canvas.shitpostLayer.destroy({ children: true });
  }
  const layer = new ShitpostLayer();
  canvas.shitpostLayer = layer;

  if (canvas.interface) {
    canvas.interface.addChild(layer);
  } else {
    canvas.stage.addChild(layer);
  }

  layer.syncPosts();
});

Hooks.on("canvasTearDown", () => {
  if (canvas.shitpostLayer) {
    canvas.shitpostLayer.destroy({ children: true });
    canvas.shitpostLayer = null;
  }
});

Hooks.on("updateScene", (scene, change) => {
  if (scene.id !== canvas.scene?.id) return;
  if (foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) {
    canvas.shitpostLayer?.syncPosts();
  }
});