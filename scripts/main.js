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
// Максимальная сторона текстуры: при загрузке картинки и кадры анимаций уменьшаются до неё
const MAX_STATIC_SIZE = 2048;
const MAX_ANIMATION_SIZE = 640;
// Сколько держать файл в памяти после того, как его перестали показывать (например, при переходе между сценами)
const MEDIA_RELEASE_DELAY = 10_000;
// Как часто проверять, видны ли анимации на экране
const MEDIA_WATCH_INTERVAL = 250;
const PROXY_TIMEOUT = 15_000;
// Ошибка загрузки свежего поста показывается автору, старые посты не спамят уведомлениями
const FRESH_POST_MS = 60_000;

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
  },
  /**
   * Возвращает объект обновления, который удаляет поле документа по пути path.
   * v14 — оператор ForcedDeletion, v13 — синтаксис "-=key"
   */
  deletion(path) {
    const ForcedDeletion = foundry.data?.operators?.ForcedDeletion;
    if (ForcedDeletion) return { [path]: new ForcedDeletion() };
    const dot = path.lastIndexOf(".");
    return { [`${path.slice(0, dot)}.-=${path.slice(dot + 1)}`]: null };
  }
};

/**
 * Файл нельзя скачать в браузере (хостинг без CORS и нет прокси). Такой пост показывается HTML-элементом поверх холста
 */
class BlockedMediaError extends Error {}

/**
 * Адрес CORS-прокси из настроек мира для ссылки url или null, если прокси не настроен
 */
function getProxyUrl(url) {
  let template = "";
  try {
    template = String(game.settings.get(MODULE_ID, "corsProxy") ?? "").trim();
  } catch {
    // Настройки ещё не зарегистрированы
  }
  if (!template) return null;
  const encoded = encodeURIComponent(url);
  if (template.includes("{url}")) return template.replace("{url}", encoded);
  return `${template}${template.includes("?") ? "&" : "?"}url=${encoded}`;
}

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

    // Ссылка на файл этого же сервера Foundry: храним относительный путь, иначе игроки,
    // которые подключаются по другому адресу (IP, домен), получат localhost
    if (parsed.origin === globalThis.window?.location?.origin) {
      let path = parsed.pathname.replace(/^\/+/, "");
      const prefix = globalThis.game?.data?.options?.routePrefix;
      if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
      return path + parsed.search;
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
    // Буфер нужен, чтобы resolve() и загрузка на холст не качали файл дважды; дольше держать его незачем,
    // повторные заходы на сцену обслуживает локальный кеш
    promise.then(
      () => setTimeout(() => this._bufferCache.delete(src), MEDIA_RELEASE_DELAY),
      () => this._bufferCache.delete(src)
    );
    return promise;
  }

  static async _downloadBuffer(src) {
    const read = async (res) => ({
      buffer: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") || ""
    });

    // Файлы щитпостов мира сначала ищем в локальном кеше браузера
    const cacheKey = PersistentCache.keyFor(src);
    if (cacheKey) {
      const hit = await PersistentCache.get(cacheKey);
      if (hit) return hit;
    }

    // Попытка 1: Прямой запрос (работает для файлов мира, cdn.discordapp.com, media.giphy.com и других хостингов с CORS)
    try {
      const res = await fetch(src, { mode: "cors", credentials: this.isRemote(src) ? "omit" : "same-origin" });
      if (res.ok) {
        const result = await read(res);
        if (cacheKey) PersistentCache.put(cacheKey, result.buffer, result.contentType);
        return result;
      }
    } catch {
      // Переходим к прокси
    }

    // Попытка 2: Через CORS-прокси из настроек мира, если он задан
    const proxyUrl = this.isRemote(src) ? getProxyUrl(src) : null;
    if (proxyUrl) {
      try {
        const res = await fetch(proxyUrl, { credentials: "omit", signal: AbortSignal.timeout(PROXY_TIMEOUT) });
        if (res.ok) return await read(res);
      } catch {
        // Прокси недоступен
      }
    }

    throw new Error(`Не удалось скачать ресурс: ${src}`);
  }
}

/**
 * Загружает файл и превращает его в текстуру PIXI. Возвращает объект media:
 * { texture, width, height, setActive(active), destroy() }
 */
class MediaLoader {
  static async load(src, type) {
    const remote = MediaUrlResolver.isRemote(src);

    // Видео из папки щитпостов берём через локальный кеш целиком, остальные видео браузер подгружает потоком
    if (type === "video" && PersistentCache.keyFor(src)) {
      try {
        const res = await MediaUrlResolver.fetchMediaBuffer(src);
        const mime = sniffMedia(res.buffer)?.mime || res.contentType.split(";")[0].trim() || "video/mp4";
        return await this._videoFromBuffer(res.buffer, mime);
      } catch (err) {
        console.warn("Scene Shitposts | Видео из кеша не открылось, грузим напрямую:", src, err);
      }
    }

    if (type === "video") {
      try {
        return await this._video(src, remote);
      } catch (err) {
        if (!remote) throw err;
        // Хостинг без CORS: WebGL не может взять кадры такого видео, поэтому скачиваем его целиком и играем из Blob
        let res;
        try {
          res = await MediaUrlResolver.fetchMediaBuffer(src);
        } catch {
          throw new BlockedMediaError(src);
        }
        const mime = sniffMedia(res.buffer)?.mime || res.contentType.split(";")[0].trim() || "video/mp4";
        return this._videoFromBuffer(res.buffer, mime);
      }
    }

    let res;
    try {
      res = await MediaUrlResolver.fetchMediaBuffer(src);
    } catch {
      if (remote) throw new BlockedMediaError(src);
      return this._viaFoundry(src);
    }
    const mime = sniffMedia(res.buffer)?.mime || res.contentType.split(";")[0].trim() || "image/png";

    // Ссылка с расширением .gif, внутри которой на самом деле MP4/WebM
    if (mime.startsWith("video/")) return this._videoFromBuffer(res.buffer, mime);
    if (mime === "text/html") throw new Error(`По ссылке веб-страница, а не файл: ${src}`);

    try {
      const animated = await this._animated(res.buffer, mime);
      if (animated) return animated;
    } catch (err) {
      console.warn("Scene Shitposts | ImageDecoder не смог декодировать анимацию, открываем как статику:", src, err);
    }
    return this._static(res.buffer, mime);
  }

  static async _viaFoundry(src) {
    const texture = await Compat.loadTexture(src);
    if (!texture) throw new Error(`Foundry не смог загрузить текстуру: ${src}`);
    // Текстуры из кеша Foundry общие, их не уничтожаем
    return { texture, width: texture.width, height: texture.height, setActive() {}, destroy() {} };
  }

  static async _static(buffer, mime) {
    const blob = new Blob([buffer], { type: mime });
    let source;
    let width;
    let height;

    if (mime === "image/svg+xml") {
      // createImageBitmap не принимает SVG
      const url = URL.createObjectURL(blob);
      try {
        source = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("SVG не загрузился"));
          image.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      width = source.naturalWidth || 300;
      height = source.naturalHeight || 300;
    } else {
      // createImageBitmap декодирует картинку сразу, в отличие от img.decode() не ждёт отрисовки страницы
      source = await createImageBitmap(blob);
      width = source.width;
      height = source.height;
      const scale = Math.min(1, MAX_STATIC_SIZE / Math.max(width, height));
      if (scale < 1) {
        source.close();
        source = await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(width * scale)),
          resizeHeight: Math.max(1, Math.round(height * scale)),
          resizeQuality: "high"
        });
      }
    }

    const texture = PIXI.Texture.from(source);
    return {
      texture,
      width,
      height,
      setActive() {},
      destroy() {
        texture.destroy(true);
        source.close?.();
      }
    };
  }

  /**
   * Анимированный GIF / WebP / APNG / AVIF. Кадры декодируются по одному и сразу превращаются
   * в уменьшенный ImageBitmap (это делается вне главного потока), который загружается в текстуру напрямую.
   * Возвращает null, если файл не анимирован или браузер не умеет его декодировать.
   */
  static async _animated(buffer, mime) {
    if (!ANIMATABLE_MIMES.has(mime) || typeof ImageDecoder === "undefined") return null;
    if (!(await ImageDecoder.isTypeSupported(mime))) return null;

    const decoder = new ImageDecoder({ data: buffer, type: mime });
    try {
      await decoder.tracks.ready;
      // Количество кадров окончательное только после разбора всего файла
      await decoder.completed;
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
      if (frameCount < 2) {
        decoder.close();
        return null;
      }

      const first = (await decoder.decode({ frameIndex: 0 })).image;
      const width = first.displayWidth;
      const height = first.displayHeight;
      const scale = Math.min(1, MAX_ANIMATION_SIZE / Math.max(width, height));
      const resize = scale < 1
        ? {
          resizeWidth: Math.max(1, Math.round(width * scale)),
          resizeHeight: Math.max(1, Math.round(height * scale)),
          resizeQuality: "medium"
        }
        : {};
      // ImageDecoder отдаёт уже собранные полные кадры, поэтому каждый кадр просто заменяет предыдущий
      const toBitmap = async (frame) => {
        try {
          return await createImageBitmap(frame, resize);
        } finally {
          frame.close();
        }
      };

      const texture = PIXI.Texture.from(await toBitmap(first));
      const resource = texture.baseTexture.resource;
      let frameIndex = 0;
      let timer = null;
      let running = false;
      let active = false;
      let closed = false;

      const schedule = (delay) => {
        if (timer || running || !active || closed) return;
        timer = setTimeout(tick, delay);
      };
      const tick = async () => {
        timer = null;
        if (!active || closed) return;
        running = true;
        const started = performance.now();
        let delay = 100;
        try {
          frameIndex = (frameIndex + 1) % frameCount;
          const frame = (await decoder.decode({ frameIndex })).image;
          delay = frameDelay(frame);
          const bitmap = await toBitmap(frame);
          if (closed) {
            bitmap.close();
            return;
          }
          const previous = resource.source;
          resource.source = bitmap;
          texture.baseTexture.update();
          previous?.close?.();
        } catch (err) {
          if (!closed) console.warn("Scene Shitposts | Ошибка декодирования кадра:", err);
        } finally {
          running = false;
        }
        schedule(Math.max(0, delay - (performance.now() - started)));
      };

      return {
        texture,
        width,
        height,
        // Анимация крутится, только пока её видно на экране
        setActive(value) {
          active = value;
          if (!active) {
            clearTimeout(timer);
            timer = null;
          }
          schedule(0);
        },
        destroy() {
          closed = true;
          clearTimeout(timer);
          try {
            decoder.close();
          } catch {
            // Декодер уже закрыт
          }
          resource.source?.close?.();
          texture.destroy(true);
        }
      };
    } catch (err) {
      decoder.close();
      throw err;
    }
  }

  static async _videoFromBuffer(buffer, mime) {
    const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
    try {
      return await this._video(url, false, url);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  static async _video(url, useCors, objectUrl = null) {
    const video = document.createElement("video");
    if (useCors) video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    await waitForMedia(video, "loadeddata");

    const texture = PIXI.Texture.from(video, {
      resourceOptions: { autoPlay: true, updateFPS: 0 }
    });
    if (texture.baseTexture?.resource) {
      texture.baseTexture.resource.autoUpdate = true;
    }
    return {
      texture,
      width: video.videoWidth || 300,
      height: video.videoHeight || 300,
      setActive(value) {
        if (value && video.paused) {
          // Отказ автозапуска не ошибка загрузки: первый кадр уже на холсте
          video.play().catch(err => console.warn("Scene Shitposts | Браузер не дал запустить видео:", err));
        } else if (!value && !video.paused) {
          video.pause();
        }
      },
      destroy() {
        video.pause();
        video.removeAttribute("src");
        video.load();
        texture.destroy(true);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };
  }
}

/**
 * Постоянный кеш файлов щитпостов в IndexedDB браузера. Файлы из worlds/<мир>/shitposts создаёт модуль
 * под уникальными именами и не меняет, поэтому повторно их можно не скачивать даже после перезапуска игры.
 * IndexedDB, в отличие от Cache Storage, работает и без HTTPS (игроки часто заходят по http://IP).
 * Старые файлы вытесняются, когда кеш превышает лимит из настроек клиента.
 */
const PersistentCache = {
  DB_NAME: `${MODULE_ID}-cache`,
  _db: null,
  _trimTimer: null,

  limitBytes() {
    try {
      return Math.max(0, Number(game.settings.get(MODULE_ID, "localCacheMB")) || 0) * 1024 * 1024;
    } catch {
      return 0;
    }
  },

  /**
   * Ключ кеша для src или null, если файл не кешируется
   */
  keyFor(src) {
    if (typeof indexedDB === "undefined" || !globalThis.game?.world || !this.limitBytes()) return null;
    if (MediaUrlResolver.isRemote(src)) return null;
    const path = MediaUrlResolver.normalize(src).split(/[?#]/)[0];
    return path.startsWith(`worlds/${game.world.id}/shitposts/`) ? path : null;
  },

  _open() {
    this._db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("files");
        // Размер и время последнего использования лежат отдельно, чтобы считать объём, не читая сами файлы
        db.createObjectStore("meta").createIndex("lastUsed", "lastUsed");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(err => {
      this._db = null;
      throw err;
    });
    return this._db;
  },

  async get(key) {
    try {
      const db = await this._open();
      const tx = db.transaction(["files", "meta"], "readwrite");
      const file = await requestResult(tx.objectStore("files").get(key));
      if (!file) return null;
      tx.objectStore("meta").put({ size: file.buffer.byteLength, lastUsed: Date.now() }, key);
      return { buffer: file.buffer, contentType: file.contentType };
    } catch (err) {
      console.warn("Scene Shitposts | Локальный кеш недоступен:", err);
      return null;
    }
  },

  async put(key, buffer, contentType) {
    if (buffer.byteLength > this.limitBytes()) return;
    try {
      const db = await this._open();
      const tx = db.transaction(["files", "meta"], "readwrite");
      tx.objectStore("files").put({ buffer, contentType }, key);
      tx.objectStore("meta").put({ size: buffer.byteLength, lastUsed: Date.now() }, key);
      await transactionDone(tx);
      // Вытеснение одно на пачку записей, а не на каждый файл
      clearTimeout(this._trimTimer);
      this._trimTimer = setTimeout(() => this.trim(), 2000);
    } catch (err) {
      console.warn("Scene Shitposts | Не удалось сохранить файл в локальный кеш:", err);
    }
  },

  /**
   * Удаляет давно не использованные файлы, пока кеш не уложится в лимит
   */
  async trim() {
    try {
      const limit = this.limitBytes();
      const db = await this._open();
      const tx = db.transaction(["files", "meta"], "readwrite");
      const metaStore = tx.objectStore("meta");
      const entries = [];
      await new Promise((resolve, reject) => {
        const request = metaStore.index("lastUsed").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          entries.push({ key: cursor.primaryKey, size: cursor.value.size });
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (total <= limit) break;
        tx.objectStore("files").delete(entry.key);
        metaStore.delete(entry.key);
        total -= entry.size;
      }
      await transactionDone(tx);
    } catch (err) {
      console.warn("Scene Shitposts | Не удалось очистить локальный кеш:", err);
    }
  },

  async clear() {
    try {
      const db = await this._open();
      const tx = db.transaction(["files", "meta"], "readwrite");
      tx.objectStore("files").clear();
      tx.objectStore("meta").clear();
      await transactionDone(tx);
    } catch (err) {
      console.warn("Scene Shitposts | Не удалось очистить локальный кеш:", err);
    }
  }
};

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Очередь загрузки постов: одновременно грузится несколько файлов, и первыми — те, что видны на экране.
 * Остальные подгружаются следом в фоне, поэтому тяжёлая сцена «оживает» с той части, куда смотрит игрок.
 */
const LoadQueue = {
  MAX_ACTIVE: 4,
  // Запас вокруг экрана в пикселях: посты чуть за краем грузятся вместе с видимыми
  SCREEN_MARGIN: 300,
  pending: new Set(),
  active: 0,
  _scheduled: false,

  enqueue(node) {
    this.pending.add(node);
    this._schedulePump();
  },

  remove(node) {
    this.pending.delete(node);
  },

  _schedulePump() {
    if (this._scheduled) return;
    this._scheduled = true;
    // Ждём, пока syncPosts добавит все узлы на холст: до этого их положение на экране неизвестно
    setTimeout(() => {
      this._scheduled = false;
      this._pump();
    }, 0);
  },

  _pump() {
    while (this.active < this.MAX_ACTIVE && this.pending.size) {
      let next = null;
      for (const node of this.pending) {
        if (node.isOnScreen(this.SCREEN_MARGIN)) {
          next = node;
          break;
        }
      }
      next ??= this.pending.values().next().value;
      this.pending.delete(next);
      if (next.destroyed) continue;
      this.active++;
      next._loadMedia().catch(err => console.error("Scene Shitposts | Ошибка загрузки поста:", err)).finally(() => {
        this.active--;
        this._pump();
      });
    }
  }
};

function frameDelay(frame) {
  // duration в микросекундах. Браузеры показывают кадры с задержкой <= 10 мс как 100 мс, повторяем это поведение
  const ms = (frame.duration ?? 0) / 1000;
  return ms <= 10 ? 100 : ms;
}

/**
 * Ждёт, пока img/video загрузится (eventName) или упадёт с ошибкой
 */
function waitForMedia(element, eventName) {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(element.error ?? new Error(`Файл не загрузился: ${element.src}`));
    };
    const cleanup = () => {
      element.removeEventListener(eventName, onReady);
      element.removeEventListener("error", onError);
    };
    element.addEventListener(eventName, onReady);
    element.addEventListener("error", onError);
    if (element instanceof HTMLVideoElement) element.load();
  });
}

/**
 * Общий кеш медиа: посты с одним и тем же файлом используют одну текстуру, один декодер анимации и один <video>.
 * Анимации и видео ставятся на паузу, когда ни один их пост не виден на экране или окно свёрнуто.
 */
class MediaCache {
  static entries = new Map();
  static _watcher = null;

  static acquire(src, type) {
    let entry = this.entries.get(src);
    if (!entry) {
      entry = { src, refs: 0, nodes: new Set(), media: null, releaseTimer: null };
      entry.promise = MediaLoader.load(src, type).then(media => (entry.media = media));
      // После ошибки следующая попытка загрузит файл заново
      entry.promise.catch(() => {
        if (this.entries.get(src) === entry) this.entries.delete(src);
      });
      this.entries.set(src, entry);
    }
    clearTimeout(entry.releaseTimer);
    entry.refs++;
    this._startWatcher();
    return entry;
  }

  static release(entry) {
    entry.refs--;
    if (entry.refs > 0) return;
    entry.releaseTimer = setTimeout(() => {
      if (entry.refs > 0) return;
      if (this.entries.get(entry.src) === entry) this.entries.delete(entry.src);
      entry.promise.then(media => media.destroy(), () => {});
    }, MEDIA_RELEASE_DELAY);
  }

  static refresh(entry) {
    if (!entry.media) return;
    const watched = !document.hidden && [...entry.nodes].some(node => node.isOnScreen());
    entry.media.setActive(watched);
  }

  static _startWatcher() {
    if (this._watcher) return;
    this._watcher = setInterval(() => {
      for (const entry of this.entries.values()) this.refresh(entry);
    }, MEDIA_WATCH_INTERVAL);
  }
}

/**
 * HTML-слой поверх холста для файлов, которые браузер не даёт загрузить в WebGL (хостинги без CORS).
 * Слой повторяет сдвиг и масштаб холста, а перетаскивание и ресайз обрабатывает обычный узел PIXI под ним.
 */
const DomOverlay = {
  root: null,
  zCounter: 0,
  _lastTransform: "",

  ensure() {
    if (this.root?.isConnected) return this.root;
    const root = document.createElement("div");
    root.id = "scene-shitposts-dom";
    const board = document.getElementById("board");
    if (board) board.after(root);
    else document.body.append(root);
    this.root = root;
    this._lastTransform = "";
    this.sync();
    return root;
  },

  add(element) {
    element.style.zIndex = String(++this.zCounter);
    this.ensure().append(element);
  },

  bringToFront(element) {
    element.style.zIndex = String(++this.zCounter);
  },

  sync() {
    const layer = canvas?.shitpostLayer;
    if (!this.root || !layer || layer.destroyed) return;
    // Считаем матрицу по локальным трансформациям от слоя до корня сцены: worldTransform обновляется
    // только при отрисовке и после сдвига холста может быть ещё старым
    const m = new PIXI.Matrix();
    for (let obj = layer; obj; obj = obj.parent) {
      obj.transform.updateLocalTransform();
      m.prepend(obj.transform.localTransform);
    }
    const transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.tx}, ${m.ty})`;
    if (transform !== this._lastTransform) {
      this.root.style.transform = transform;
      this._lastTransform = transform;
    }
  }
};

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
    this.mediaEntry = null;
    this.domElement = null;
    this.loadToken = 0;
    this.errorNotified = false;

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
    this.refreshVisuals();
    LoadQueue.enqueue(this);
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

  isOnScreen(margin = 0) {
    if (this.destroyed || !this.parent || !this.worldVisible) return false;
    const bounds = this.getBounds();
    const screen = canvas.app.screen;
    return bounds.right > -margin && bounds.bottom > -margin
      && bounds.left < screen.width + margin && bounds.top < screen.height + margin;
  }

  async _loadMedia() {
    const token = ++this.loadToken;
    const { src, type } = await MediaUrlResolver.resolve(this.data.src);
    if (this._isStale(token)) return;

    // Старые посты с type "gif" загружаются как картинки
    const entry = MediaCache.acquire(src, type === "video" ? "video" : "image");
    this.mediaEntry = entry;
    try {
      const media = await entry.promise;
      if (this._isStale(token)) return;
      entry.nodes.add(this);
      this.mediaSprite.texture = media.texture;
      this.mediaSprite.visible = true;
      this.loadingSpinner.visible = false;
      this._applyInitialDimensions(media.width, media.height);
      MediaCache.refresh(entry);
    } catch (err) {
      if (this._isStale(token)) return;
      if (err instanceof BlockedMediaError) {
        this._showDomMedia(src, type, token);
        return;
      }
      console.error("Scene Shitposts | Не удалось загрузить файл:", src, err);
      this._showErrorState(token);
    }
  }

  /**
   * Показывает файл обычным <img>/<video> поверх холста: так браузер покажет картинку с любого сайта
   */
  _showDomMedia(src, type, token) {
    const isVideo = type === "video";
    const element = document.createElement(isVideo ? "video" : "img");
    element.className = "shitpost-dom-media";
    element.draggable = false;
    if (isVideo) {
      element.muted = true;
      element.loop = true;
      element.autoplay = true;
      element.playsInline = true;
    }
    element.src = src;
    this.domElement = element;
    DomOverlay.add(element);
    this.refreshVisuals();

    waitForMedia(element, isVideo ? "loadeddata" : "load").then(
      () => {
        if (this._isStale(token)) return;
        this.loadingSpinner.visible = false;
        const width = isVideo ? element.videoWidth : element.naturalWidth;
        const height = isVideo ? element.videoHeight : element.naturalHeight;
        this._applyInitialDimensions(width || 300, height || 300);
      },
      (err) => {
        if (this._isStale(token)) return;
        console.error("Scene Shitposts | Не удалось загрузить файл:", src, err);
        this._removeDomMedia();
        this._showErrorState(token, true);
      }
    );
  }

  _removeDomMedia() {
    if (!this.domElement) return;
    this.domElement.pause?.();
    this.domElement.removeAttribute("src");
    this.domElement.remove();
    this.domElement = null;
  }

  _showErrorState(token, blocked = false) {
    if (this._isStale(token)) return;
    this.loadingSpinner.clear();
    this.loadingSpinner.beginFill(0x550000, 0.7);
    this.loadingSpinner.lineStyle(2, 0xff4444, 1);
    this.loadingSpinner.drawRoundedRect(-60, -60, 120, 120, 12);
    this.loadingSpinner.endFill();
    this.loadingSpinner.visible = true;

    // Автору свежего поста объясняем, что пошло не так
    const isFresh = Date.now() - (this.data.createdAt ?? 0) < FRESH_POST_MS;
    if (this.data.authorId === game.user.id && isFresh && !this.errorNotified) {
      this.errorNotified = true;
      ui.notifications.warn(blocked
        ? "Scene Shitposts: сайт не отдаёт этот файл. Скопируйте прямую ссылку на картинку (ПКМ → «Копировать адрес изображения») или попросите ГМа настроить CORS-прокси в настройках модуля."
        : "Scene Shitposts: не удалось загрузить картинку по этой ссылке.");
    }
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
    // Область клика: вся картинка (и прозрачные места, и HTML-пост) плюс выступающие ручки
    this.hitArea = new PIXI.Rectangle(-w / 2 - 8, -h / 2 - 8, w + 16, h + 16);

    if (this.domElement) {
      const style = this.domElement.style;
      style.left = `${this.data.x - w / 2}px`;
      style.top = `${this.data.y - h / 2}px`;
      style.width = `${w}px`;
      style.height = `${h}px`;
      style.opacity = String(this.alpha);
      this.domElement.classList.toggle("selected", this.isSelected);
    }

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
    if (selected && this.domElement) DomOverlay.bringToFront(this.domElement);
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
        this.refreshVisuals();
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
      this.refreshVisuals();
    } else if (this.isResizing) {
      const start = this.resizeStart;
      const dx = pos.x - start.mouse.x;
      const dy = pos.y - start.mouse.y;
      // Ручки только угловые: тянем вправо/влево и вниз/вверх, противоположный угол остаётся на месте
      const signX = this.resizeHandle.includes("r") ? 1 : -1;
      const signY = this.resizeHandle.includes("b") ? 1 : -1;
      const minSize = 30;

      let newW = Math.max(minSize, start.w + signX * dx);
      let newH = Math.max(minSize, start.h + signY * dy);

      if (e.shiftKey) {
        // Сохраняем пропорции по той стороне, которую потянули сильнее
        const ratio = start.w / start.h;
        if (Math.abs(newW - start.w) / start.w >= Math.abs(newH - start.h) / start.h) {
          newH = newW / ratio;
        } else {
          newW = newH * ratio;
        }
        if (newW < minSize || newH < minSize) {
          const fix = Math.max(minSize / newW, minSize / newH);
          newW *= fix;
          newH *= fix;
        }
      }

      this.data.width = Math.round(newW);
      this.data.height = Math.round(newH);
      this.data.x = Math.round(start.x + (signX * (newW - start.w)) / 2);
      this.data.y = Math.round(start.y + (signY * (newH - start.h)) / 2);
      this.refreshVisuals();
    }
  }

  onGlobalUp() {
    if (!this.isDragging && !this.isResizing) return;

    this.isDragging = false;
    this.isResizing = false;
    this.resizeHandle = null;
    this.alpha = 1.0;
    this.refreshVisuals();

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
      LoadQueue.enqueue(this);
    } else if (!this.isDragging && !this.isResizing) {
      this.refreshVisuals();
    }
  }

  _cleanupMedia() {
    // Отменяет загрузки, которые ещё не завершились или ждут своей очереди
    this.loadToken++;
    LoadQueue.remove(this);

    // Текстура общая для всех постов с этим файлом: отпускаем её, а уничтожит кеш, когда она никому не нужна
    if (this.mediaSprite && !this.mediaSprite.destroyed) {
      this.mediaSprite.texture = PIXI.Texture.EMPTY;
      this.mediaSprite.visible = false;
    }
    if (this.mediaEntry) {
      this.mediaEntry.nodes.delete(this);
      // Если пост был последним видимым, анимация встаёт на паузу сразу, а не на следующей проверке
      MediaCache.refresh(this.mediaEntry);
      MediaCache.release(this.mediaEntry);
      this.mediaEntry = null;
    }
    this._removeDomMedia();
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

    // HTML-слой подстраивается под сдвиг и масштаб холста после каждой отрисовки
    this._onTick = () => DomOverlay.sync();
    canvas.app?.ticker.add(this._onTick, null, PIXI.UPDATE_PRIORITY.UTILITY);
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
    const posts = PostStore.list(canvas.scene);
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
    canvas?.app?.ticker.remove(this._onTick);
    this.clearAllNodes();
    super.destroy(options);
  }
}

/**
 * Хранение постов в флагах сцены. Каждый пост лежит под своим ключом flags.<модуль>.items.<id>,
 * поэтому одновременные изменения разных постов не затирают друг друга.
 * Старый формат (весь список массивом во flags.<модуль>.posts) переносится при первой записи.
 */
const PostStore = {
  list(scene) {
    const flags = scene?.flags?.[MODULE_ID] ?? {};
    const byId = new Map();
    if (Array.isArray(flags.posts)) {
      flags.posts.forEach((post, index) => {
        if (post?.id) byId.set(post.id, { createdAt: index, ...post });
      });
    }
    for (const [id, post] of Object.entries(flags.items ?? {})) {
      // Обновление, пришедшее после удаления поста, оставляет обрывок без src — его не показываем
      if (post?.src) byId.set(id, { ...post, id });
    }
    return [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  },

  has(scene, id) {
    return Boolean(scene?.flags?.[MODULE_ID]?.items?.[id]?.src);
  },

  itemPath(id) {
    return `flags.${MODULE_ID}.items.${id}`;
  },

  async migrate(scene) {
    const legacy = scene?.flags?.[MODULE_ID]?.posts;
    if (!Array.isArray(legacy)) return;
    const update = Compat.deletion(`flags.${MODULE_ID}.posts`);
    legacy.forEach((post, index) => {
      if (post?.id) update[this.itemPath(post.id)] = { createdAt: index, ...post };
    });
    await scene.update(update);
  }
};

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
    if (!canvas.scene || !this.canReachGM()) return;

    const isFreshLink = !postData.type;
    const resolved = isFreshLink
      ? await MediaUrlResolver.resolve(postData.src)
      : { src: MediaUrlResolver.normalize(postData.src), type: postData.type };

    const newPost = {
      id: foundry.utils.randomID(),
      src: resolved.src,
      type: resolved.type,
      x: postData.x,
      y: postData.y,
      width: postData.width || null,
      height: postData.height || null,
      authorId: game.user.id,
      createdAt: Date.now()
    };

    // Новую внешнюю ссылку сохраняем в папку мира: все клиенты грузят её с сервера Foundry,
    // а протухшие ссылки Discord продолжают работать
    if (isFreshLink && this.shouldCacheRemote(newPost.src)) {
      if (this.canUpload()) {
        const cached = await this.cacheRemoteMedia(newPost.src);
        if (cached) Object.assign(newPost, cached);
      } else {
        this.sendToGM({ action: "CACHE_AND_ADD", sceneId: canvas.scene.id, post: newPost });
        return;
      }
    }

    if (game.user.isGM) {
      await this._gmAddPost(canvas.scene.id, newPost);
    } else {
      this.sendToGM({ action: "ADD_POST", sceneId: canvas.scene.id, post: newPost });
    }
  }

  /**
   * Игроки не могут менять сцену сами, все их изменения записывает активный ГМ.
   * Без ГМа в игре предупреждаем, а не теряем действие молча
   */
  static canReachGM() {
    if (game.user.isGM || game.users.activeGM) return true;
    ui.notifications.warn("Scene Shitposts: в игре нет ГМа. Щитпосты игроков сохраняются через ГМа, попробуйте, когда он зайдёт.");
    return false;
  }

  static sendToGM(payload) {
    if (!this.canReachGM()) return;
    game.socket.emit(SOCKET_NAME, { ...payload, userId: game.user.id });
  }

  /**
   * Показывает уведомление пользователю userId: себе — сразу, другому — через сокет
   */
  static notifyUser(userId, level, message) {
    if (!userId || userId === game.user.id) {
      ui.notifications[level](message);
    } else {
      game.socket.emit(SOCKET_NAME, { action: "NOTIFY", userId, level, message });
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
      this.sendToGM({ action: "UPDATE_POST", sceneId: canvas.scene.id, update: partialData });
    }
  }

  static async deletePost(postId) {
    if (!canvas.scene) return;
    if (game.user.isGM) {
      await this._gmDeletePost(canvas.scene.id, postId);
    } else {
      this.sendToGM({ action: "DELETE_POST", sceneId: canvas.scene.id, postId });
    }
  }

  static async _gmAddPost(sceneId, post) {
    const scene = game.scenes.get(sceneId);
    if (!scene || !post?.id || !post.src) return;
    await PostStore.migrate(scene);
    await scene.update({ [PostStore.itemPath(post.id)]: post });
  }

  static async _gmUpdatePost(sceneId, update) {
    const scene = game.scenes.get(sceneId);
    if (!scene || !update?.id) return;
    await PostStore.migrate(scene);
    // Пост могли удалить, пока его двигали: не воскрешаем его обрывком
    if (!PostStore.has(scene, update.id)) return;
    const { id, ...fields } = update;
    await scene.update({ [PostStore.itemPath(id)]: fields });
  }

  static async _gmDeletePost(sceneId, postId) {
    const scene = game.scenes.get(sceneId);
    if (!scene || !postId) return;
    await PostStore.migrate(scene);
    if (!scene.flags?.[MODULE_ID]?.items?.[postId]) return;
    await scene.update(Compat.deletion(PostStore.itemPath(postId)));
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
        } else {
          ui.notifications.error("Scene Shitposts: сервер Foundry не принял файл. Проверьте права на загрузку файлов.");
        }
      } else {
        if (!this.canReachGM()) return;
        const base64 = await this._blobToBase64(finalBlob);
        this.sendToGM({
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

  game.settings.register(MODULE_ID, "corsProxy", {
    name: "CORS-прокси для внешних ссылок (необязательно)",
    hint: "Адрес прокси, через который модуль скачивает файлы с сайтов, запрещающих прямую загрузку (страницы Tenor, Klipy и др.). {url} в адресе заменяется ссылкой, иначе она добавляется как ?url=. Без прокси такие картинки всё равно показываются, но поверх холста и без сохранения на сервер. Как бесплатно сделать свой прокси — в README модуля.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "localCacheMB", {
    name: "Локальный кеш щитпостов, МБ",
    hint: "Картинки и гифки сцен хранятся в браузере этого игрока, чтобы при возврате на сцену и после перезапуска игры не скачивать их с сервера заново. Самые старые файлы удаляются, когда кеш превышает лимит. 0 — не кешировать и очистить кеш.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 4000, step: 100 },
    default: 500,
    onChange: (value) => {
      if (!Number(value)) PersistentCache.clear();
      else PersistentCache.trim();
    }
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET_NAME, async (payload) => {
    if (payload.action === "NOTIFY") {
      if (payload.userId === game.user.id) ui.notifications[payload.level ?? "info"](payload.message);
      return;
    }
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
        // У игрока нет права загружать файлы: ГМ сам скачивает ссылку и сохраняет её в мир.
        // Если не вышло, пост остаётся внешней ссылкой
        const post = payload.post;
        const cached = await ShitpostManager.cacheRemoteMedia(post.src);
        if (cached) Object.assign(post, cached);
        await ShitpostManager._gmAddPost(payload.sceneId, post);
      } else if (payload.action === "UPLOAD_AND_SPAWN") {
        const res = await fetch(payload.base64);
        const blob = await res.blob();
        const file = new File([blob], payload.fileName, { type: payload.mimeType || "image/webp" });
        const path = await ShitpostManager.uploadToWorld(file);
        if (!path) throw new Error("Сервер Foundry не принял файл");
        await ShitpostManager._gmAddPost(payload.sceneId, {
          id: foundry.utils.randomID(),
          src: path,
          type: "image",
          x: payload.x,
          y: payload.y,
          width: null,
          height: null,
          authorId: payload.authorId,
          createdAt: Date.now()
        });
      }
    } catch (err) {
      console.error(`Scene Shitposts | Ошибка обработки запроса ${payload.action}:`, err);
      ShitpostManager.notifyUser(payload.userId, "error", "Scene Shitposts: ГМ не смог сохранить ваш щитпост, попробуйте ещё раз.");
    }
  });

  // Активный ГМ переводит сцены со старым форматом хранения на новый
  if (game.user.isGM && game.users.activeGM?.isSelf) {
    for (const scene of game.scenes) {
      PostStore.migrate(scene).catch(err => console.warn("Scene Shitposts | Не удалось перенести посты сцены:", scene.name, err));
    }
  }

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

// Сдвиг и зум холста: HTML-слой обновляется сразу, не дожидаясь следующего кадра
Hooks.on("canvasPan", () => DomOverlay.sync());

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