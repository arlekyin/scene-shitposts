const MODULE_ID = "scene-shitposts";
const SOCKET_NAME = `module.${MODULE_ID}`;
const CLONE_PREFIX = "SHITPOST_CLONE::";

/**
 * Утилита для превращения любых ссылок (Discord Attachments, Discord Proxy, Klipy, Tenor) в прямые рабочие медиа-файлы
 */
class MediaUrlResolver {
  static async resolve(rawUrl) {
    let url = rawUrl.trim();

    // 1. Обработка вложений Discord (media.discordapp.net/attachments/... -> cdn.discordapp.com/attachments/...)
    // На cdn.discordapp.com открыт CORS (Access-Control-Allow-Origin: *) и отдаётся оригинал без сжатия
    if (/^https?:\/\/media\.discordapp\.net\/attachments\//i.test(url)) {
      try {
        const parsed = new URL(url);
        parsed.hostname = "cdn.discordapp.com";
        // Удаляем параметры ресайза прокси Дискорда, которые ломают анимацию и подпись
        parsed.searchParams.delete("width");
        parsed.searchParams.delete("height");
        parsed.searchParams.delete("format");
        parsed.searchParams.delete("quality");
        parsed.searchParams.delete(""); // убирает висящий "&=" в конце ссылок Дискорда
        url = parsed.toString();
      } catch (e) {
        url = url.replace(/^https?:\/\/media\.discordapp\.net/i, "https://cdn.discordapp.com");
      }
    }

    // 2. Вытаскиваем прямую ссылку из внешнего прокси Дискорда (images-ext-1.discordapp.net/external/.../https/...)
    const discordProxyMatch = url.match(/discordapp\.net\/external\/[^/]+\/(https?)\/(.+)$/i);
    if (discordProxyMatch) {
      const protocol = discordProxyMatch[1].toLowerCase();
      let cleanPath = discordProxyMatch[2];
      url = `${protocol}://${cleanPath}`;
    }

    // 3. Определяем тип по расширению файла в пути URL
    if (/\.(mp4|webm|mov)(\?.*)?$/i.test(url)) {
      return { src: url, type: "video" };
    }
    if (/\.gif(\?.*)?$/i.test(url)) {
      return { src: url, type: "gif" };
    }
    if (/\.(png|jpg|jpeg|webp|avif|svg)(\?.*)?$/i.test(url)) {
      return { src: url, type: "image" };
    }

    // 4. Если это ссылка на веб-страницу (например, klipy.com/gifs/..., tenor.com/view/..., giphy.com/...)
    try {
      const resolved = await this._scrapeOpenGraphMedia(url);
      if (resolved) return resolved;
    } catch (e) {
      console.warn("Scene Shitposts | Не удалось распарсить страницу напрямую:", e);
    }

    return { src: url, type: "image" };
  }

  static async _scrapeOpenGraphMedia(pageUrl) {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(pageUrl)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) return null;
    const data = await response.json();
    const html = data.contents;
    if (!html) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const ogVideo =
      doc.querySelector('meta[property="og:video:secure_url"]')?.content ||
      doc.querySelector('meta[property="og:video:url"]')?.content ||
      doc.querySelector('meta[property="og:video"]')?.content;

    if (ogVideo && /\.(mp4|webm)(\?.*)?$/i.test(ogVideo)) {
      return { src: ogVideo, type: "video" };
    }

    const ogImage =
      doc.querySelector('meta[property="og:image:secure_url"]')?.content ||
      doc.querySelector('meta[property="og:image"]')?.content ||
      doc.querySelector('meta[name="twitter:image"]')?.content;

    if (ogImage) {
      if (/\.(mp4|webm)(\?.*)?$/i.test(ogImage)) return { src: ogImage, type: "video" };
      if (/\.gif(\?.*)?$/i.test(ogImage)) return { src: ogImage, type: "gif" };
      return { src: ogImage, type: "image" };
    }

    return null;
  }

  /**
   * Скачивает бинарные данные картинки/гифки с умным обходом CORS
   */
  static async fetchMediaBuffer(src) {
    // Попытка 1: Прямой запрос (работает для cdn.discordapp.com, tenor, giphy и локальных файлов)
    try {
      const res = await fetch(src, { mode: "cors", credentials: "omit" });
      if (res.ok) {
        return {
          buffer: await res.arrayBuffer(),
          contentType: res.headers.get("content-type") || "image/gif"
        };
      }
    } catch {
      // Переходим к запасному прокси
    }

    // Попытка 2: Через резервные CORS-прокси (правильно кодируя URL со всеми амперсандами)
    const proxies = [
      `https://corsproxy.io/?url=${encodeURIComponent(src)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(src)}`
    ];

    for (const proxyUrl of proxies) {
      try {
        const res = await fetch(proxyUrl);
        if (res.ok) {
          return {
            buffer: await res.arrayBuffer(),
            contentType: res.headers.get("content-type") || "image/gif"
          };
        }
      } catch {
        // Пробуем следующий прокси
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
    this.gifTimer = null;
    this.gifFrames = [];

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

  async _loadMedia() {
    const resolved = await MediaUrlResolver.resolve(this.data.src);
    if (this.destroyed) return;

    const src = resolved.src;
    const type = resolved.type;

    if (type === "video") {
      await this._loadVideoMedia(src);
    } else if (type === "gif") {
      await this._loadAnimatedGif(src);
    } else {
      await this._loadStaticImage(src);
    }
  }

  async _loadVideoMedia(src) {
    try {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = src;

      this.videoElement = video;

      await new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          video.removeEventListener("loadeddata", onReady);
          video.removeEventListener("canplay", onReady);
          video.removeEventListener("error", onError);
        };
        video.addEventListener("loadeddata", onReady, { once: true });
        video.addEventListener("canplay", onReady, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.load();
      });

      if (this.destroyed) return;

      const tex = PIXI.Texture.from(video, {
        resourceOptions: { autoPlay: true, updateFPS: 0 }
      });

      if (tex.baseTexture?.resource) {
        tex.baseTexture.resource.autoUpdate = true;
      }

      this.mediaSprite.texture = tex;
      this.mediaSprite.visible = true;
      this.loadingSpinner.visible = false;

      this._applyInitialDimensions(video.videoWidth || 300, video.videoHeight || 300);
      await video.play();
    } catch (err) {
      console.error("Scene Shitposts | Ошибка загрузки видео:", src, err);
      this._showErrorState();
    }
  }

  async _loadAnimatedGif(src) {
    try {
      const { buffer, contentType } = await MediaUrlResolver.fetchMediaBuffer(src);
      if (this.destroyed) return;

      // Определяем реальный MIME-тип (иногда файл называется .gif, но внутри лежат байты PNG/WebP или наоборот)
      const mime = this._detectMimeFromBytes(buffer) || contentType.split(";")[0].trim() || "image/gif";

      // 1. Если есть ImageDecoder и это многокадровая анимация (GIF или анимированный WebP)
      if ("ImageDecoder" in window && (mime === "image/gif" || mime === "image/webp")) {
        try {
          const decoder = new ImageDecoder({ data: buffer.slice(0), type: mime });
          await decoder.tracks.ready;
          const frameCount = decoder.tracks.selectedTrack.frameCount;

          if (frameCount > 1) {
            let firstW = 300;
            let firstH = 300;

            for (let i = 0; i < frameCount; i++) {
              if (this.destroyed) return;
              const result = await decoder.decode({ frameIndex: i });
              const frame = result.image;
              if (i === 0) {
                firstW = frame.displayWidth;
                firstH = frame.displayHeight;
              }

              const offCanvas = document.createElement("canvas");
              offCanvas.width = frame.displayWidth;
              offCanvas.height = frame.displayHeight;
              const ctx = offCanvas.getContext("2d");
              ctx.drawImage(frame, 0, 0);

              const durationMs = Math.max(20, (frame.duration || 100000) / 1000);
              this.gifFrames.push({
                texture: PIXI.Texture.from(offCanvas),
                duration: durationMs
              });
              frame.close();
            }

            if (this.destroyed || this.gifFrames.length === 0) return;

            this.mediaSprite.texture = this.gifFrames[0].texture;
            this.mediaSprite.visible = true;
            this.loadingSpinner.visible = false;
            this._applyInitialDimensions(firstW, firstH);

            let currentFrame = 0;
            const playNextFrame = () => {
              if (this.destroyed || this.gifFrames.length === 0) return;
              this.mediaSprite.texture = this.gifFrames[currentFrame].texture;
              const delay = this.gifFrames[currentFrame].duration;
              currentFrame = (currentFrame + 1) % this.gifFrames.length;
              this.gifTimer = setTimeout(playNextFrame, delay);
            };
            playNextFrame();
            return;
          }
        } catch (decodeErr) {
          console.warn("Scene Shitposts | ImageDecoder не смог декодировать как многокадровый, открываем как статику:", decodeErr);
        }
      }

      // 2. Если это статичный (1-кадровый) .gif или картинка с расширением .gif —
      // создаём текстуру напрямую из уже скачанного буфера (Blob URL), чтобы не зависеть от CORS!
      await this._loadFromBuffer(buffer, mime);
    } catch (err) {
      console.warn("Scene Shitposts | Fallback на прямую загрузку для:", src, err);
      await this._loadStaticImage(src);
    }
  }

  _detectMimeFromBytes(buffer) {
    const arr = new Uint8Array(buffer).subarray(0, 12);
    if (arr.length < 4) return null;
    // GIF87a / GIF89a: 47 49 46 38
    if (arr[0] === 0x47 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x38) return "image/gif";
    // PNG: 89 50 4E 47
    if (arr[0] === 0x89 && arr[1] === 0x50 && arr[2] === 0x4e && arr[3] === 0x47) return "image/png";
    // JPEG: FF D8 FF
    if (arr[0] === 0xff && arr[1] === 0xd8 && arr[2] === 0xff) return "image/jpeg";
    // WEBP: RIFF....WEBP
    if (
      arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46 &&
      arr[8] === 0x57 && arr[9] === 0x45 && arr[10] === 0x42 && arr[11] === 0x50
    ) {
      return "image/webp";
    }
    return null;
  }

  async _loadFromBuffer(buffer, mime) {
    const blob = new Blob([buffer], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = objectUrl;
      });
      if (this.destroyed) return;
      const tex = PIXI.Texture.from(img);
      this.mediaSprite.texture = tex;
      this.mediaSprite.visible = true;
      this.loadingSpinner.visible = false;
      this._applyInitialDimensions(img.naturalWidth || 300, img.naturalHeight || 300);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async _loadStaticImage(src) {
    try {
      // Сначала пробуем скачать буфер (чтобы обойти возможный CORS на внешних хостингах)
      const { buffer, contentType } = await MediaUrlResolver.fetchMediaBuffer(src);
      if (this.destroyed) return;
      const mime = this._detectMimeFromBytes(buffer) || contentType.split(";")[0].trim() || "image/png";
      await this._loadFromBuffer(buffer, mime);
    } catch {
      // Если совсем не вышло через fetch, пробуем нативный загрузчик Foundry
      try {
        const loadTex = foundry?.canvas?.loadTexture || loadTexture;
        let tex = await loadTex(src);
        if (this.destroyed || !tex) return;

        this.mediaSprite.texture = tex;
        this.mediaSprite.visible = true;
        this.loadingSpinner.visible = false;
        this._applyInitialDimensions(tex.width || 300, tex.height || 300);
      } catch (err) {
        console.error("Scene Shitposts | Не удалось загрузить изображение:", src, err);
        this._showErrorState();
      }
    }
  }

  _showErrorState() {
    if (this.destroyed) return;
    this.loadingSpinner.clear();
    this.loadingSpinner.beginFill(0x550000, 0.7);
    this.loadingSpinner.lineStyle(2, 0xff4444, 1);
    this.loadingSpinner.drawRoundedRect(-60, -60, 120, 120, 12);
    this.loadingSpinner.endFill();
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
      ShitpostManager.updatePost({
        id: this.data.id,
        width: this.data.width,
        height: this.data.height
      });
    }
    this.refreshVisuals();
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
      this._loadMedia();
    } else if (!this.isDragging && !this.isResizing) {
      this.refreshVisuals();
    }
  }

  _cleanupMedia() {
    if (this.gifTimer) {
      clearTimeout(this.gifTimer);
      this.gifTimer = null;
    }
    if (this.gifFrames.length > 0) {
      for (const frame of this.gifFrames) {
        frame.texture.destroy(true);
      }
      this.gifFrames = [];
    }
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.removeAttribute("src");
      this.videoElement.load();
      this.videoElement = null;
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

    const resolved = postData.type
      ? { src: postData.src, type: postData.type }
      : await MediaUrlResolver.resolve(postData.src);

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

    if (game.user.isGM) {
      await this._gmAddPost(canvas.scene.id, newPost);
    } else {
      game.socket.emit(SOCKET_NAME, { action: "ADD_POST", sceneId: canvas.scene.id, post: newPost });
    }
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
      const dirPath = `worlds/${game.world.id}/shitposts`;

      const file = new File([finalBlob], fileName, { type: finalBlob.type });

      if (game.user.isGM || game.user.can("FILES_UPLOAD")) {
        await this._ensureDirectory(dirPath);
        const PickerClass = foundry?.applications?.apps?.FilePicker?.implementation || FilePicker;
        const response = await PickerClass.upload("data", dirPath, file, {}, { notify: false });
        if (response?.path) {
          await this.addPost({ src: response.path, type: isGif ? "gif" : "image", x: spawnPos.x, y: spawnPos.y });
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
    const PickerClass = foundry?.applications?.apps?.FilePicker?.implementation || FilePicker;
    try {
      await PickerClass.createDirectory("data", dirPath, {});
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

Hooks.once("ready", () => {
  game.socket.on(SOCKET_NAME, async (payload) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    if (payload.action === "ADD_POST") {
      await ShitpostManager._gmAddPost(payload.sceneId, payload.post);
    } else if (payload.action === "UPDATE_POST") {
      await ShitpostManager._gmUpdatePost(payload.sceneId, payload.update);
    } else if (payload.action === "DELETE_POST") {
      await ShitpostManager._gmDeletePost(payload.sceneId, payload.postId);
    } else if (payload.action === "UPLOAD_AND_SPAWN") {
      const res = await fetch(payload.base64);
      const blob = await res.blob();
      const dirPath = `worlds/${game.world.id}/shitposts`;
      await ShitpostManager._ensureDirectory(dirPath);
      const file = new File([blob], payload.fileName, { type: payload.mimeType || "image/webp" });
      const PickerClass = foundry?.applications?.apps?.FilePicker?.implementation || FilePicker;
      const uploadRes = await PickerClass.upload("data", dirPath, file, {}, { notify: false });
      if (uploadRes?.path) {
        await ShitpostManager._gmAddPost(payload.sceneId, {
          id: foundry.utils.randomID(),
          src: uploadRes.path,
          type: payload.fileName.endsWith(".gif") ? "gif" : "image",
          x: payload.x,
          y: payload.y,
          width: null,
          height: null,
          authorId: payload.authorId
        });
      }
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

    if (text && /^https?:\/\/\S+/i.test(text)) {
      e.preventDefault();
      e.stopPropagation();
      ShitpostManager.isInternalClipboardActive = false;
      await ShitpostManager.addPost({
        src: text,
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