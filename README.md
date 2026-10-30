# Scene Shitposts

Модуль для Foundry VTT (v13–v14): игроки вставляют на сцену картинки, скриншоты, GIF и MP4/WebM, как в Owlbear Rodeo.

## Установка

Foundry → Add-on Modules → Install Module → поле «Manifest URL»:

```
https://github.com/arlekyin/scene-shitposts/releases/latest/download/module.json
```

## Использование

- `Ctrl+V` над холстом — вставить ссылку, скриншот или скопированную картинку в позицию курсора.
- Поддерживаются прямые ссылки на файлы, вложения и прокси-ссылки Discord, страницы Giphy, Tenor, Klipy и Imgur (`.gifv`).
- Перетаскивание — переместить, угловые маркеры — изменить размер (`Shift` — сохранить пропорции).
- `Ctrl+C` / `Ctrl+V` — копия выделенного поста, `Delete` — удалить.
- Игроки щитпостят наравне с ГМом и могут двигать и удалять любые посты. Их изменения сохраняет ГМ, поэтому он должен быть в игре.

## Как загружаются картинки

Настройка мира «Сохранять внешние картинки на сервер» (включена по умолчанию) скачивает вставленные по ссылке файлы в `worlds/<мир>/shitposts`. Так они грузятся у всех игроков с сервера Foundry и не пропадают, когда истекает ссылка Discord.

Некоторые сайты (страницы Tenor, Klipy и многие другие) запрещают браузеру скачивать свои файлы. Такие картинки модуль всё равно показывает, но обычным HTML-элементом поверх холста:

- они рисуются поверх токенов и освещения;
- они не сохраняются на сервер, поэтому со временем ссылка может перестать работать;
- ссылку на страницу (а не на сам файл) так показать не получится — скопируйте прямую ссылку на гифку (ПКМ → «Копировать адрес изображения»).

Чтобы такие файлы тоже сохранялись на сервер, ГМ может указать CORS-прокси в настройке «CORS-прокси для внешних ссылок». Это необязательно.

## Сцены и производительность

- Посты принадлежат своей сцене. Пока сцена не открыта, её картинки не скачиваются и не занимают память.
- При уходе со сцены анимации сразу встают на паузу, а через 10 секунд файлы выгружаются из памяти. Если вернуться раньше, сцена появляется мгновенно.
- Гифки и видео, которых не видно на экране (или когда окно свёрнуто), стоят на паузе. Посты с одним и тем же файлом используют одну общую текстуру.
- При открытии сцены первыми грузятся посты, которые видны на экране, остальные подгружаются следом.
- Каждый игрок хранит файлы щитпостов у себя в браузере (настройка клиента «Локальный кеш щитпостов, МБ», по умолчанию 500 МБ). Повторный заход на сцену, в том числе после перезапуска игры, не скачивает их с сервера заново. Когда кеш превышает лимит, удаляются самые давно не использованные файлы; 0 отключает кеш и очищает его.

## Свой CORS-прокси на Cloudflare (бесплатно, ~5 минут)

1. Зарегистрируйтесь на [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages → Create → Create Worker**, задайте имя (например, `shitposts-proxy`) и нажмите **Deploy**.
3. **Edit code**, замените код на приведённый ниже и снова нажмите **Deploy**.
4. Скопируйте адрес воркера вида `https://shitposts-proxy.<аккаунт>.workers.dev` и вставьте его в настройку модуля «CORS-прокси для внешних ссылок».

Прокси отдаёт только картинки и видео до 30 МБ, а HTML — только со страниц Tenor, Klipy, Imgur и Giphy (из них модуль достаёт ссылку на файл). Бесплатного тарифа Cloudflare (100 000 запросов в сутки) хватает с запасом: через прокси файл скачивается один раз, дальше все грузят его с сервера Foundry.

```js
// Cloudflare Worker: CORS-прокси для модуля Scene Shitposts
const MAX_BYTES = 30 * 1024 * 1024;
const PAGE_HOSTS = /(^|\.)(tenor\.com|klipy\.com|imgur\.com|giphy\.com)$/i;
const CORS = { "Access-Control-Allow-Origin": "*" };

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
    }

    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get("url"));
    } catch {
      return new Response("Нужен параметр ?url=", { status: 400, headers: CORS });
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return new Response("Неверная ссылка", { status: 400, headers: CORS });
    }

    const upstream = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (scene-shitposts proxy)" },
      redirect: "follow"
    });
    const type = upstream.headers.get("content-type") || "";
    const isMedia = /^(image|video)\//i.test(type);
    const isPage = /^text\/html/i.test(type) && PAGE_HOSTS.test(target.hostname);
    if (!upstream.ok || !(isMedia || isPage)) {
      return new Response("Недопустимый ответ", { status: 403, headers: CORS });
    }
    if (Number(upstream.headers.get("content-length")) > MAX_BYTES) {
      return new Response("Файл слишком большой", { status: 413, headers: CORS });
    }

    return new Response(upstream.body, {
      headers: { ...CORS, "Content-Type": type, "Cache-Control": "public, max-age=86400" }
    });
  }
};
```
